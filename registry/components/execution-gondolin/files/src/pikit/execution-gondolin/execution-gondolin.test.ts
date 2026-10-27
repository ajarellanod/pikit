/**
 * execution-gondolin's tests without QEMU: the VM layer is a fake (`fake-guest.test-support.ts`), so
 * they run anywhere and check what is this component's own: files served from the host, confined to
 * the sandbox; when VMs boot, idle out, are evicted or refused; how a command's output, timeout,
 * cancellation and spill are handled; and how secrets and the network policy reach the VM.
 * `gondolin.test.ts` runs the same environment over real VMs, when QEMU is installed.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpHooks, type SecretManager } from "@earendil-works/gondolin";
import type { ConversationRef } from "@pikit/contracts";
import { type App, type Clock, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger, systemClock } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { createWorkspaceConformance } from "@pikit/pi-adapter/testing";
import { doctor } from "./doctor.ts";
import { FakeLauncher } from "./fake-guest.test-support.ts";
import { SandboxCache } from "./cache.ts";
import { GondolinGuest, gitConfig, imageFile, proposalsHook, staleImages } from "./gondolin.ts";
import { type GuestSpec, PROPOSALS_HOST, PROPOSALS_URL } from "./guest.ts";
import { createExecutionGondolin, holdsWorkingDirectory, IMAGE_DIR, KEEP_SANDBOXES, PROFILE_WARNING, TMP_DIR, USED_DIR } from "./index.ts";
import { qemuBinary, qemuProblem } from "./qemu.ts";
import { DAY, Retention } from "./retention.ts";

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

/** A conversation `conversationId` of `agent` in chat `test:<conversationId>` (one chat each). */
const ref = (conversationId: string, agent = "support"): ConversationRef => ({ key: `test:${conversationId}`, agent, conversationId });
/** The directory of chat `test:<id>`, computed here (hex SHA-256 of the key), not by the component. */
const chat = (id: string, key = `test:${id}`) => new Bun.CryptoHasher("sha256").update(key).digest("hex");
/** Where the sandbox of chat `test:<id>` and `agent` is under root. */
const dir = (id: string, agent = "support") => join("chats", chat(id), agent);
/** The label of that sandbox's VM. */
const label = (id: string, agent = "support") => `pikit ${agent} ${chat(id).slice(0, 12)}`;

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
async function started(
  config: Record<string, unknown> = {},
  options: { launcher?: FakeLauncher; providers?: ComponentDefinition[]; clock?: Clock; root?: string } = {},
): Promise<Started> {
  const launcher = options.launcher ?? new FakeLauncher();
  const root = options.root ?? join(temporaryDir(), "gondolin");
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
    debug: (message, fields) => void logs.push({ level: "debug", message, ...(fields !== undefined && { fields }) }),
    info: (message, fields) => void logs.push({ level: "info", message, ...(fields !== undefined && { fields }) }),
    warn: (message, fields) => void logs.push({ level: "warn", message, ...(fields !== undefined && { fields }) }),
    error: (message, fields) => void logs.push({ level: "error", message, ...(fields !== undefined && { fields }) }),
  };
  const app = await defineApp({
    components: [...(options.providers ?? []), createExecutionGondolin(launcher), reader],
    config: { "execution-gondolin": { root, ...config } },
    logger,
    ...(options.clock !== undefined && { clock: options.clock }),
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
    { name: "execution-gondolin", provides: ["execution", "execution.shell", "workspace"], requires: [], optional: ["secrets", "proposals", "agent.definition"] },
  ]);
});

test("a conversation's files are on the host, in its own directory, at /workspace for its tools", async () => {
  const s = await started();
  const one = await s.env("1");
  const two = await s.env("2");

  expect(one.cwd).toBe("/workspace");
  expect(one.id).toBe(`execution-gondolin:${dir("1")}`);
  expect(two.id).not.toBe(one.id);
  expect((await one.writeFile("notes/a.txt", "one's", ctx)).ok).toBe(true);
  expect(readFileSync(join(s.root, dir("1"), "notes", "a.txt"), "utf8")).toBe("one's");
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

test("a sandbox is keyed by chat (the origin's key) and agent: conversationId and channel do not choose it; another agent of the chat gets its own directory and VM", async () => {
  const s = await started();
  const first = await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "abc" }, s.app.context());
  const again = await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "other-id", channel: "http" }, s.app.context());
  const developer = await s.workspace.resolve({ key: "telegram:1", agent: "developer", conversationId: "abc" }, s.app.context());

  expect(again.env).toBe(first.env);
  expect(developer.env).not.toBe(first.env);
  const tg = chat("", "telegram:1");
  expect(developer.env.id).toBe(`execution-gondolin:chats/${tg}/developer`);
  expect((await developer.env.writeFile("mine.txt", "developer's", ctx)).ok).toBe(true);
  expect(readFileSync(join(s.root, "chats", tg, "developer", "mine.txt"), "utf8")).toBe("developer's");
  expect(await first.env.exists("mine.txt", ctx)).toEqual({ ok: true, value: false });
  await run(first.env, "true");
  await run(developer.env, "true");
  expect(s.launcher.guests.map((guest) => [guest.spec.label, guest.spec.mounts["/workspace"], guest.spec.mounts["/tmp/pikit"]])).toEqual([
    [`pikit support ${tg.slice(0, 12)}`, join(s.root, "chats", tg, "support"), join(s.root, TMP_DIR, "chats", tg, "support")],
    [`pikit developer ${tg.slice(0, 12)}`, join(s.root, "chats", tg, "developer"), join(s.root, TMP_DIR, "chats", tg, "developer")],
  ]);
  expect(s.launcher.live).toHaveLength(2);
  await s.app.stop();
});

test("a reset (/new: a new conversationId under the same key) finds the agent's files of that chat again; another chat does not", async () => {
  const s = await started();
  const before = (await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1" }, s.app.context())).env;
  expect((await before.writeFile("notes.md", "what my past self wrote", ctx)).ok).toBe(true);
  await run(before, "true");

  const after = (await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "2" }, s.app.context())).env;
  const elsewhere = (await s.workspace.resolve({ key: "telegram:2", agent: "support", conversationId: "3" }, s.app.context())).env;

  expect(await after.readTextFile("notes.md", ctx)).toEqual({ ok: true, value: "what my past self wrote" });
  await run(after, "true");
  // The same VM serves it: one sandbox for the chat and agent.
  expect(s.launcher.guests).toHaveLength(1);
  expect(await elsewhere.exists("notes.md", ctx)).toEqual({ ok: true, value: false });
  expect(elsewhere.id).not.toBe(after.id);
  await s.app.stop();
});

test("a delegated child of the same agent works in its parent's sandbox of the chat; a child of another agent in that agent's own of the chat", async () => {
  const s = await started();
  const origin = { key: "gchat:spaces/AAA", agent: "developer", conversationId: "1", channel: "google-chat" };
  const parent = (await s.workspace.resolve(origin, s.app.context())).env;
  await parent.writeFile("plan.md", "# Plan", ctx);

  const same = (await s.workspace.resolve({ key: "delegate:1:developer:t-1", agent: "developer", conversationId: "2", channel: "delegate", origin }, s.app.context())).env;
  // A grandchild: its origin is still the chat's.
  const deeper = (await s.workspace.resolve({ key: "delegate:2:developer.developer:t-2", agent: "developer", conversationId: "3", channel: "delegate", origin }, s.app.context())).env;
  const analyst = (await s.workspace.resolve({ key: "delegate:1:developer:t-3", agent: "analyst", conversationId: "4", channel: "delegate", origin }, s.app.context())).env;
  // The analyst of that chat, resolved from its own conversation there: the same as the delegated one.
  const analystThere = (await s.workspace.resolve({ key: "gchat:spaces/AAA", agent: "analyst", conversationId: "5" }, s.app.context())).env;
  // A child of the same agent from another chat: that chat's.
  const otherChat = (await s.workspace.resolve({ key: "delegate:1:developer:t-1", agent: "developer", conversationId: "6", channel: "delegate", origin: { ...origin, key: "gchat:spaces/BBB" } }, s.app.context())).env;

  expect(same).toBe(parent);
  expect(deeper).toBe(parent);
  expect(await same.readTextFile("plan.md", ctx)).toEqual({ ok: true, value: "# Plan" });
  expect(analyst).not.toBe(parent);
  expect(analystThere).toBe(analyst);
  expect(analyst.id).toBe(`execution-gondolin:chats/${chat("", "gchat:spaces/AAA")}/analyst`);
  expect(await analyst.exists("plan.md", ctx)).toEqual({ ok: true, value: false });
  expect(await otherChat.exists("plan.md", ctx)).toEqual({ ok: true, value: false });
  // The child's own key chooses nothing.
  expect(existsSync(join(s.root, "chats", chat("", "delegate:1:developer:t-1")))).toBe(false);
  await s.app.stop();
});

test("workspace: \"agent\" (the base's or a profile's) gives the agent one sandbox for every chat, at agents/<agent>; the others stay per chat", async () => {
  const s = await started({ agents: { librarian: { workspace: "agent" }, developer: { cpus: 1 } } });
  const one = (await s.workspace.resolve({ key: "telegram:1", agent: "librarian", conversationId: "1" }, s.app.context())).env;
  const two = (await s.workspace.resolve({ key: "telegram:2", agent: "librarian", conversationId: "2" }, s.app.context())).env;
  await one.writeFile("index.md", "everything", ctx);
  await run(one, "true");
  await run(two, "true");

  expect(two).toBe(one);
  expect(one.id).toBe("execution-gondolin:agents/librarian");
  expect(readFileSync(join(s.root, "agents", "librarian", "index.md"), "utf8")).toBe("everything");
  expect(s.launcher.guests.map((guest) => [guest.spec.label, guest.spec.mounts["/workspace"], guest.spec.mounts["/tmp/pikit"]])).toEqual([
    ["pikit librarian", join(s.root, "agents", "librarian"), join(s.root, TMP_DIR, "agents", "librarian")],
  ]);
  // A profile without `workspace` (and an agent with none) takes the base's: per chat.
  const developer = (await s.workspace.resolve({ key: "telegram:1", agent: "developer", conversationId: "1" }, s.app.context())).env;
  expect(developer.id).toBe(`execution-gondolin:chats/${chat("", "telegram:1")}/developer`);
  await s.app.stop();

  // On the base: every agent shares across chats, unless its profile says `chat`.
  const shared = await started({ workspace: "agent", agents: { support: { workspace: "chat" } } });
  const a = (await shared.workspace.resolve({ key: "telegram:1", agent: "ops", conversationId: "1" }, shared.app.context())).env;
  const b = (await shared.workspace.resolve({ key: "telegram:2", agent: "ops", conversationId: "2" }, shared.app.context())).env;
  const support = (await shared.workspace.resolve(ref("9"), shared.app.context())).env;
  expect(b).toBe(a);
  expect(a.id).toBe("execution-gondolin:agents/ops");
  expect(support.id).toBe(`execution-gondolin:${dir("9")}`);
  await shared.app.stop();
});

test("an agent that is not a safe directory name, or a chat with no key, is refused, and nothing is made", async () => {
  const s = await started();
  // The agent names a directory: anything that is not one lowercase name is refused, before anything
  // is made (`Developer` and `developer` would share one on a case-insensitive filesystem).
  for (const agent of ["", "..", "a/b", "../escape", "a.b", "x".repeat(129), "Developer", "_Sandbox"]) {
    await expect(s.workspace.resolve(ref("ok", agent), s.app.context())).rejects.toThrow("is not a safe directory name");
  }
  // A chat must have a key: the conversation's own, or its origin's.
  await expect(s.workspace.resolve({ key: "", agent: "support", conversationId: "1" }, s.app.context())).rejects.toThrow("a sandbox needs a non-empty key");
  await expect(s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1", origin: { key: "", agent: "support", conversationId: "0" } }, s.app.context())).rejects.toThrow("a sandbox needs a non-empty key");
  // Any other key is a safe name once hashed: `..` and `/` in it make no path.
  const odd = (await s.workspace.resolve({ key: "../../escape/..", agent: "support", conversationId: "1" }, s.app.context())).env;
  expect(odd.id).toBe(`execution-gondolin:chats/${chat("", "../../escape/..")}/support`);
  expect(existsSync(join(s.root, "..", "escape"))).toBe(false);
  expect(readdirSync(join(s.root, "chats"))).toEqual([chat("", "../../escape/..")]);
  expect(existsSync(join(s.root, "agents"))).toBe(false);
  await s.app.stop();
});

test("a sandbox with a link (or a file) on the way from root is refused, naming it: nothing is mounted or made through it", async () => {
  const outside = temporaryDir();
  writeFileSync(join(outside, "keep.txt"), "the host's");
  const s = await started({ agents: { librarian: { workspace: "agent" }, keeper: { workspace: "agent" } } });
  // A guest whose /workspace was chats/<chat>/ (another layout) left `developer -> outside`.
  mkdirSync(join(s.root, "chats", chat("1")), { recursive: true });
  symlinkSync(outside, join(s.root, dir("1", "developer")));
  // A chat's directory itself a link, a link in the temporary area, a file.
  symlinkSync(outside, join(s.root, "chats", chat("2")));
  mkdirSync(join(s.root, TMP_DIR, "chats", chat("3")), { recursive: true });
  symlinkSync(outside, join(s.root, TMP_DIR, dir("3")));
  writeFileSync(join(s.root, "chats", chat("4")), "");
  // The shared layout: an agent's directory a link, and `agents` of the temporary area a file.
  mkdirSync(join(s.root, "agents"));
  symlinkSync(outside, join(s.root, "agents", "librarian"));
  mkdirSync(join(s.root, TMP_DIR), { recursive: true });
  writeFileSync(join(s.root, TMP_DIR, "agents"), "");
  const refusal = (id: string, agent: string, path: string) =>
    `execution-gondolin: the sandbox of agent "${agent}" in chat "test:${id}" is refused: ${path} (under root) is a symbolic link or a file`;
  const shared = (agent: string, path: string) =>
    `execution-gondolin: the sandbox of agent "${agent}" (one for every chat) is refused: ${path} (under root) is a symbolic link or a file`;

  await expect(s.workspace.resolve(ref("1", "developer"), s.app.context())).rejects.toThrow(refusal("1", "developer", dir("1", "developer")));
  await expect(s.workspace.resolve(ref("2", "support"), s.app.context())).rejects.toThrow(refusal("2", "support", `chats/${chat("2")}`));
  await expect(s.workspace.resolve(ref("3", "support"), s.app.context())).rejects.toThrow(refusal("3", "support", `${TMP_DIR}/${dir("3")}`));
  await expect(s.workspace.resolve(ref("4", "support"), s.app.context())).rejects.toThrow(refusal("4", "support", `chats/${chat("4")}`));
  // Checked in the temporary area first, then the workspace.
  await expect(s.workspace.resolve(ref("5", "librarian"), s.app.context())).rejects.toThrow(shared("librarian", `${TMP_DIR}/agents`));
  rmSync(join(s.root, TMP_DIR, "agents"));
  await expect(s.workspace.resolve(ref("5", "librarian"), s.app.context())).rejects.toThrow(shared("librarian", "agents/librarian"));
  // Refused at every resolve, not only the first (the sandbox is cached).
  await expect(s.workspace.resolve(ref("1", "developer"), s.app.context())).rejects.toThrow(refusal("1", "developer", dir("1", "developer")));
  expect(readdirSync(outside)).toEqual(["keep.txt"]);
  expect(s.launcher.guests).toHaveLength(0);

  // Another agent of the same chat, another shared agent: real directories, they work.
  const { env } = await s.workspace.resolve(ref("1", "support"), s.app.context());
  expect((await env.writeFile("a.txt", "support's", ctx)).ok).toBe(true);
  expect(readFileSync(join(s.root, dir("1"), "a.txt"), "utf8")).toBe("support's");
  const keeper = (await s.workspace.resolve(ref("1", "keeper"), s.app.context())).env;
  expect((await keeper.writeFile("k.txt", "keeper's", ctx)).ok).toBe(true);
  expect(readFileSync(join(s.root, "agents", "keeper", "k.txt"), "utf8")).toBe("keeper's");
  expect(readdirSync(outside)).toEqual(["keep.txt"]);
  await s.app.stop();
});

test("paths never leave the sandbox: absolute, .., and links the guest made, wherever they point", async () => {
  const s = await started();
  const env = await s.env("1");
  const host = join(s.root, dir("1"));
  const other = join(s.root, dir("2"));
  // The server's own state and another conversation's files, next to this one on the host.
  writeFileSync(join(s.root, "state.db"), "every conversation");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "theirs.txt"), "conversation 2's");
  writeFileSync(join(host, "real.txt"), "mine");
  mkdirSync(join(host, "dir"));
  // Links as the guest makes them: targets in the guest's namespace, or host paths it guessed.
  symlinkSync("/etc", join(host, "etc"));
  symlinkSync(other, join(host, "host-path"));
  symlinkSync("../../../2/support", join(host, "dir", "up"));
  symlinkSync("../../..", join(host, "parent"));
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
  expect(existsSync(join(other, "planted.txt"))).toBe(false);
  expect(existsSync(join(s.root, "planted"))).toBe(false);
  expect(existsSync(join(other, "stolen.txt"))).toBe(false);
  // The link itself can be seen and removed: what it points to stays.
  expect(await env.fileInfo("host-path", ctx)).toMatchObject({ ok: true, value: { kind: "symlink", path: "/workspace/host-path" } });
  expect(await code(env.remove("host-path", undefined, ctx))).toBe("ok");
  expect(readFileSync(join(other, "theirs.txt"), "utf8")).toBe("conversation 2's");
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
  expect(existsSync(join(s.root, TMP_DIR, dir("1"), spillPath.slice("/tmp/pikit/".length)))).toBe(true);
  expect((await env.createTempDir("../escape-", ctx)).ok).toBe(false);
  await s.app.stop();

  // A new process: what an earlier one left in its temporary area is gone; the workspace, and a `tmp`
  // that is not the component's, stay.
  writeFileSync(join(s.root, dir("1"), "kept.txt"), "kept");
  mkdirSync(join(s.root, "tmp"));
  writeFileSync(join(s.root, "tmp", "theirs.txt"), "not the component's");
  const again = await defineApp({ components: [createExecutionGondolin(new FakeLauncher())], config: { "execution-gondolin": { root: s.root } }, logger: silentLogger }).create();
  await again.start();
  expect(existsSync(join(s.root, TMP_DIR, "chats", chat("1")))).toBe(false);
  expect(existsSync(join(s.root, dir("1"), "kept.txt"))).toBe(true);
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
    label: label("7"),
    mounts: { "/workspace": join(s.root, dir("7")), "/tmp/pikit": join(s.root, TMP_DIR, dir("7")) },
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
  expect(launcher.guests.map((g) => g.spec.mounts["/workspace"])).toEqual([join(s.root, dir("7")), join(s.root, dir("8"))]);
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
    [label("1"), true],
    [label("2"), false],
    [label("3"), false],
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

test("maxVms counts every profile's VMs together: another agent's command closes the idle VM, or waits for it, as with one machine", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = (command) => (command.command === "hang" ? { hang: true } : { exitCode: 0 });
  const s = await started({ maxVms: 1, queueSeconds: 0.1, agents: { developer: { cpus: 1 }, analyst: { memory: "2G" } } }, { launcher });
  const envOf = async (agent: string) => (await s.workspace.resolve(ref("1", agent), s.app.context())).env;
  const [developer, analyst] = [await envOf("developer"), await envOf("analyst")];

  await developer.exec("quick", undefined, ctx);
  await analyst.exec("quick", undefined, ctx);
  // The developer's VM, idle, was closed for the analyst's: one VM for both machines.
  expect(launcher.guests.map((g) => [g.spec.label, g.spec.cpus, g.spec.memory, g.closed])).toEqual([
    [label("1", "developer"), 1, "1G", true],
    [label("1", "analyst"), 2, "2G", false],
  ]);

  const hanging = analyst.exec("hang", undefined, ctx);
  await until(() => launcher.live.length === 1 && launcher.live[0]?.running === 1);
  const refused = await developer.exec("quick", undefined, ctx);
  expect(refused).toMatchObject({ ok: false, error: { code: "spawn_error" } });
  expect(!refused.ok && refused.error.message).toContain("all 1 VMs (maxVms) are running commands");

  // Waiting, the developer gets a VM once the analyst's command ends.
  const waiting = developer.exec("quick", undefined, withAbortSignal(new AbortController().signal, ctx));
  await analyst.cleanup(ctx);
  expect((await waiting).ok).toBe(true);
  await hanging;
  expect(launcher.live.map((g) => g.spec.label)).toEqual([label("1", "developer")]);
  expect(launcher.guests).toHaveLength(3);
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
  expect(s.logs).toContainEqual({ level: "warn", message: "execution-gondolin: secrets not set, left out of this VM until its next boot", fields: { sandbox: dir("1"), secrets: ["NPM_TOKEN"] } });
  // Commands get no secret through their variables: only the VM's placeholders carry them.
  expect(guest?.commands.map((c) => c.env)).toEqual([{}, {}]);
  expect(JSON.stringify(s.logs)).not.toContain("value-");
  await s.app.stop();
});

/** The machine fields of the spec a VM booted with. */
const machine = ({ allowedHosts, secrets, memory, cpus, packages }: GuestSpec) => ({ allowedHosts, secrets: secrets.map((secret) => secret.name), memory, cpus, packages });

test("profiles: an agent's machine replaces the base field by field; an agent with none, a misspelled one and `default` get the base", async () => {
  const s = await started(
    {
      allowedHosts: ["base.example"],
      packages: ["make"],
      agents: {
        developer: { packages: ["github-cli"], secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }], allowedHosts: ["objects.githubusercontent.com"] },
        analyst: { memory: "2G", cpus: 1 },
      },
    },
    { providers: [secretsOf({ GH_TOKEN: "ghp_value" })] },
  );
  const base = { allowedHosts: ["base.example"], secrets: [], memory: "1G", cpus: 2, packages: ["make"] };
  const specOf = async (agent: string) => {
    const { env } = await s.workspace.resolve(ref("1", agent), s.app.context());
    await run(env, "true");
    return machine(s.launcher.guests.at(-1)?.spec as GuestSpec);
  };

  // Its allowedHosts replace the base's (base.example is not added), plus its own secrets' hosts; its packages replace the base's.
  expect(await specOf("developer")).toEqual({ allowedHosts: ["objects.githubusercontent.com", "api.github.com", "github.com"], secrets: ["GH_TOKEN"], memory: "1G", cpus: 2, packages: ["github-cli"] });
  // What it leaves out is the base's.
  expect(await specOf("analyst")).toEqual({ ...base, memory: "2G", cpus: 1 });
  for (const agent of ["support", "developerr", "constructor", "_shared"]) expect({ agent, machine: await specOf(agent) }).toEqual({ agent, machine: base });
  await run(s.execution, "true");
  expect(s.launcher.guests.at(-1)?.spec.label).toBe("pikit default");
  expect(machine(s.launcher.guests.at(-1)?.spec as GuestSpec)).toEqual(base);
  await s.app.stop();
});

test("a profile's secret reaches only that agent's VMs, also after a rotation; the unset warning names only a VM's own secrets", async () => {
  const values: Record<string, string | undefined> = { GH_TOKEN: "ghp_value-1" };
  const s = await started(
    { agents: { developer: { secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com"] }] }, analyst: { secrets: [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"] }] } } },
    { providers: [secretsOf(values)] },
  );
  const envOf = async (agent: string) => (await s.workspace.resolve(ref("1", agent), s.app.context())).env;
  const [support, developer] = [await envOf("support"), await envOf("developer")];

  await run(support, "first");
  await run(developer, "first");
  values.GH_TOKEN = "ghp_value-2";
  await run(support, "second");
  await run(developer, "second");

  const [base, dev] = s.launcher.guests;
  expect(base?.spec.secrets).toEqual([]);
  expect(base?.spec.allowedHosts).toEqual([]);
  expect(dev?.spec.secrets).toEqual([{ name: "GH_TOKEN", hosts: ["api.github.com"], value: "ghp_value-1" }]);
  // The pool reads every agent's secrets; each VM keeps only those it booted with (GondolinGuest.refreshSecrets, below).
  expect(dev?.refreshes.at(-1)).toEqual({ GH_TOKEN: "ghp_value-2", NPM_TOKEN: undefined });
  // NPM_TOKEN is unset, but neither VM has it: no warning yet. The analyst's VM names it.
  expect(s.logs.filter((log) => log.message.startsWith("execution-gondolin: secrets not set"))).toEqual([]);
  await run(await envOf("analyst"), "first");
  expect(s.logs.filter((log) => log.message.startsWith("execution-gondolin: secrets not set"))).toEqual([
    { level: "warn", message: "execution-gondolin: secrets not set, left out of this VM until its next boot", fields: { sandbox: dir("1", "analyst"), secrets: ["NPM_TOKEN"] } },
  ]);
  expect(JSON.stringify(s.logs)).not.toContain("value-");
  await s.app.stop();
});

test("GondolinGuest.refreshSecrets updates and removes only the secrets the VM booted with: it never gains another agent's", () => {
  const { secretManager } = createHttpHooks({ allowedHosts: [], secrets: { GH_TOKEN: { hosts: ["api.github.com"], value: "ghp_value-1" } } });
  const calls: string[] = [];
  const recording: SecretManager = {
    listSecrets: () => secretManager.listSecrets(),
    updateSecret: (name, options) => void (calls.push(`update ${name}`), secretManager.updateSecret(name, options)),
    deleteSecret: (name) => void (calls.push(`delete ${name}`), secretManager.deleteSecret(name)),
  };
  const guest = new GondolinGuest({} as never, "/bin/sh", recording, new Map([["GH_TOKEN", "ghp_value-1"]]));

  guest.refreshSecrets({ GH_TOKEN: "ghp_value-1", NPM_TOKEN: "npm_value", OTHER: "other_value" });
  guest.refreshSecrets({ GH_TOKEN: "ghp_value-2", NPM_TOKEN: "npm_value" });
  guest.refreshSecrets({ NPM_TOKEN: "npm_value" });

  expect(calls).toEqual(["update GH_TOKEN", "delete GH_TOKEN"]);
  expect(secretManager.listSecrets().map((secret) => [secret.name, secret.deleted])).toEqual([["GH_TOKEN", true]]);
});

test("agents' keys are agent names: anything else, or a field that is global only, is refused at start", async () => {
  for (const key of ["Developer", "dev_ops", "-dev", "dev-", "dev--ops", "1dev", "a".repeat(101)]) {
    expect({ key, refused: await started({ agents: { [key]: {} } }).then((s) => (s.app.stop(), false), () => true) }).toEqual({ key, refused: true });
  }
  for (const profile of [{ root: "/elsewhere" }, { maxVms: 9 }, { memory: "lots" }, { packages: ["--allow-untrusted"] }]) {
    await expect(started({ agents: { developer: profile } })).rejects.toThrow();
  }
  const s = await started({ agents: { ["a".repeat(100)]: {}, "dev-ops2": { cpus: 4 } } });
  await s.app.stop();
});

test("a secret is never named like Object.prototype's special keys (__proto__, constructor, prototype): refused at start, the base's or a profile's", async () => {
  const values: Record<string, string | undefined> = {};
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const secrets = [{ name, hosts: ["api.example"] }];
    await expect(started({ secrets }, { providers: [secretsOf(values)] })).rejects.toThrow();
    await expect(started({ agents: { developer: { secrets } } }, { providers: [secretsOf(values)] })).rejects.toThrow();
  }
  const s = await started({ secrets: [{ name: "__proto__x", hosts: ["api.example"] }, { name: "CONSTRUCTOR", hosts: ["api.example"] }] }, { providers: [secretsOf(values)] });
  await s.app.stop();
});

test("a profile no agent.definition has is warned of at start where agents are defined; a sandbox host (no agents) cannot tell", async () => {
  const agents = defineComponent({
    name: "agents-test",
    setup(pikit) {
      for (const name of ["developer", "analyst"]) pikit.provideKeyed("agent.definition", name, { name, model: "faux/model" } as never);
    },
  });
  const warning = PROFILE_WARNING;
  const s = await started({ agents: { developer: {}, developr: { cpus: 4 } } }, { providers: [agents] });
  expect(s.logs).toContainEqual({ level: "warn", message: warning, fields: { profiles: ["developr"], agents: ["developer", "analyst"] } });
  await s.app.stop();

  const host = await started({ agents: { developr: { cpus: 4 } } });
  expect(host.logs.some((log) => log.message === warning)).toBe(false);
  await host.app.stop();
  const right = await started({ agents: { developer: {} } }, { providers: [agents] });
  expect(right.logs.some((log) => log.message === warning)).toBe(false);
  await right.app.stop();
});

test("live agents (agent.directory) are not used: agents-live uses agent.tools, which use execution.shell, so the App keeps no cycle; the warning allows for them", async () => {
  const agents = defineComponent({
    name: "agents-test",
    setup(pikit) {
      pikit.provideKeyed("agent.definition", "developer", { name: "developer", model: "faux/model" } as never);
    },
  });
  // agents-live's shape: it reads the tools; tool-bash's: it runs on execution.shell.
  const live = defineComponent({
    name: "agents-live-test",
    setup(pikit) {
      pikit.useKeyed("agent.tool");
      pikit.provide("agent.directory", { list: async () => [], get: async () => undefined } as never);
    },
  });
  const tool = defineComponent({
    name: "tool-test",
    setup(pikit) {
      pikit.use("execution.shell");
      pikit.provideKeyed("agent.tool", "bash", {} as never);
    },
  });
  const s = await started({ agents: { developer: {}, support: {} } }, { providers: [agents, live, tool] });
  expect(s.logs).toContainEqual({ level: "warn", message: PROFILE_WARNING, fields: { profiles: ["support"], agents: ["developer"] } });
  expect(PROFILE_WARNING).toContain("unless it is a live agent's (agents-live), which is not checked");
  await s.app.stop();
});

test("images: one checkpoint per build id and packages; making one removes only another build's files and other processes' partial ones", () => {
  const dev = imageFile("build-1", ["github-cli", "git"]);
  const analyst = imageFile("build-1", ["py3-pandas"]);
  // The packages in any order, each once, name the same file; the build id is its own part of the name.
  expect(imageFile("build-1", ["git", "github-cli", "git"])).toBe(dev);
  expect(analyst).not.toBe(dev);
  expect(dev.split("-")[0]).toBe(analyst.split("-")[0]);
  const old = imageFile("build-0", ["github-cli", "git"]);
  expect(old.split("-")[0]).not.toBe(dev.split("-")[0]);
  const partial = (file: string, pid: number) => file.replace(/\.qcow2$/, `.${pid}.partial`);

  const names = [dev, analyst, old, partial(analyst, 42), partial(dev, 7), partial(old, 42), "stray.qcow2"];
  expect(staleImages(names, "build-1", 42).sort()).toEqual([old, partial(dev, 7), partial(old, 42), "stray.qcow2"].sort());
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
  // A profile's secret too.
  expect(await failure({ agents: { developer: { secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com"] }] } } })).toContain("secrets are configured (GH_TOKEN) but no `secrets` provider is installed");
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
  expect(launcher.guests.filter((guest) => guest.spec.label === label("busy"))).toHaveLength(1);
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

// Retention (`retentionDays`): a chat's sandboxes go once nothing worked in them for that many days.

/** A clock `offset.ms` ahead of the real one, with short sleeps: a test moves time by changing `offset.ms`. */
function movableClock(): { clock: Clock; offset: { ms: number } } {
  const offset = { ms: 0 };
  return { clock: { now: () => Date.now() + offset.ms, sleep: (ms) => Bun.sleep(Math.min(ms, 5)) }, offset };
}

/** How many sweeps retention has run in `s`. */
const sweeps = (s: Started) => s.logs.filter((log) => log.message === "execution-gondolin: retention swept").length;
/** The marker noting the last use of chat `test:<id>`. */
const marker = (root: string, id: string) => join(root, USED_DIR, chat(id));
const RETIRED = "execution-gondolin: deleted the sandboxes of chats unused for 30 days (retentionDays)";

test("retention: at start, a chat unused for retentionDays loses every agent's sandbox; a fresh one, a shared agent's, default, and one never noted stay", async () => {
  const root = join(temporaryDir(), "gondolin");
  const config = { retentionDays: 30, agents: { librarian: { workspace: "agent" } } };
  const first = await started(config, { root });
  for (const agent of ["support", "developer"]) {
    const { env } = await first.workspace.resolve(ref("old", agent), first.app.context());
    expect((await env.writeFile("notes.md", "12345", ctx)).ok).toBe(true);
  }
  expect((await (await first.env("fresh")).writeFile("kept.txt", "kept", ctx)).ok).toBe(true);
  const { env: shelf } = await first.workspace.resolve(ref("old", "librarian"), first.app.context());
  expect((await shelf.writeFile("shelf.md", "shelf", ctx)).ok).toBe(true);
  await first.app.stop();
  // The markers outlive the process: the old chat was last used 31 days ago (the fresh one, now).
  expect(Number(readFileSync(marker(root, "fresh"), "utf8"))).toBeGreaterThan(Date.now() - 60_000);
  writeFileSync(marker(root, "old"), String(Date.now() - 31 * DAY));
  // A chat from before retention was set: no marker.
  mkdirSync(join(root, dir("unmarked")), { recursive: true });

  const second = await started(config, { root });
  await until(() => sweeps(second) === 1);
  expect(existsSync(join(root, "chats", chat("old")))).toBe(false);
  expect(existsSync(marker(root, "old"))).toBe(false);
  expect(readFileSync(join(root, dir("fresh"), "kept.txt"), "utf8")).toBe("kept");
  expect(readFileSync(join(root, "agents", "librarian", "shelf.md"), "utf8")).toBe("shelf");
  expect(existsSync(join(root, "default"))).toBe(true);
  // Its count starts now.
  expect(existsSync(join(root, dir("unmarked")))).toBe(true);
  expect(Number(readFileSync(marker(root, "unmarked"), "utf8"))).toBeGreaterThan(Date.now() - 60_000);
  // Counts and bytes, never a chat.
  expect(second.logs).toContainEqual({ level: "info", message: RETIRED, fields: { chats: 1, bytes: 10 } });
  expect(JSON.stringify(second.logs)).not.toContain(chat("old"));
  expect(JSON.stringify(second.logs)).not.toContain("test:old");
  expect(readdirSync(join(root, TMP_DIR, "retired"))).toEqual([]);
  // The chat again: a new, empty workspace.
  expect(await (await second.env("old")).listDir(".", ctx)).toEqual({ ok: true, value: [] });
  await second.app.stop();
});

test("retention: without retentionDays nothing is noted and nothing deleted, however old", async () => {
  const { clock, offset } = movableClock();
  const s = await started({}, { clock });
  expect((await (await s.env("1")).writeFile("a.txt", "a", ctx)).ok).toBe(true);
  offset.ms = 3650 * DAY;
  await s.app.stop();
  const again = await started({}, { clock, root: s.root });
  expect((await (await again.env("2")).writeFile("b.txt", "b", ctx)).ok).toBe(true);
  await Bun.sleep(30);
  expect(readFileSync(join(s.root, dir("1"), "a.txt"), "utf8")).toBe("a");
  expect(existsSync(join(s.root, USED_DIR))).toBe(false);
  expect(again.logs.some((log) => log.message.includes("retention"))).toBe(false);
  await again.app.stop();
});

test("retention: each use refreshes a chat's count; the sweep runs every hour on the app's clock, temporary files included", async () => {
  const { clock, offset } = movableClock();
  const s = await started({ retentionDays: 30 }, { clock });
  await until(() => sweeps(s) === 1);
  expect((await (await s.env("active")).writeFile("a.txt", "a", ctx)).ok).toBe(true);
  const idle = await s.env("idle");
  expect((await idle.writeFile("b.txt", "b", ctx)).ok).toBe(true);
  expect((await idle.createTempFile({ prefix: "spill-" }, ctx)).ok).toBe(true);
  expect(readdirSync(join(s.root, TMP_DIR, dir("idle")))).toHaveLength(1);

  // 29 days later: a sweep (an hour has passed), nothing old enough; the active chat is used again.
  offset.ms = 29 * DAY;
  await until(() => sweeps(s) === 2);
  expect(existsSync(join(s.root, dir("idle")))).toBe(true);
  await s.env("active");
  expect(Number(readFileSync(marker(s.root, "active"), "utf8"))).toBeGreaterThan(Date.now() + 28 * DAY);

  // 31 days: the idle chat goes, its temporary files with it; the active one, used 2 days ago, stays.
  offset.ms = 31 * DAY;
  await until(() => sweeps(s) === 3);
  expect(existsSync(join(s.root, "chats", chat("idle")))).toBe(false);
  expect(existsSync(join(s.root, TMP_DIR, "chats", chat("idle")))).toBe(false);
  expect(readFileSync(join(s.root, dir("active"), "a.txt"), "utf8")).toBe("a");
  expect(s.logs).toContainEqual({ level: "info", message: RETIRED, fields: { chats: 1, bytes: 1 } });
  // Used again, it works in a new, empty directory.
  const back = await s.env("idle");
  expect((await back.writeFile("c.txt", "c", ctx)).ok).toBe(true);
  expect(readdirSync(join(s.root, dir("idle")))).toEqual(["c.txt"]);
  await s.app.stop();
});

test("retention: a chat in use is kept however old (a command running, a VM up), and goes once neither is", async () => {
  const launcher = new FakeLauncher();
  launcher.respond = (command) => (command.command === "hang" ? { hang: true } : { exitCode: 0 });
  const { clock, offset } = movableClock();
  const s = await started({ retentionDays: 1, idleSeconds: 0.5 }, { launcher, clock });
  await until(() => sweeps(s) === 1);
  const running = await s.env("running");
  const command = running.exec("hang", undefined, ctx);
  await until(() => launcher.guests.some((guest) => guest.running === 1));
  expect((await run(await s.env("booted"), "true")).result.ok).toBe(true);
  await s.env("unused");

  offset.ms = 2 * DAY;
  await until(() => sweeps(s) === 2);
  expect(existsSync(join(s.root, "chats", chat("unused")))).toBe(false);
  expect(existsSync(join(s.root, dir("running")))).toBe(true);
  expect(existsSync(join(s.root, dir("booted")))).toBe(true);

  await running.cleanup(ctx);
  await command;
  await until(() => launcher.live.length === 0);
  offset.ms = 2 * DAY + 2 * 3_600_000;
  await until(() => sweeps(s) === 3);
  expect(existsSync(join(s.root, "chats", chat("running")))).toBe(false);
  expect(existsSync(join(s.root, "chats", chat("booted")))).toBe(false);
  await s.app.stop();
});

test("retention: a command issued while the start sweep runs works, in its chat's directory kept or made anew", async () => {
  const root = join(temporaryDir(), "gondolin");
  const first = await started({ retentionDays: 1 }, { root });
  expect((await (await first.env("1")).writeFile("old.txt", "old", ctx)).ok).toBe(true);
  await first.app.stop();
  writeFileSync(marker(root, "1"), String(Date.now() - 2 * DAY));

  const s = await started({ retentionDays: 1 }, { root });
  const env = await s.env("1");
  expect((await env.writeFile("new.txt", "new", ctx)).ok).toBe(true);
  expect((await run(env, "true")).result.ok).toBe(true);
  await until(() => sweeps(s) === 1);
  expect(readFileSync(join(root, dir("1"), "new.txt"), "utf8")).toBe("new");
  await s.app.stop();
});

test("retention: a use and a retirement of one chat never overlap: a use first keeps it, a retirement first is waited for", async () => {
  const root = temporaryDir();
  const options = {
    chats: join(root, "chats"),
    tmp: join(root, "tmp"),
    markers: join(root, "used"),
    trash: join(root, "trash"),
    days: 1,
    clock: systemClock,
    live: () => false,
    log: { debug: () => {}, info: () => {}, warn: () => {} },
  };
  const name = chat("x");
  const workspace = join(root, "chats", name, "support");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "old.txt"), "old");
  const old = Date.now() + 1; // every use before this is old

  // Used first: the retirement that follows keeps it. In use: kept too.
  const using = new Retention(options);
  const used = using.use(name);
  expect(using.retire(name, old - 1000)).toBeUndefined();
  await used;
  expect(new Retention({ ...options, live: () => true }).retire(name, old)).toBeUndefined();
  expect(existsSync(join(workspace, "old.txt"))).toBe(true);

  // Retired first: the use waits until the directory is moved away, then works in a new one.
  const retention = new Retention(options);
  const retiring = retention.retire(name, old);
  expect(retiring).toBeDefined();
  const waited = retention.use(name).then(() => {
    expect(existsSync(join(root, "chats", name))).toBe(false);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "new.txt"), "new");
  });
  expect(await retiring).toBe(3);
  await waited;
  expect(readdirSync(workspace)).toEqual(["new.txt"]);
  expect(readdirSync(join(root, "trash"))).toEqual([]);
  // The waiting use noted itself after the retirement removed the old marker.
  expect(Number(readFileSync(join(root, "used", name), "utf8"))).toBeGreaterThan(Date.now() - 60_000);
});

test("retention: retentionDays is a whole number of days, at least 1, and global only", async () => {
  for (const config of [{ retentionDays: 0 }, { retentionDays: 1.5 }, { agents: { developer: { retentionDays: 3 } } }]) {
    await expect(started(config)).rejects.toThrow();
  }
});
