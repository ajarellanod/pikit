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
import { createExecutionGondolin } from "./index.ts";
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
    { name: "execution-gondolin", provides: ["execution", "execution.shell", "workspace"], requires: [], optional: ["secrets"] },
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

test("temporary files and spilled output are under /tmp/pikit, on the host, emptied at the next start", async () => {
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
  expect(existsSync(join(s.root, "tmp", "conversations", "1", spillPath.slice("/tmp/pikit/".length)))).toBe(true);
  expect((await env.createTempDir("../escape-", ctx)).ok).toBe(false);
  await s.app.stop();

  // A new process: what an earlier one left in tmp is gone, the workspace stays.
  writeFileSync(join(s.root, "conversations", "1", "kept.txt"), "kept");
  const again = await defineApp({ components: [createExecutionGondolin(new FakeLauncher())], config: { "execution-gondolin": { root: s.root } }, logger: silentLogger }).create();
  await again.start();
  expect(existsSync(join(s.root, "tmp", "conversations", "1"))).toBe(false);
  expect(existsSync(join(s.root, "conversations", "1", "kept.txt"))).toBe(true);
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
    mounts: { "/workspace": join(s.root, "conversations", "7"), "/tmp/pikit": join(s.root, "tmp", "conversations", "7") },
    allowedHosts: [],
    secrets: [],
    memory: "512M",
    cpus: 1,
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
