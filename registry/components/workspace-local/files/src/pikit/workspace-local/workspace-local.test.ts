/**
 * workspace-local's tests. They are copied with the component and keep running in your project.
 * `execution` is a test environment over a temporary directory (`createLocalExecution`, the one
 * behind `execution-local`); the agents' runs use a scripted model, so no API key is needed.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type Clock, defineApp, defineComponent, type Logger, silentLogger, systemClock } from "@pikit/core";
import { type ConversationRef, defineAgent } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createDurableRuntime, modelsFrom, type WorkspaceProvider } from "@pikit/pi-adapter";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { createWorkspaceConformance, openSqliteDatabase, scriptedProvider } from "@pikit/pi-adapter/testing";
import { createWriteTool } from "@pikit/pi-adapter/tools";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/pi-adapter/execution";
import workspaceLocal from "./index.ts";
import { DAY, HOUR, RETIRED_DIR, Retention, USED_DIR } from "./retention.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory, `execution`'s working directory in a test. */
function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-workspace-local-")));
  directories.push(dir);
  return dir;
}

/** `execution` and `execution.shell` over `dir`, as execution-local provides them, with `variables`. */
function executionAt(dir: string, variables: Record<string, string> = {}) {
  return defineComponent({
    name: "execution-test",
    setup(pikit) {
      const env = createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "", ...variables } });
      pikit.provide("execution", env);
      pikit.provide("execution.shell", env);
      return { stop: (ctx) => env.cleanup(ctx) };
    },
  });
}

function conversation(agent: string, id = "1"): ConversationRef {
  return { key: `test:${agent}:${id}`, agent, conversationId: `${agent}-${id}` };
}

/** The directory of the chat `key` inside its agent's: `_chats/` and the hex SHA-256 of the key, computed here. */
const chatDir = (key: string) => join("_chats", new Bun.CryptoHasher("sha256").update(key).digest("hex"));

/** A started app with this component over `execution` in `dir`, and the `workspace` it provides. */
async function started(dir: string, config: Record<string, unknown> = {}, variables?: Record<string, string>): Promise<{ app: App; workspace: WorkspaceProvider }> {
  let found: WorkspaceProvider | undefined;
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const workspace = pikit.use("workspace");
      return { start: () => void (found = workspace.get()) };
    },
  });
  const app = await defineApp({ components: [executionAt(dir, variables), workspaceLocal, reader], config: { "workspace-local": config }, logger: silentLogger }).create();
  await app.start();
  if (found === undefined) throw new Error("workspace was not resolved");
  return { app, workspace: found };
}

// The workspace contract: a conversation keeps its files, two agents are apart.
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started(temporaryDir());
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started(temporaryDir(), { per: "agent" });
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local per agent ${c.group}: ${c.name}`, () => c.run());
}
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started(temporaryDir(), { per: "channel" });
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local per channel ${c.group}: ${c.name}`, () => c.run());
}

// An agent's directory is still pi-durable's whole ExecutionEnv, with a shell.
for (const c of createDurableExecutionConformance(async () => {
  const { app, workspace } = await started(temporaryDir());
  const { env } = await workspace.resolve(conversation("support"), app.context());
  return { env, dispose: () => app.stop() };
}, { expect })) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

// Start and stop honour their deadline.
const lifecycleDir = temporaryDir();
for (const c of createLifecycleConformance(() => ({ component: workspaceLocal, providers: [executionAt(lifecycleDir)] }))) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [executionAt(tmpdir()), workspaceLocal], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "workspace-local")).toEqual({
    name: "workspace-local",
    provides: ["workspace"],
    requires: ["execution"],
    optional: [],
  });
});

test("each agent gets a directory of its own in each chat under root, in execution's directory, made on its first call", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);
  expect(readdirSync(join(dir, "agents"))).toEqual([]);

  const support = await workspace.resolve(conversation("support"), app.context());
  const ops = await workspace.resolve(conversation("ops"), app.context());

  expect(support.env.cwd).toBe(join(dir, "agents", "support", chatDir("test:support:1")));
  expect(ops.env.cwd).toBe(join(dir, "agents", "ops", chatDir("test:ops:1")));
  expect(readdirSync(join(dir, "agents")).sort()).toEqual(["ops", "support"]);
  await app.stop();
});

test("per chat (the default): a reset (/new) and a delegated child of the same agent work in the chat's directory; another agent and another chat in their own", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);
  const origin = { key: "gchat:spaces/AAA", agent: "support", conversationId: "1", channel: "google-chat" };
  const cwd = async (ref: ConversationRef) => (await workspace.resolve(ref, app.context())).env.cwd;
  const here = join(dir, "agents", "support", chatDir("gchat:spaces/AAA"));
  const first = (await workspace.resolve(origin, app.context())).env;
  await first.writeFile("notes.md", "what my past self wrote", app.context());

  // /new: a new conversationId under the same key.
  const reset = (await workspace.resolve({ ...origin, conversationId: "2" }, app.context())).env;
  expect(reset.cwd).toBe(here);
  expect(await reset.readTextFile("notes.md", app.context())).toEqual({ ok: true, value: "what my past self wrote" });
  // A delegated child (and grandchild) of the same agent: its origin's chat, not its own key.
  expect(await cwd({ key: "delegate:1:support:t-1", agent: "support", conversationId: "3", channel: "delegate", origin })).toBe(here);
  expect(await cwd({ key: "delegate:2:support.support:t-2", agent: "support", conversationId: "4", channel: "delegate", origin })).toBe(here);
  // A child of another agent: that agent's directory of the chat.
  expect(await cwd({ key: "delegate:1:support:t-3", agent: "ops", conversationId: "5", channel: "delegate", origin })).toBe(join(dir, "agents", "ops", chatDir("gchat:spaces/AAA")));
  // Another chat: another directory.
  expect(await cwd({ ...origin, key: "gchat:spaces/BBB", conversationId: "6" })).toBe(join(dir, "agents", "support", chatDir("gchat:spaces/BBB")));
  expect(readdirSync(join(dir, "agents", "support", "_chats")).sort()).toEqual([chatDir("gchat:spaces/AAA"), chatDir("gchat:spaces/BBB")].map((path) => path.slice("_chats/".length)).sort());
  await app.stop();
});

test("per agent: every chat of an agent shares its directory; two agents still never do", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, { per: "agent" });
  const one = (await workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1" }, app.context())).env;
  const two = (await workspace.resolve({ key: "telegram:2", agent: "support", conversationId: "2", channel: "telegram" }, app.context())).env;
  await one.writeFile("index.md", "everything", app.context());

  expect(one.cwd).toBe(join(dir, "agents", "support"));
  expect(two.cwd).toBe(one.cwd);
  expect(await two.readTextFile("index.md", app.context())).toEqual({ ok: true, value: "everything" });
  expect((await workspace.resolve({ key: "telegram:1", agent: "ops", conversationId: "1" }, app.context())).env.cwd).toBe(join(dir, "agents", "ops"));
  await app.stop();
});

test("per chat, a chat with no key is refused and nothing is created; any other key is one safe name once hashed", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  await expect(workspace.resolve({ key: "", agent: "support", conversationId: "1" }, app.context())).rejects.toThrow("a directory needs a non-empty key");
  await expect(workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1", origin: { key: "", agent: "support", conversationId: "0" } }, app.context())).rejects.toThrow("a directory needs a non-empty key");
  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect((await workspace.resolve({ key: "../../escaped/..", agent: "support", conversationId: "1" }, app.context())).env.cwd).toBe(join(dir, "agents", "support", chatDir("../../escaped/..")));
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

test("an absolute root is used as it is", async () => {
  const root = join(temporaryDir(), "workspaces");
  const { app, workspace } = await started(temporaryDir(), { root });

  expect((await workspace.resolve(conversation("support"), app.context())).env.cwd).toBe(join(root, "support", chatDir("test:support:1")));
  await app.stop();
});

test("an agent's commands run with execution's variables, in the agent's directory", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, {}, { GITHUB_TOKEN: "from-execution" });
  const { env } = await workspace.resolve(conversation("ops"), app.context());

  await env.exec('printf "%s %s" "$GITHUB_TOKEN" "$(pwd)" > seen.txt', undefined, app.context());

  const own = join(dir, "agents", "ops", chatDir("test:ops:1"));
  expect(readFileSync(join(own, "seen.txt"), "utf8")).toBe(`from-execution ${own}`);
  await app.stop();
});

test("an agent name that could leave root is refused, and nothing is created", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  for (const agent of ["", "..", "../escaped", "a/b", "/tmp", "Support", "_", "__shared", "_../escaped"]) {
    await expect(workspace.resolve(conversation(agent), app.context())).rejects.toThrow("not a safe directory name");
  }

  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

test("per channel, each channel of an agent gets a directory of its own inside the agent's; a channel instance's `:` becomes `.`", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, { per: "channel" });
  const resolve = async (channel?: string) => (await workspace.resolve({ ...conversation("support"), ...(channel !== undefined && { channel }) }, app.context())).env.cwd;

  expect(await resolve("telegram")).toBe(join(dir, "agents", "support", "telegram"));
  expect(await resolve("telegram:ops")).toBe(join(dir, "agents", "support", "telegram.ops"));
  expect(await resolve("dashboard")).toBe(join(dir, "agents", "support", "dashboard"));
  // No channel recorded (a ref made by hand): the agent's directory.
  expect(await resolve()).toBe(join(dir, "agents", "support"));
  expect(readdirSync(join(dir, "agents", "support")).sort()).toEqual(["dashboard", "telegram", "telegram.ops"]);
  await app.stop();
});

test("an agentless sandbox's name (one leading `_`, execution-serve's) gets a directory of its own", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  expect((await workspace.resolve(conversation("_shared"), app.context())).env.cwd).toBe(join(dir, "agents", "_shared", chatDir("test:_shared:1")));
  expect((await workspace.resolve(conversation("shared"), app.context())).env.cwd).toBe(join(dir, "agents", "shared", chatDir("test:shared:1")));
  await app.stop();
});

test("per agent and per chat, the channel changes nothing", async () => {
  const dir = temporaryDir();
  const perAgent = await started(dir, { per: "agent" });
  expect((await perAgent.workspace.resolve({ ...conversation("support"), channel: "telegram" }, perAgent.app.context())).env.cwd).toBe(join(dir, "agents", "support"));
  await perAgent.app.stop();

  const { app, workspace } = await started(dir);
  expect((await workspace.resolve({ ...conversation("support"), channel: "telegram" }, app.context())).env.cwd).toBe(join(dir, "agents", "support", chatDir("test:support:1")));
  await app.stop();
});

test("per channel, a channel that is not a safe directory name is refused, and nothing is created", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, { per: "channel" });

  for (const channel of ["", "..", "a/b", "../escaped", "Telegram", "telegram:", ":ops", "telegram:..", "tele.gram"]) {
    await expect(workspace.resolve({ ...conversation("support"), channel }, app.context())).rejects.toThrow("not a safe directory name");
  }

  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

/**
 * Real runs over this component (scripted model, the `write` tool): the runtime gives each tool call its
 * conversation's workspace (runtime-pi's wiring: `harnessEnv`). `ask` sends one message to a
 * conversation of `agent` and resolves when its run has ended.
 */
async function realRuns(dir: string, config: Record<string, unknown> = {}) {
  let workspace!: WorkspaceProvider;
  const agents = ["alpha", "beta"].map((name) => defineAgent({ name, model: "faux/scripted", tools: ["write"] }));
  const settled: string[] = [];
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const provided = pikit.use("workspace");
      pikit.on("agent.settled", (payload) => void settled.push(payload.requestId));
      return { start: () => void (workspace = provided.get()) };
    },
  });
  const app = await defineApp({ components: [executionAt(dir), workspaceLocal, reader], config: { "workspace-local": config }, logger: silentLogger }).create();
  await app.start();
  const sqlite = openSqliteDatabase(":memory:");
  const write = createWriteTool();
  const runtime = createDurableRuntime({
    db: sqlite.database,
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => (name === "write" ? write : undefined),
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
    workspace: () => workspace,
  });
  let requests = 0;
  return {
    /** A new conversation of `agent` (with `channel`, when given), under `key` (a reset of that chat), or a key of its own. */
    async conversation(agent: string, channel?: string, key?: string): Promise<ConversationRef> {
      const conversationId = await runtime.createConversation(app.context());
      return { key: key ?? `test:${agent}:${conversationId}`, agent, conversationId, ...(channel !== undefined && { channel }) };
    },
    async ask(conversation: ConversationRef, prompt: string) {
      const requestId = `r${++requests}`;
      await runtime.dispatch({ requestId, conversation, prompt }, app.context());
      while (!settled.includes(requestId)) await Bun.sleep(5);
    },
    async close() {
      await runtime.close(app.context());
      await sqlite.close();
      await app.stop();
    },
  };
}

test("in real runs, a file agent A's write tool writes is in A's directory and not in B's", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  const runs = await realRuns(dir);
  const alpha = await runs.conversation("alpha", undefined, "telegram:1");
  const beta = await runs.conversation("beta", undefined, "telegram:1");

  await runs.ask(alpha, 'call: write {"path":"note.md","content":"from alpha"}');
  await runs.ask(beta, 'call: write {"path":"other.md","content":"from beta"}');

  const [alphaDir, betaDir] = [join(root, "alpha", chatDir("telegram:1")), join(root, "beta", chatDir("telegram:1"))];
  expect(readFileSync(join(alphaDir, "note.md"), "utf8")).toBe("from alpha");
  expect(existsSync(join(betaDir, "note.md"))).toBe(false);
  expect(readFileSync(join(betaDir, "other.md"), "utf8")).toBe("from beta");
  expect(existsSync(join(alphaDir, "other.md"))).toBe(false);
  await runs.close();
});

test("in real runs, a reset of the chat (a new conversation under the same key) edits what the conversation before it wrote; another chat's does not see it", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  const runs = await realRuns(dir);

  await runs.ask(await runs.conversation("alpha", "telegram", "telegram:1"), 'call: write {"path":"note.md","content":"before /new"}');
  // /new: the registry points the key to a new conversation of the runtime.
  const after = await runs.conversation("alpha", "telegram", "telegram:1");
  await runs.ask(after, 'call: write {"path":"later.md","content":"after /new"}');
  await runs.ask(await runs.conversation("alpha", "telegram", "telegram:2"), 'call: write {"path":"other.md","content":"another chat"}');

  const here = join(root, "alpha", chatDir("telegram:1"));
  expect(readdirSync(here).sort()).toEqual(["later.md", "note.md"]);
  expect(readFileSync(join(here, "note.md"), "utf8")).toBe("before /new");
  expect(readdirSync(join(root, "alpha", chatDir("telegram:2")))).toEqual(["other.md"]);
  await runs.close();
});

test("per channel, in real runs: a conversation's files are in its channel's directory, also for a later message whose ref has no channel", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  const runs = await realRuns(dir, { per: "channel" });
  const telegram = await runs.conversation("alpha", "telegram");

  await runs.ask(telegram, 'call: write {"path":"one.md","content":"from telegram"}');
  // An operator's message: the runtime gives the run the channel recorded with the conversation.
  await runs.ask({ key: telegram.key, agent: telegram.agent, conversationId: telegram.conversationId }, 'call: write {"path":"two.md","content":"from the operator"}');
  await runs.ask(await runs.conversation("alpha", "dashboard"), 'call: write {"path":"one.md","content":"from the dashboard"}');

  expect(readFileSync(join(root, "alpha", "telegram", "one.md"), "utf8")).toBe("from telegram");
  expect(readFileSync(join(root, "alpha", "telegram", "two.md"), "utf8")).toBe("from the operator");
  expect(readFileSync(join(root, "alpha", "dashboard", "one.md"), "utf8")).toBe("from the dashboard");
  expect(existsSync(join(root, "alpha", "one.md"))).toBe(false);
  await runs.close();
});

test("it refuses to start when root cannot be a directory", async () => {
  const dir = temporaryDir();
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "blocked"), "a file where the agents' directories should be");
  const app = await defineApp({
    components: [executionAt(join(dir, "work")), workspaceLocal],
    config: { "workspace-local": { root: "blocked/agents" } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).message)).toContain('"workspace-local" failed to start');
});

// Retention (`retentionDays`): a chat's directories go once nothing worked in them for that many days.

/** A clock `offset.ms` ahead of the real one, with short sleeps: a test moves time by changing `offset.ms`. */
function movableClock(): { clock: Clock; offset: { ms: number } } {
  const offset = { ms: 0 };
  return { clock: { now: () => Date.now() + offset.ms, sleep: (ms) => Bun.sleep(Math.min(ms, 5)) }, offset };
}

interface Retained {
  app: App;
  workspace: WorkspaceProvider;
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
}

/** A started app over `execution` in `dir` with `config` (retention for 30 days by default), and its logs. */
async function retained(dir: string, config: Record<string, unknown> = { retentionDays: 30 }, clock?: Clock): Promise<Retained> {
  let found: WorkspaceProvider | undefined;
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const workspace = pikit.use("workspace");
      return { start: () => void (found = workspace.get()) };
    },
  });
  const logs: Retained["logs"] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, ...(fields !== undefined && { fields }) });
  const logger: Logger = { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
  const app = await defineApp({
    components: [executionAt(dir), workspaceLocal, reader],
    config: { "workspace-local": config },
    logger,
    ...(clock !== undefined && { clock }),
  }).create();
  await app.start();
  if (found === undefined) throw new Error("workspace was not resolved");
  return { app, workspace: found, logs };
}

const sweeps = (s: Retained) => s.logs.filter((log) => log.message === "workspace-local: retention swept").length;
const until = async (condition: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
};
/** The hex SHA-256 of a chat's key: its directory's and its marker's name. */
const hashOf = (key: string) => chatDir(key).slice("_chats/".length);
/** The marker noting the last use of chat `key`, under the default root. */
const markerOf = (dir: string, key: string) => join(dir, "agents", USED_DIR, hashOf(key));
/** Agent `agent`'s environment in chat `key`. */
const inChat = async (s: Retained, key: string, agent = "support") => (await s.workspace.resolve({ key, agent, conversationId: `${agent}-${key}` }, s.app.context())).env;
const RETIRED = "workspace-local: deleted the directories of chats unused for 30 days (retentionDays)";

// An agent's directory with retention is still pi-durable's whole ExecutionEnv (its calls are counted, nothing else).
for (const c of createDurableExecutionConformance(async () => {
  const s = await retained(temporaryDir());
  return { env: await inChat(s, "test:conformance"), dispose: () => s.app.stop() };
}, { expect })) {
  test(`workspace-local with retention ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

test("retention: at start, a chat unused for retentionDays loses every agent's directory; a fresh one, an agent's and a channel's own, and one never noted stay", async () => {
  const dir = temporaryDir();
  const first = await retained(dir);
  for (const agent of ["support", "ops"]) expect((await (await inChat(first, "test:old", agent)).writeFile("notes.md", "12345", first.app.context())).ok).toBe(true);
  expect((await (await inChat(first, "test:fresh")).writeFile("kept.txt", "kept", first.app.context())).ok).toBe(true);
  await first.app.stop();
  // The markers outlive the process: the old chat was last used 31 days ago (the fresh one, now).
  expect(Number(readFileSync(markerOf(dir, "test:fresh"), "utf8"))).toBeGreaterThan(Date.now() - 60_000);
  writeFileSync(markerOf(dir, "test:old"), String(Date.now() - 31 * DAY));
  // An agent's own directory (per: "agent"), a channel's (per: "channel"), and a chat from before retention was set.
  writeFileSync(join(dir, "agents", "support", "shared.md"), "shared");
  mkdirSync(join(dir, "agents", "support", "telegram"));
  writeFileSync(join(dir, "agents", "support", "telegram", "chan.md"), "chan");
  mkdirSync(join(dir, "agents", "support", chatDir("test:unmarked")), { recursive: true });

  const second = await retained(dir);
  await until(() => sweeps(second) === 1);
  for (const agent of ["support", "ops"]) expect(existsSync(join(dir, "agents", agent, chatDir("test:old")))).toBe(false);
  expect(existsSync(markerOf(dir, "test:old"))).toBe(false);
  expect(readFileSync(join(dir, "agents", "support", chatDir("test:fresh"), "kept.txt"), "utf8")).toBe("kept");
  expect(readFileSync(join(dir, "agents", "support", "shared.md"), "utf8")).toBe("shared");
  expect(readFileSync(join(dir, "agents", "support", "telegram", "chan.md"), "utf8")).toBe("chan");
  // Its count starts now.
  expect(existsSync(join(dir, "agents", "support", chatDir("test:unmarked")))).toBe(true);
  expect(Number(readFileSync(markerOf(dir, "test:unmarked"), "utf8"))).toBeGreaterThan(Date.now() - 60_000);
  // Counts and bytes, never a chat.
  expect(second.logs).toContainEqual({ level: "info", message: RETIRED, fields: { chats: 1, bytes: 10 } });
  expect(JSON.stringify(second.logs)).not.toContain(hashOf("test:old"));
  expect(JSON.stringify(second.logs)).not.toContain("test:old");
  expect(readdirSync(join(dir, "agents", RETIRED_DIR))).toEqual([]);
  // The chat again: a new, empty directory.
  expect(await (await inChat(second, "test:old")).listDir(".", second.app.context())).toEqual({ ok: true, value: [] });
  await second.app.stop();
});

test("retention: without retentionDays nothing is noted and nothing deleted, however old", async () => {
  const dir = temporaryDir();
  const { clock, offset } = movableClock();
  const s = await retained(dir, {}, clock);
  expect((await (await inChat(s, "test:1")).writeFile("a.txt", "a", s.app.context())).ok).toBe(true);
  offset.ms = 3650 * DAY;
  await s.app.stop();
  const again = await retained(dir, {}, clock);
  await inChat(again, "test:2");
  await Bun.sleep(30);
  expect(readFileSync(join(dir, "agents", "support", chatDir("test:1"), "a.txt"), "utf8")).toBe("a");
  expect(existsSync(join(dir, "agents", USED_DIR))).toBe(false);
  expect(again.logs.some((log) => log.message.includes("retention"))).toBe(false);
  await again.app.stop();
});

test("retention: each use refreshes a chat's count; the sweep runs every hour on the app's clock", async () => {
  const dir = temporaryDir();
  const { clock, offset } = movableClock();
  const s = await retained(dir, { retentionDays: 30 }, clock);
  await until(() => sweeps(s) === 1);
  expect((await (await inChat(s, "test:active")).writeFile("a.txt", "a", s.app.context())).ok).toBe(true);
  expect((await (await inChat(s, "test:idle")).writeFile("b.txt", "b", s.app.context())).ok).toBe(true);

  // 29 days later: a sweep (an hour has passed), nothing old enough; the active chat is used again.
  offset.ms = 29 * DAY;
  await until(() => sweeps(s) === 2);
  expect(existsSync(join(dir, "agents", "support", chatDir("test:idle")))).toBe(true);
  await inChat(s, "test:active");
  expect(Number(readFileSync(markerOf(dir, "test:active"), "utf8"))).toBeGreaterThan(Date.now() + 28 * DAY);

  // 31 days: the idle chat goes; the active one, used 2 days ago, stays.
  offset.ms = 31 * DAY;
  await until(() => sweeps(s) === 3);
  expect(existsSync(join(dir, "agents", "support", chatDir("test:idle")))).toBe(false);
  expect(readFileSync(join(dir, "agents", "support", chatDir("test:active"), "a.txt"), "utf8")).toBe("a");
  expect(s.logs).toContainEqual({ level: "info", message: RETIRED, fields: { chats: 1, bytes: 1 } });
  // Used again, it works in a new, empty directory.
  expect((await (await inChat(s, "test:idle")).writeFile("c.txt", "c", s.app.context())).ok).toBe(true);
  expect(readdirSync(join(dir, "agents", "support", chatDir("test:idle")))).toEqual(["c.txt"]);
  await s.app.stop();
});

test("retention: a chat with a command running is kept however old, and goes once it ended", async () => {
  const dir = temporaryDir();
  const { clock, offset } = movableClock();
  const s = await retained(dir, { retentionDays: 1 }, clock);
  await until(() => sweeps(s) === 1);
  const controller = new AbortController();
  const busy = await inChat(s, "test:busy");
  const command = busy.exec("sleep 30", undefined, withAbortSignal(controller.signal, s.app.context()));
  await inChat(s, "test:unused");

  offset.ms = 2 * DAY;
  await until(() => sweeps(s) === 2);
  expect(existsSync(join(dir, "agents", "support", chatDir("test:unused")))).toBe(false);
  expect(existsSync(join(dir, "agents", "support", chatDir("test:busy")))).toBe(true);

  controller.abort();
  await command;
  offset.ms = 2 * DAY + 2 * HOUR;
  await until(() => sweeps(s) === 3);
  expect(existsSync(join(dir, "agents", "support", chatDir("test:busy")))).toBe(false);
  await s.app.stop();
});

test("retention: a command issued while the start sweep runs works, in its chat's directory kept or made anew", async () => {
  const dir = temporaryDir();
  const first = await retained(dir, { retentionDays: 1 });
  expect((await (await inChat(first, "test:1")).writeFile("old.txt", "old", first.app.context())).ok).toBe(true);
  await first.app.stop();
  writeFileSync(markerOf(dir, "test:1"), String(Date.now() - 2 * DAY));

  const s = await retained(dir, { retentionDays: 1 });
  const env = await inChat(s, "test:1");
  expect((await env.writeFile("new.txt", "new", s.app.context())).ok).toBe(true);
  expect(await env.exec("test -f new.txt", undefined, s.app.context())).toEqual({ ok: true, value: { exitCode: 0 } });
  await until(() => sweeps(s) === 1);
  expect(readFileSync(join(dir, "agents", "support", chatDir("test:1"), "new.txt"), "utf8")).toBe("new");
  await s.app.stop();
});

test("retention: a use and a retirement of one chat never overlap: a use first keeps it, a retirement first is waited for", async () => {
  const dir = temporaryDir();
  const env = createLocalExecution({ cwd: dir, env: {} });
  const options = { env: () => env, root: "agents", chatsDir: "_chats", days: 1, clock: systemClock, log: silentLogger };
  const name = hashOf("test:x");
  const workspace = join(dir, "agents", "support", "_chats", name);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "old.txt"), "old");
  const paths = [`agents/support/_chats/${name}`];
  const old = Date.now() + 1; // every use before this is old

  // Used first: the retirement that follows keeps it. A call running in it: kept too.
  const using = new Retention(options);
  const used = using.use(name);
  expect(using.retire(name, old - 1000, paths)).toBeUndefined();
  await used;
  const running = new Retention(options);
  const tracked = running.track(name, env);
  const reading = tracked.readTextFile(`${workspace}/old.txt`, BACKGROUND_CONTEXT);
  expect(running.retire(name, old, paths)).toBeUndefined();
  expect(await reading).toEqual({ ok: true, value: "old" });

  // Retired first: the use waits until the directory is moved away, then works in a new one.
  const retention = new Retention(options);
  const retiring = retention.retire(name, old, paths);
  expect(retiring).toBeDefined();
  const waited = retention.use(name).then(() => {
    expect(existsSync(workspace)).toBe(false);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "new.txt"), "new");
  });
  expect(await retiring).toBe(3);
  await waited;
  expect(readdirSync(workspace)).toEqual(["new.txt"]);
  expect(readdirSync(join(dir, "agents", RETIRED_DIR))).toEqual([]);
  // The waiting use noted itself after the retirement removed the old marker.
  expect(Number(readFileSync(join(dir, "agents", USED_DIR, name), "utf8"))).toBeGreaterThan(Date.now() - 60_000);
});

test("retention: retentionDays is a whole number of days, at least 1", async () => {
  for (const retentionDays of [0, 1.5, -3]) await expect(retained(temporaryDir(), { retentionDays })).rejects.toThrow();
});
