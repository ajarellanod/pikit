/**
 * execution-gondolin's tests without QEMU: the VM layer is a fake (`fake-guest.test-support.ts`), so
 * they run anywhere and check what is this component's own: files served from the host, confined to
 * the sandbox; when VMs boot, idle out, are evicted or refused; how a command's output, timeout,
 * cancellation and spill are handled; and how secrets and the network policy reach the VM.
 * `gondolin.test.ts` runs the same environment over real VMs, when QEMU is installed.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationRef } from "@pikit/contracts";
import { type App, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { createWorkspaceConformance } from "@pikit/pi-adapter/testing";
import { doctor } from "./doctor.ts";
import { FakeLauncher } from "./fake-guest.test-support.ts";
import { SandboxCache } from "./cache.ts";
import { gitConfig, proposalsHook } from "./gondolin.ts";
import { PROPOSALS_HOST, PROPOSALS_URL } from "./guest.ts";
import { createExecutionGondolin, holdsWorkingDirectory, IMAGE_DIR, KEEP_SANDBOXES, TMP_DIR } from "./index.ts";
import { qemuBinary, qemuProblem } from "./qemu.ts";

const ctx = BACKGROUND_CONTEXT;
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-execution-gondolin-")));
  directories.push(dir);
  return dir;
}

const ref = (conversationId: string, agent = "support"): ConversationRef => ({ key: `test:${conversationId}`, agent, conversationId });

interface Started {
  app: App;
  launcher: FakeLauncher;
  root: string;
  execution: ExecutionEnv;
  shell: ExecutionEnv;
  workspace: WorkspaceProvider;
  /** The workspace environment of conversation `id`. */
  env(id: string): Promise<ExecutionEnv>;
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
}

/** A started app with the component over `launcher`, its root in a new directory. */
async function started(config: Record<string, unknown> = {}, options: { launcher?: FakeLauncher; providers?: ComponentDefinition[] } = {}): Promise<Started> {
  const launcher = options.launcher ?? new FakeLauncher();
  const root = join(temporaryDir(), "gondolin");
  let found: Pick<Started, "execution" | "shell" | "workspace"> | undefined;
  const reader = defineComponent({
    name: "execution-reader",
    setup(pikit) {
      const execution = pikit.use("execution");
      const shell = pikit.use("execution.shell");
      const workspace = pikit.use("workspace");
      return { start: () => void (found = { execution: execution.get(), shell: shell.get(), workspace: workspace.get() }) };
    },
  });
  const logs: Started["logs"] = [];
  const logger: Logger = {
    debug: () => {},
    info: (message, fields) => void logs.push({ level: "info", message, ...(fields !== undefined && { fields }) }),
    warn: (message, fields) => void logs.push({ level: "warn", message, ...(fields !== undefined && { fields }) }),
    error: (message, fields) => void logs.push({ level: "error", message, ...(fields !== undefined && { fields }) }),
  };
  const app = await defineApp({
    components: [...(options.providers ?? []), createExecutionGondolin(launcher), reader],
    config: { "execution-gondolin": { root, ...config } },
    logger,
  }).create();
  await app.start();
  if (found === undefined) throw new Error("execution was not resolved");
  const workspace = found.workspace;
  return { app, launcher, root, ...found, env: async (id) => (await workspace.resolve(ref(id), app.context())).env, logs };
}

/** A `secrets` provider over a map the test changes. */
function secretsOf(values: Record<string, string | undefined>): ComponentDefinition {
  return defineComponent({
    name: "secrets-test",
    setup(pikit) {
      pikit.provide("secrets", { get: async (name: string) => values[name] });
    },
  });
}

/** Runs `command`, collecting its output by stream. */
async function run(env: ExecutionEnv, command: string | string[], options: Parameters<ExecutionEnv["exec"]>[1] = {}, context = ctx) {
  const output = { stdout: "", stderr: "" };
  const result = await env.exec(command, { ...options, onOutput: (text, c, info) => {
    output[info.stream] += text;
    options?.onOutput?.(text, c, info);
  } }, context);
  return { result, ...output };
}

const until = async (condition: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
};

// pi-durable's ExecutionEnv contract on a conversation's environment, without a VM: every file method,
// and `exec` answering `shell_unavailable` when no VM can boot (the real shell's cases: gondolin.test.ts).
for (const c of createDurableExecutionConformance(async () => {
  const launcher = new FakeLauncher();
  launcher.bootError = new Error("no QEMU here");
  const s = await started({}, { launcher });
  return { env: await s.env("1"), dispose: () => s.app.stop() };
}, { expect, shell: false, watch: false })) {
  test(`execution-gondolin ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

for (const c of createWorkspaceConformance(async () => {
  const s = await started();
  return { provider: s.workspace, dispose: () => s.app.stop() };
})) {
  test(`execution-gondolin ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createLifecycleConformance(() => ({
  component: createExecutionGondolin(new FakeLauncher()),
  config: { "execution-gondolin": { root: join(temporaryDir(), "gondolin") } },
}))) {
  test(`execution-gondolin ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [createExecutionGondolin(new FakeLauncher())], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([
    { name: "execution-gondolin", provides: ["execution", "execution.shell", "workspace"], requires: [], optional: ["secrets", "proposals"] },
  ]);
});

test("a conversation's files are on the host, in its own directory, at /workspace for its tools", async () => {
  const s = await started();
  const one = await s.env("1");
  const two = await s.env("2");

  expect(one.cwd).toBe("/workspace");
  expect(one.id).toBe("execution-gondolin:conversation-1");
  expect(two.id).not.toBe(one.id);
  expect((await one.writeFile("notes/a.txt", "one's", ctx)).ok).toBe(true);
  expect(readFileSync(join(s.root, "conversations", "1", "notes", "a.txt"), "utf8")).toBe("one's");
  expect(await two.exists("notes/a.txt", ctx)).toEqual({ ok: true, value: false });
  expect(await one.canonicalPath("notes/a.txt", ctx)).toEqual({ ok: true, value: "/workspace/notes/a.txt" });
  expect((await one.fileInfo("notes/a.txt", ctx)).ok && (await one.fileInfo("notes/a.txt", ctx))).toMatchObject({ value: { path: "/workspace/notes/a.txt", name: "a.txt" } });
  // `execution` (a tool called outside a conversation) is a sandbox of its own.
  expect(s.execution).toBe(s.shell);
  expect((await s.execution.writeFile("x.txt", "default's", ctx)).ok).toBe(true);
  expect(readFileSync(join(s.root, "default", "x.txt"), "utf8")).toBe("default's");
  // Reading and writing files boots no VM.
  expect(s.launcher.guests).toHaveLength(0);
  await s.app.stop();
});

test("a sandbox is keyed by conversationId alone: the same id under another key or agent is the same sandbox", async () => {
  const s = await started();
  const first = await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "abc" }, s.app.context());
  const again = await s.workspace.resolve({ key: "remote:sandbox", agent: "ops", conversationId: "abc", channel: "http" }, s.app.context());

  expect(again.env).toBe(first.env);
  await s.app.stop();
});

test("a conversation id that is not a safe directory name is refused, and nothing is made", async () => {
  const s = await started();
  for (const id of ["", "..", "a/b", "../escape", "a.b", "x".repeat(129)]) {
    expect(s.workspace.resolve(ref(id), s.app.context())).rejects.toThrow("not a safe directory name");
  }
  expect(existsSync(join(s.root, "escape"))).toBe(false);
  await s.app.stop();
});

test("paths never leave the sandbox: absolute, .., and links the guest made, wherever they point", async () => {
  const s = await started();
  const env = await s.env("1");
  const host = join(s.root, "conversations", "1");
  // The server's own state and another conversation's files, next to this one on the host.
  writeFileSync(join(s.root, "state.db"), "every conversation");
  mkdirSync(join(s.root, "conversations", "2"), { recursive: true });
  writeFileSync(join(s.root, "conversations", "2", "theirs.txt"), "conversation 2's");
  writeFileSync(join(host, "real.txt"), "mine");
  mkdirSync(join(host, "dir"));
  // Links as the guest makes them: targets in the guest's namespace, or host paths it guessed.
  symlinkSync("/etc", join(host, "etc"));
  symlinkSync(join(s.root, "conversations", "2"), join(host, "host-path"));
  symlinkSync("../../2", join(host, "dir", "up"));
  symlinkSync("../..", join(host, "parent"));
  symlinkSync("/workspace/real.txt", join(host, "absolute.txt"));
  symlinkSync("loop-b", join(host, "loop-a"));
  symlinkSync("loop-a", join(host, "loop-b"));

  const code = async (result: Promise<{ ok: boolean; error?: { code: string } } | { ok: true }>) => {
    const done = await result;
    return done.ok ? "ok" : (done as { error: { code: string } }).error.code;
  };
  for (const path of ["/etc/passwd", "../2/theirs.txt", "/workspace/../conversations/2/theirs.txt", "../../state.db", "etc/passwd", "host-path/theirs.txt", "dir/up/theirs.txt", "parent/state.db", s.root + "/state.db"]) {
    expect({ path, code: await code(env.readTextFile(path, ctx)) }).toEqual({ path, code: "permission_denied" });
  }
  // A link inside resolves as in the guest; a loop is refused.
  expect(await env.readTextFile("absolute.txt", ctx)).toEqual({ ok: true, value: "mine" });
  expect(await code(env.readTextFile("loop-a", ctx))).toBe("invalid");
  // Writing through a link that leads out writes nothing out there.
  expect(await code(env.writeFile("host-path/planted.txt", "x", ctx))).toBe("permission_denied");
  expect(await code(env.createDir("parent/planted", undefined, ctx))).toBe("permission_denied");
  expect(await code(env.renameFile("real.txt", "../2/stolen.txt", ctx))).toBe("permission_denied");
  expect(existsSync(join(s.root, "conversations", "2", "planted.txt"))).toBe(false);
  expect(existsSync(join(s.root, "planted"))).toBe(false);
  expect(existsSync(join(s.root, "conversations", "2", "stolen.txt"))).toBe(false);
  // The link itself can be seen and removed: what it points to stays.
  expect(await env.fileInfo("host-path", ctx)).toMatchObject({ ok: true, value: { kind: "symlink", path: "/workspace/host-path" } });
  expect(await code(env.remove("host-path", undefined, ctx))).toBe("ok");
  expect(readFileSync(join(s.root, "conversations", "2", "theirs.txt"), "utf8")).toBe("conversation 2's");
  // Errors speak of guest paths, never of the host's layout.
  const missing = await env.readTextFile("missing.txt", ctx);
  expect(!missing.ok && missing.error.code).toBe("not_found");
  expect(!missing.ok && `${missing.error.message} ${missing.error.path}`).not.toContain(s.root);
  expect(!missing.ok && missing.error.path).toBe("/workspace/missing.txt");
  await s.app.stop();
});

test("temporary files and spilled output are under /tmp/pikit, on the host, in the component's own directory, emptied at the next start; nothing else is", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = () => ({ chunks: Array.from({ length: 6 }, (_, i) => ["stdout", `line-${i}\n`] as ["stdout", string]) });
  const s = await started({}, { launcher });
  const env = await s.env("1");

  const file = await env.createTempFile({ prefix: "p-", suffix: ".log" }, ctx);
  const spilled = await run(env, "many lines", { spill: { afterBytes: 1_000_000, afterLines: 3 } });

  expect(file.ok && file.value.startsWith("/tmp/pikit/p-")).toBe(true);
  expect(spilled.result.ok && spilled.result.value.spillPath?.startsWith("/tmp/pikit/pi-output-")).toBe(true);
  const spillPath = spilled.result.ok ? (spilled.result.value.spillPath as string) : "";
  expect(await env.readTextFile(spillPath, ctx)).toEqual({ ok: true, value: spilled.stdout });
  expect(spilled.stdout).toBe("line-0\nline-1\nline-2\nline-3\nline-4\nline-5\n");
  expect(existsSync(join(s.root, TMP_DIR, "conversations", "1", spillPath.slice("/tmp/pikit/".length)))).toBe(true);
  expect((await env.createTempDir("../escape-", ctx)).ok).toBe(false);
  await s.app.stop();

  // A new process: what an earlier one left in its temporary area is gone; the workspace, and a `tmp`
  // that is not the component's, stay.
  writeFileSync(join(s.root, "conversations", "1", "kept.txt"), "kept");
  mkdirSync(join(s.root, "tmp"));
  writeFileSync(join(s.root, "tmp", "theirs.txt"), "not the component's");
  const again = await defineApp({ components: [createExecutionGondolin(new FakeLauncher())], config: { "execution-gondolin": { root: s.root } }, logger: silentLogger }).create();
  await again.start();
  expect(existsSync(join(s.root, TMP_DIR, "conversations", "1"))).toBe(false);
  expect(existsSync(join(s.root, "conversations", "1", "kept.txt"))).toBe(true);
  expect(readFileSync(join(s.root, "tmp", "theirs.txt"), "utf8")).toBe("not the component's");
  await again.stop();
});

test("the VM boots at the first command, once, with the conversation's directories mounted, and serves the next ones", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = () => ({ chunks: [["stdout", "out"], ["stderr", "err"]], exitCode: 3 });
  const s = await started({ memory: "512M", cpus: 1 }, { launcher });
  const env = await s.env("7");

  const first = await run(env, "echo", { cwd: "sub", env: { A: "1" } });
  const second = await run(env, ["/bin/true", "x"], { inheritEnv: false });

  expect(first).toMatchObject({ result: { ok: true, value: { exitCode: 3 } }, stdout: "out", stderr: "err" });
  expect(second.result.ok).toBe(true);
  expect(launcher.guests).toHaveLength(1);
  const [guest] = launcher.guests;
  expect(guest?.spec).toEqual({
    label: "pikit support 7",
    mounts: { "/workspace": join(s.root, "conversations", "7"), "/tmp/pikit": join(s.root, TMP_DIR, "conversations", "7") },
    allowedHosts: [],
    secrets: [],
    memory: "512M",
    cpus: 1,
    packages: [],
    imageDir: join(s.root, IMAGE_DIR),
  });
  expect(guest?.commands).toEqual([
    { command: "echo", cwd: "/workspace/sub", env: { A: "1" }, inheritEnv: true },
    { command: ["/bin/true", "x"], cwd: "/workspace", env: {}, inheritEnv: false },
  ]);
  // Another conversation gets a VM of its own.
  await run(await s.env("8"), "echo");
  expect(launcher.guests.map((g) => g.spec.mounts["/workspace"])).toEqual([join(s.root, "conversations", "7"), join(s.root, "conversations", "8")]);
  await s.app.stop();
  expect(launcher.live).toHaveLength(0);
});

test("output is decoded per stream across chunk boundaries, and a program that never started is a spawn_error", async () => {
  const launcher = new FakeLauncher();
  const check = new TextEncoder().encode("✓");
  launcher.respond = (command) =>
    command.command === "missing"
      ? { spawnError: "missing: command not found" }
      : { chunks: [["stdout", check.subarray(0, 1)], ["stderr", "e"], ["stdout", check.subarray(1)], ["stdout", "\n"]] };
  const s = await started({}, { launcher });
  const env = await s.env("1");
  const chunks: string[] = [];

  const ok = await run(env, "print", { onOutput: (text, _c, info) => void chunks.push(`${info.stream}:${text}`) });
  const missing = await env.exec("missing", undefined, ctx);

  expect(ok.stdout).toBe("✓\n");
  expect(chunks).toEqual(["stderr:e", "stdout:✓", "stdout:\n"]);
  expect(!missing.ok && missing.error.code).toBe("spawn_error");
  expect((await env.exec([], undefined, ctx)).ok).toBe(false);
  expect(await env.exec("x", { env: { "A=B": "1" } }, ctx)).toMatchObject({ ok: false, error: { code: "spawn_error" } });
  await s.app.stop();
});

test("a timeout, the call's cancellation and a throwing onOutput kill the command", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = () => ({ hang: true, chunks: [["stdout", "started\n"]] });
  const s = await started({}, { launcher });
  const env = await s.env("1");

  const timedOut = await env.exec("sleep", { timeout: 0.05 }, ctx);
  const controller = new AbortController();
  const cancelled = env.exec("sleep", undefined, withAbortSignal(controller.signal, ctx));
  setTimeout(() => controller.abort(), 20);
  const thrown = await env.exec("sleep", { onOutput: () => {
    throw new Error("the callback failed");
  } }, ctx);

  expect(timedOut).toMatchObject({ ok: false, error: { code: "timeout", message: "timeout:0.05" } });
  expect(await cancelled).toMatchObject({ ok: false, error: { code: "aborted" } });
  expect(thrown).toMatchObject({ ok: false, error: { code: "callback_error", message: "the callback failed" } });
  expect(launcher.guests[0]?.kills).toBe(3);
  expect(launcher.guests[0]?.running).toBe(0);
  await s.app.stop();
});

test("cleanup kills the sandbox's running commands; stop closes every VM, and then exec answers shell_unavailable", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = () => ({ hang: true });
  const s = await started({}, { launcher });
  const env = await s.env("1");
  const running = env.exec("sleep", undefined, ctx);
  await until(() => launcher.guests[0]?.running === 1);

  await env.cleanup(ctx);
  expect(await running).toMatchObject({ ok: true, value: { exitCode: 137 } });

  const other = (await s.env("2")).exec("sleep", undefined, ctx);
  await until(() => launcher.guests[1]?.running === 1);
  await s.app.stop();

  expect(launcher.live).toHaveLength(0);
  expect(await other).toMatchObject({ ok: false, error: { code: "unknown" } });
  expect(await env.exec("echo", undefined, ctx)).toMatchObject({ ok: false, error: { code: "shell_unavailable" } });
});

test("an idle VM is closed after idleSeconds, never while a command runs; the next command boots again", async () => {
  const launcher = new FakeLauncher();
  let hang = true;
  launcher.respond = () => (hang ? { hang: true } : { exitCode: 0 });
  const s = await started({ idleSeconds: 0.05 }, { launcher });
  const env = await s.env("1");

  const running = env.exec("long", undefined, ctx);
  await until(() => launcher.guests[0]?.running === 1);
  await Bun.sleep(150);
  expect(launcher.live).toHaveLength(1);
  await env.cleanup(ctx);
  await running;
  await until(() => launcher.live.length === 0);
  expect(s.logs.some((log) => log.message === "execution-gondolin: closing an idle VM")).toBe(true);

  hang = false;
  expect((await env.exec("again", undefined, ctx)).ok).toBe(true);
  expect(launcher.guests).toHaveLength(2);
  expect(launcher.live).toHaveLength(1);
  await s.app.stop();
});

test("at maxVms, a new VM closes the one idle the longest; when all run commands it waits queueSeconds, then fails saying so", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = (command) => (command.command === "hang" ? { hang: true } : { exitCode: 0 });
  const s = await started({ maxVms: 2, queueSeconds: 0.1 }, { launcher });
  const [one, two, three] = [await s.env("1"), await s.env("2"), await s.env("3")];

  await one.exec("quick", undefined, ctx);
  await Bun.sleep(5);
  await two.exec("quick", undefined, ctx);
  await three.exec("quick", undefined, ctx);
  // One's VM was idle the longest: closed for three's.
  expect(launcher.guests.map((g) => [g.spec.label, g.closed])).toEqual([
    ["pikit support 1", true],
    ["pikit support 2", false],
    ["pikit support 3", false],
  ]);

  const hanging = [two.exec("hang", undefined, ctx), three.exec("hang", undefined, ctx)];
  await until(() => launcher.live.every((g) => g.running === 1));
  const refused = await one.exec("quick", undefined, ctx);
  expect(refused).toMatchObject({ ok: false, error: { code: "spawn_error" } });
  expect(!refused.ok && refused.error.message).toContain("all 2 VMs (maxVms) are running commands");

  // Waiting, it gets the VM the first to end leaves idle.
  const waiting = one.exec("quick", undefined, withAbortSignal(new AbortController().signal, ctx));
  await two.cleanup(ctx);
  expect((await waiting).ok).toBe(true);
  await three.cleanup(ctx);
  await Promise.all(hanging);
  expect(launcher.live.length).toBeLessThanOrEqual(2);
  await s.app.stop();
});

test("a VM that fails to boot is not kept: exec answers shell_unavailable, and the next command tries again", async () => {
  const launcher = new FakeLauncher();
  launcher.bootError = new Error("qemu-system-aarch64: failed to start");
  const s = await started({}, { launcher });
  const env = await s.env("1");

  const failed = await env.exec("echo", undefined, ctx);
  launcher.bootError = undefined;
  const worked = await env.exec("echo", undefined, ctx);

  expect(failed).toMatchObject({ ok: false, error: { code: "shell_unavailable" } });
  expect(!failed.ok && failed.error.message).toContain("failed to start");
  expect(worked.ok).toBe(true);
  await s.app.stop();
});

test("a VM that fails under a command is closed: the command fails, and the next one boots a new VM", async () => {
  const launcher = new FakeLauncher();
  let broken = true;
  launcher.respond = () => (broken ? { failed: "the command's VM failed: QEMU exited" } : { exitCode: 0 });
  const s = await started({}, { launcher });
  const env = await s.env("1");

  const failed = await env.exec("echo", undefined, ctx);
  broken = false;
  const worked = await env.exec("echo", undefined, ctx);

  expect(failed).toMatchObject({ ok: false, error: { code: "unknown", message: "the command's VM failed: QEMU exited" } });
  expect(worked.ok).toBe(true);
  expect(launcher.guests.map((guest) => guest.closed)).toEqual([true, false]);
  await s.app.stop();
});

test("a command cancelled while its VM boots returns aborted at once; the boot goes on for the next one", async () => {
  const launcher = new FakeLauncher();
  let open = () => {};
  launcher.bootGate = new Promise((resolve) => (open = resolve));
  const s = await started({}, { launcher });
  const env = await s.env("1");
  const controller = new AbortController();

  const cancelled = env.exec("echo", undefined, withAbortSignal(controller.signal, ctx));
  controller.abort();
  expect(await cancelled).toMatchObject({ ok: false, error: { code: "aborted" } });
  open();
  expect((await env.exec("echo", undefined, ctx)).ok).toBe(true);
  expect(launcher.guests).toHaveLength(1);
  await s.app.stop();
});

test("network: none by default; allowedHosts and the secrets' hosts are what the VM may reach", async () => {
  const plain = await started({}, {});
  await (await plain.env("1")).exec("echo", undefined, ctx);
  expect(plain.launcher.guests[0]?.spec.allowedHosts).toEqual([]);
  await plain.app.stop();

  const values: Record<string, string | undefined> = { GITHUB_TOKEN: "ghp_real-value-1" };
  const s = await started(
    { allowedHosts: ["registry.npmjs.org", "api.github.com"], secrets: [{ name: "GITHUB_TOKEN", hosts: ["api.github.com", "uploads.github.com"] }] },
    { providers: [secretsOf(values)] },
  );
  await (await s.env("1")).exec("echo", undefined, ctx);
  expect(s.launcher.guests[0]?.spec.allowedHosts).toEqual(["registry.npmjs.org", "api.github.com", "uploads.github.com"]);
  await s.app.stop();
});

test("secrets: read through `secrets` at boot and at each command, given to the VM with their hosts, never logged", async () => {
  const values: Record<string, string | undefined> = { GITHUB_TOKEN: "ghp_real-value-1" };
  const s = await started({ secrets: [{ name: "GITHUB_TOKEN", hosts: ["api.github.com"] }, { name: "NPM_TOKEN", hosts: ["registry.npmjs.org"] }] }, { providers: [secretsOf(values)] });
  const env = await s.env("1");

  await env.exec("first", undefined, ctx);
  values.GITHUB_TOKEN = "ghp_rotated-value-2";
  await env.exec("second", undefined, ctx);

  const guest = s.launcher.guests[0];
  // NPM_TOKEN is not set: left out of this VM, with a warning that names it and holds no value.
  expect(guest?.spec.secrets).toEqual([{ name: "GITHUB_TOKEN", hosts: ["api.github.com"], value: "ghp_real-value-1" }]);
  expect(guest?.refreshes).toEqual([
    { GITHUB_TOKEN: "ghp_real-value-1", NPM_TOKEN: undefined },
    { GITHUB_TOKEN: "ghp_rotated-value-2", NPM_TOKEN: undefined },
  ]);
  expect(s.logs).toContainEqual({ level: "warn", message: "execution-gondolin: secrets not set, left out of this VM until its next boot", fields: { sandbox: "conversation-1", secrets: ["NPM_TOKEN"] } });
  // Commands get no secret through their variables: only the VM's placeholders carry them.
  expect(guest?.commands.map((c) => c.env)).toEqual([{}, {}]);
  expect(JSON.stringify(s.logs)).not.toContain("value-");
  await s.app.stop();
});

test("start refuses when secrets are configured without a secrets provider, or when no VM can boot here; it warns when VMs are slow", async () => {
  const failure = async (config: Record<string, unknown>, launcher = new FakeLauncher()) => {
    const app = await defineApp({
      components: [createExecutionGondolin(launcher)],
      config: { "execution-gondolin": { root: join(temporaryDir(), "gondolin"), ...config } },
      logger: silentLogger,
    }).create();
    return app.start().then(
      () => "started",
      (error: unknown) => `${(error as Error).message}: ${String(((error as Error).cause as Error | undefined)?.message)}`,
    );
  };
  const noQemu = new FakeLauncher();
  noQemu.problem = "qemu-system-aarch64 is not on PATH";

  expect(await failure({ secrets: [{ name: "GITHUB_TOKEN", hosts: ["api.github.com"] }] })).toContain("no `secrets` provider is installed");
  expect(await failure({}, noQemu)).toContain("qemu-system-aarch64 is not on PATH");

  const slow = new FakeLauncher();
  slow.slow = "/dev/kvm is missing";
  const s = await started({}, { launcher: slow });
  expect(s.logs).toContainEqual({ level: "warn", message: "execution-gondolin: /dev/kvm is missing" });
  await s.app.stop();
});

test("doctor: a problem when QEMU or qemu-img is not on PATH, and nothing to say when both are", async () => {
  expect(qemuProblem(() => null)).toContain(`${qemuBinary()} and qemu-img not on PATH`);
  expect(qemuProblem((binary) => (binary === "qemu-img" ? null : "/usr/bin/qemu"))).toStartWith("qemu-img not on PATH");
  expect(qemuProblem(() => "/usr/bin/qemu")).toBeUndefined();
  const result = await doctor({ config: {}, get: () => undefined });
  expect(result.problems).toEqual(qemuProblem() === undefined ? [] : [qemuProblem() as string]);
});

test("the sandbox cache keeps at most `keep` idle entries, dropping the least recently used, and never one that is not idle", () => {
  const busy = new Set(["b0", "b1"]);
  const cache = new SandboxCache<string>(3, (id) => !busy.has(id));
  const made: string[] = [];
  const get = (id: string) => cache.get(id, () => (made.push(id), id));

  for (const id of ["b0", "b1", "a", "b", "c", "d", "e"]) get(id);
  // a to d were dropped, oldest first; b0 and b1, though oldest, are not idle and stay.
  expect(cache.size).toBe(3);
  for (const id of ["b0", "b1", "e", "d"]) get(id);
  expect(made).toEqual(["b0", "b1", "a", "b", "c", "d", "e", "d"]);
  // When more than `keep` are not idle, all of them stay: the cache never drops one in use.
  for (const id of ["b2", "b3", "b4"]) busy.add(id);
  for (const id of ["b2", "b3", "b4"]) get(id);
  expect(cache.size).toBe(5);
});

test("conversations' sandboxes are bounded: idle ones are dropped and rebuilt with their files; one with a VM is kept", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = (command) => (command.command === "hang" ? { hang: true } : { exitCode: 0 });
  const s = await started({}, { launcher });
  const busy = await s.env("busy");
  const running = busy.exec("hang", undefined, ctx);
  await until(() => launcher.guests[0]?.running === 1);
  const first = await s.env("first");
  expect((await first.writeFile("kept.txt", "first's", ctx)).ok).toBe(true);
  // A VM that idles out (no command running) leaves its entry droppable too.
  await (await s.env("ran")).exec("quick", undefined, ctx);

  for (let i = 0; i < KEEP_SANDBOXES * 3; i++) await s.env(`c${i}`);

  const again = await s.env("first");
  expect(again).not.toBe(first);
  expect(await again.readTextFile("kept.txt", ctx)).toEqual({ ok: true, value: "first's" });
  // The conversation running a command keeps its sandbox (and so its one VM).
  expect(await s.env("busy")).toBe(busy);
  await busy.cleanup(ctx);
  await running;
  expect(launcher.guests.filter((guest) => guest.spec.label === "pikit support busy")).toHaveLength(1);
  await s.app.stop();
});

test("start refuses a root that is the working directory, holds it, or is /", async () => {
  const cwd = process.cwd();
  for (const root of [".", cwd, join(cwd, ".."), "/"]) {
    const app = await defineApp({ components: [createExecutionGondolin(new FakeLauncher())], config: { "execution-gondolin": { root } }, logger: silentLogger }).create();
    const error = await app.start().then(
      () => undefined,
      (thrown: unknown) => String(((thrown as Error).cause as Error | undefined)?.message),
    );
    expect({ root, error }).toEqual({ root, error: expect.stringContaining("is the working directory, holds it, or is /") });
  }
  expect(holdsWorkingDirectory("/srv", "/srv/app")).toBe(true);
  expect(holdsWorkingDirectory("/srv/app/.pikit/gondolin", "/srv/app")).toBe(false);
  expect(holdsWorkingDirectory("/srv/ap", "/srv/app")).toBe(false);
});

/** A `proposals` whose remote is `remote()`'s, read at each call; nothing else is asked. */
function proposalsOf(remote: () => unknown): ComponentDefinition {
  return defineComponent({ name: "proposals-test", setup: (pikit) => pikit.provide("proposals", { remote: async () => remote() } as never) });
}

test("packages: none by default; with proposals, git comes first, then the configured ones, each once; the image is kept under root", async () => {
  const plain = await started({ packages: ["make"] });
  await run(await plain.env("1"), "true");
  expect(plain.launcher.guests[0]?.spec).toMatchObject({ packages: ["make"], imageDir: join(plain.root, IMAGE_DIR) });
  expect(plain.launcher.guests[0]?.spec.proposals).toBeUndefined();
  await plain.app.stop();

  const s = await started({ packages: ["make", "git"] }, { providers: [proposalsOf(() => undefined)] });
  await run(await s.env("1"), "true");
  await run(s.execution, "true");
  for (const guest of s.launcher.guests) expect(guest.spec.packages).toEqual(["git", "make"]);
  expect(s.launcher.guests.map((guest) => guest.spec.proposals !== undefined)).toEqual([true, true]);
  await s.app.stop();
});

test("packages are Alpine names: anything that could be read as an option or a command is refused at start", async () => {
  for (const name of ["--allow-untrusted", "git; rm -rf /", "Git", ""]) {
    await expect(started({ packages: [name] })).rejects.toThrow();
  }
});

test("the guest's proposals: a path remote is read at each use; anything else, or none, is none", async () => {
  const serve = async () => new Response("served");
  let remote: unknown;
  const s = await started({}, { providers: [proposalsOf(() => remote)] });
  await run(await s.env("1"), "true");
  const proposals = s.launcher.guests[0]?.spec.proposals;
  expect(await proposals?.remote()).toBeUndefined();
  remote = { kind: "path", path: "/srv/self/project.git", mainBranch: "main", branchPrefix: "pikit/self/", serve };
  expect(await proposals?.remote()).toEqual({ path: "/srv/self/project.git", serve });
  remote = { kind: "https", url: "https://github.com/acme/app.git", mainBranch: "main", branchPrefix: "pikit/self/", authorization: async () => undefined };
  expect(await proposals?.remote()).toBeUndefined();
  await s.app.stop();
});

test("the guest's git config: an identity, the workspace as its own, and the repository's file:// URL rewritten to the host only the guest has", () => {
  expect(gitConfig(undefined)).toBe("[user]\n\tname = pikit agent\n\temail = agent@pikit.invalid\n[safe]\n\tdirectory = *\n");
  expect(gitConfig('/app/.pikit/self/pro"ject.git')).toEndWith(`[url "${PROPOSALS_URL}"]\n\tinsteadOf = "file:///app/.pikit/self/pro\\"ject.git"\n`);
  expect(PROPOSALS_URL).toBe(`http://${PROPOSALS_HOST}/project.git`);
});

test("the guest's requests to the proposals host are answered in the host by serve; others are Gondolin's to judge; none yet is 503", async () => {
  const seen: string[] = [];
  let remote: { path: string; serve(request: Request): Promise<Response> } | undefined;
  const hook = proposalsHook({ remote: async () => remote });
  expect((await hook(new Request(`${PROPOSALS_URL}/info/refs?service=git-upload-pack`)))?.status).toBe(503);
  remote = { path: "/srv/self/project.git", serve: async (request) => (seen.push(request.url), new Response("from serve")) };
  expect(await (await hook(new Request(`${PROPOSALS_URL}/info/refs?service=git-upload-pack`)))?.text()).toBe("from serve");
  expect(await hook(new Request("https://example.com/project.git/info/refs"))).toBeUndefined();
  expect(await hook(new Request(`https://${PROPOSALS_HOST}.example.com/x`))).toBeUndefined();
  expect(seen).toEqual([`${PROPOSALS_URL}/info/refs?service=git-upload-pack`]);
});

test("what the file tools change on the host, the next command sees: its directories up to the mount are synced first, once", async () => {
  const s = await started();
  const env = await s.env("1");
  await run(env, "true");
  const guest = s.launcher.guests[0];
  expect(guest?.syncs).toEqual([]);

  expect((await env.writeFile("project/src/new.ts", "new\n", ctx)).ok).toBe(true);
  expect((await env.createDir("project/docs", { recursive: true }, ctx)).ok).toBe(true);
  expect((await env.renameFile("project/src/new.ts", "project/docs/new.ts", ctx)).ok).toBe(true);
  // A refused change (outside the sandbox) notes nothing.
  expect((await env.writeFile("/etc/passwd", "x", ctx)).ok).toBe(false);
  await run(env, "git add -A");
  expect(guest?.syncs).toEqual([["/workspace", "/workspace/project", "/workspace/project/docs", "/workspace/project/docs/new.ts", "/workspace/project/src", "/workspace/project/src/new.ts"]]);

  // Nothing changed since: nothing to sync. Reading changes nothing.
  await env.readTextFile("project/docs/new.ts", ctx);
  await run(env, "git status");
  expect(guest?.syncs).toHaveLength(1);
  expect((await env.remove("project/docs", { recursive: true }, ctx)).ok).toBe(true);
  await run(env, "ls");
  expect(guest?.syncs[1]).toEqual(["/workspace", "/workspace/project", "/workspace/project/docs"]);
  await s.app.stop();
});
