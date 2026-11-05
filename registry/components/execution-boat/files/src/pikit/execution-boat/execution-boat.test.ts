/**
 * execution-boat's tests, over a fake boat API (`fake-boat.test-support.ts`): real local `bash` and
 * the real in-VM helper, boat's REST calls answered by the fake. They check pi-durable's
 * `ExecutionEnv` suite and the `workspace` suite, then what is this component's own: the keying per
 * chat and agent, the VM lifecycle on a manual clock (create, idle stop never during a command or a
 * process a command left, resume, retention), `maxVms`, the deadlines, the key never leaving the API
 * calls, secrets and egress refused, the shared snapshot format (export, restore, archives escaping the
 * root refused) and malformed answers. `live.test.ts` runs against boat itself, with `BOAT_API_KEY`.
 */

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStorage, type BlobStore, type ConversationRef } from "@pikit/contracts";
import { type App, type Clock, type ComponentDefinition, defineApp, defineComponent, type Logger, systemClock } from "@pikit/core";
import { createLifecycleConformance, createManualClock } from "@pikit/core/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { createWorkspaceConformance } from "@pikit/pi-adapter/testing";
import { FakeBoat, failure, json } from "./fake-boat.test-support.ts";
import { tarGz } from "./tar.test-support.ts";
import { createExecutionBoat, workspaceOf } from "./index.ts";

export const KEY = "boat_live_0123456789abcdefSECRET";
const ctx = BACKGROUND_CONTEXT;
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

export function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-execution-boat-")));
  directories.push(dir);
  return dir;
}

/** Conversation `id` of `agent` in chat `test:<id>`. */
const ref = (id: string, agent = "support"): ConversationRef => ({ key: `test:${id}`, agent, conversationId: id });
const workspace = (id: string, agent = "support") => workspaceOf(`test:${id}`, agent);

type Log = { level: string; message: string; fields?: Record<string, unknown> };

export interface Started {
  app: App;
  fake: FakeBoat;
  root: string;
  proc: string;
  execution: ExecutionEnv;
  workspace: WorkspaceProvider;
  env(id: string, agent?: string): Promise<ExecutionEnv>;
  logs: Log[];
}

function secretsOf(values: Record<string, string | undefined>): ComponentDefinition {
  return defineComponent({
    name: "secrets-test",
    setup(pikit) {
      pikit.provide("secrets", { get: async (name: string) => values[name] });
    },
  });
}

/** A `storage.blob` in memory, whose namespaces the test reads. */
export function memoryBlob(maxBytes = 25 * 1024 * 1024) {
  const data = new Map<string, Uint8Array>();
  const storage: BlobStorage = {
    maxBytes,
    namespace(name) {
      const at = (key: string) => `${name}/${key}`;
      const store: BlobStore = {
        async put(key, bytes) {
          if (bytes.length > maxBytes) throw new Error("too large");
          data.set(at(key), bytes.slice());
        },
        async get(key) {
          const bytes = data.get(at(key));
          return bytes === undefined ? undefined : { bytes: bytes.slice() };
        },
        async delete(key) {
          data.delete(at(key));
        },
        async list(prefix) {
          const entries = [...data.entries()].filter(([k]) => k.startsWith(at(prefix))).map(([k, v]) => ({ key: k.slice(name.length + 1), size: v.length }));
          entries.sort((a, b) => (a.key < b.key ? -1 : 1));
          return { entries };
        },
      };
      return store;
    },
  };
  const component = defineComponent({
    name: "blob-test",
    setup(pikit) {
      pikit.provide("storage.blob", storage);
    },
  });
  return { data, storage, component };
}

export async function started(config: Record<string, unknown> = {}, options: { clock?: Clock; providers?: ComponentDefinition[]; root?: string; fake?: FakeBoat; key?: string | undefined } = {}): Promise<Started> {
  const root = options.root ?? temporaryDir();
  const clock = options.clock ?? systemClock;
  const fake = options.fake ?? new FakeBoat(join(root, "vms"), KEY, clock);
  const proc = join(root, "proc");
  mkdirSync(proc, { recursive: true });
  let found: { execution: ExecutionEnv; workspace: WorkspaceProvider } | undefined;
  const reader = defineComponent({
    name: "execution-reader",
    setup(pikit) {
      const execution = pikit.use("execution");
      const workspace = pikit.use("workspace");
      return { start: () => void (found = { execution: execution.get(), workspace: workspace.get() }) };
    },
  });
  const logs: Log[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, ...(fields !== undefined && { fields }) });
  const logger: Logger = { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
  const app = await defineApp({
    components: [
      secretsOf({ BOAT_API_KEY: "key" in options ? options.key : KEY }),
      ...(options.providers ?? []),
      createExecutionBoat({ fetch: fake.fetch, paths: FakeBoat.paths(join(root, "vms")), pollMs: 5, proc }),
      reader,
    ],
    config: { "execution-boat": { ...config } },
    logger,
    clock,
  }).create();
  await app.start();
  if (found === undefined) throw new Error("execution was not resolved");
  const ws = found.workspace;
  return { app, fake, root, proc, ...found, env: async (id, agent) => (await ws.resolve(ref(id, agent), app.context())).env, logs };
}

async function run(env: ExecutionEnv, command: string | string[], options: Parameters<ExecutionEnv["exec"]>[1] = {}, context = ctx) {
  const output = { stdout: "", stderr: "" };
  const result = await env.exec(command, { ...options, onOutput: (text, c, info) => {
    output[info.stream] += text;
    options?.onOutput?.(text, c, info);
  } }, context);
  return { result, ...output };
}

const stopApp = async (s: Started) => {
  await s.app.stop();
  await s.fake.settle();
};

// pi-durable's ExecutionEnv contract (and pikit's cases) on a conversation's VM: files and a real shell.
for (const c of createDurableExecutionConformance(async () => {
  const s = await started();
  return { env: await s.env("1"), dispose: () => stopApp(s) };
}, { expect, shell: true, watch: false, symlinks: true })) {
  test(`execution-boat ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs ?? 20_000);
}

for (const c of createWorkspaceConformance(async () => {
  const s = await started();
  return { provider: s.workspace, dispose: () => stopApp(s) };
})) {
  test(`execution-boat ${c.group}: ${c.name}`, () => c.run(), 20_000);
}

for (const c of createLifecycleConformance(() => ({
  component: createExecutionBoat({ fetch: new FakeBoat(temporaryDir(), KEY, systemClock).fetch }),
  config: { "execution-boat": {} },
  providers: [secretsOf({ BOAT_API_KEY: KEY })],
}))) {
  test(`execution-boat ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secretsOf({}), createExecutionBoat()], logger: { debug() {}, info() {}, warn() {}, error() {} } }).create();
  expect(app.describe().components.find((c) => c.name === "execution-boat")).toEqual({
    name: "execution-boat",
    provides: ["execution", "execution.shell", "workspace"],
    requires: ["secrets"],
    optional: ["storage.blob"],
  });
});

test("a chat's agent gets a VM of its own, labelled, made noEnv, with its files at <home>/workspace", async () => {
  const s = await started();
  const one = await s.env("1");
  expect((await one.writeFile("notes/a.txt", "one's", ctx)).ok).toBe(true);
  const [vm] = s.fake.of(workspace("1"));
  expect(vm?.labels).toEqual({ "pikit-gateway": "pikit", "pikit-workspace": workspace("1"), "pikit-agent": "support" });
  expect(readFileSync(join(vm?.dir as string, "home", "workspace", "notes", "a.txt"), "utf8")).toBe("one's");
  const create = s.fake.calls.find((call) => call.method === "POST" && call.path === "/sandboxes");
  expect(create?.body).toMatchObject({ type: "small", noEnv: true, ttlSeconds: 3600 });
  expect(Object.keys(create?.body as object)).not.toContain("env");
  await stopApp(s);
});

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const IDLE = 600 * SECOND;

const until = async (condition: () => boolean | Promise<boolean>, what = "a condition", ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const stateOf = (s: Started, id: string, agent = "support") => s.fake.of(workspace(id, agent)).map((vm) => vm.state);
const text = async (env: ExecutionEnv, path: string) => {
  const read = await env.readTextFile(path, ctx);
  return read.ok ? read.value : `error ${read.error.code}: ${read.error.message}`;
};

// --- Keying: a VM per chat and agent -------------------------------------------------------------

test("keyed by chat and agent: a reset and a same-agent delegated child share the VM; another chat or agent gets its own", async () => {
  const s = await started();
  const parent = (await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1", channel: "telegram" }, s.app.context())).env;
  expect((await parent.writeFile("a.txt", "chat 1", ctx)).ok).toBe(true);
  // /new: a new conversationId under the same key; conversationId and channel choose nothing.
  const reset = (await s.workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "9" }, s.app.context())).env;
  expect(await text(reset, "a.txt")).toBe("chat 1");
  const child = (await s.workspace.resolve({ key: "delegate:1:x:t", agent: "support", conversationId: "c", origin: { key: "telegram:1", agent: "orchestrator", conversationId: "1" } }, s.app.context())).env;
  expect(await text(child, "a.txt")).toBe("chat 1");
  const otherChat = (await s.workspace.resolve({ key: "telegram:2", agent: "support", conversationId: "2" }, s.app.context())).env;
  const otherAgent = (await s.workspace.resolve({ key: "telegram:1", agent: "ops", conversationId: "1" }, s.app.context())).env;
  expect(await otherChat.exists("a.txt", ctx)).toEqual({ ok: true, value: false });
  expect(await otherAgent.exists("a.txt", ctx)).toEqual({ ok: true, value: false });
  expect(s.fake.sandboxes.size).toBe(3);
  expect(child.id).toBe(`execution-boat:${workspaceOf("telegram:1", "support")}`);
  await stopApp(s);
});

test("unsafe agent names and empty chat keys are refused before any call", async () => {
  const s = await started();
  for (const agent of ["../x", "Dev", "", "a/b"]) {
    await expect(s.workspace.resolve({ key: "k", agent, conversationId: "1" }, s.app.context())).rejects.toThrow(/not an agent's name/);
  }
  await expect(s.workspace.resolve({ key: "", agent: "support", conversationId: "1" }, s.app.context())).rejects.toThrow(/non-empty key/);
  expect(s.fake.calls.filter((call) => call.path.startsWith("/sandboxes/") || call.method === "POST")).toEqual([]);
  await stopApp(s);
});

test("the machine is the agent's profile, field by field over the base; an agent it does not name gets the base", async () => {
  const s = await started({ size: "default", agents: { designer: { size: "large", template: "designer" }, writer: { template: "writer-tools" } } });
  mkdirSync(join(s.root, "templates", "designer", "workspace"), { recursive: true });
  writeFileSync(join(s.root, "templates", "designer", "workspace", "fonts.txt"), "prepared");
  s.fake.templates.set("designer", join(s.root, "templates", "designer"));
  s.fake.templates.set("writer-tools", join(s.root, "templates", "designer"));
  const designer = await s.env("1", "designer");
  expect(await text(designer, "fonts.txt")).toBe("prepared");
  await (await s.env("1", "writer")).exists(".", ctx);
  await (await s.env("1", "support")).exists(".", ctx);
  await (await s.env("1", "constructor")).exists(".", ctx);
  const creates = s.fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").map((call) => call.body as Record<string, unknown>);
  expect(creates.map((body) => [body.labels && (body.labels as Record<string, string>)["pikit-agent"], body.type, body.from])).toEqual([
    ["designer", "large", "designer"],
    ["writer", "default", "writer-tools"],
    ["support", "default", undefined],
    ["constructor", "default", undefined],
  ]);
  await stopApp(s);
});

// --- No secrets, no promised egress, the key ------------------------------------------------------

test("a profile (or the base) asking for secrets or allowedHosts is refused at setup, saying why", async () => {
  await expect(started({ agents: { developer: { secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com"] }] } } })).rejects.toThrow(/"developer" asks for secrets: no secret reaches a boat VM/);
  await expect(started({ secrets: [{ name: "X", hosts: ["x"] }] })).rejects.toThrow(/base machine asks for secrets/);
  await expect(started({ agents: { analyst: { allowedHosts: ["*.googleapis.com"] } } })).rejects.toThrow(/boat cannot restrict a VM's network/);
  await expect(started({ allowedHosts: [] })).rejects.toThrow(/allowedHosts/);
  // An empty list asks for nothing.
  await stopApp(await started({ agents: { developer: { secrets: [] } } }));
});

test("start refuses without the API key; snapshots without storage.blob", async () => {
  const why = (attempt: Promise<unknown>) => attempt.then(() => "started", (error: unknown) => String(((error as Error).cause as Error | undefined)?.message));
  expect(await why(started({}, { key: undefined }))).toMatch(/BOAT_API_KEY \(boat's API key\) is not set/);
  expect(await why(started({ snapshots: true }))).toMatch(/no storage.blob provider/);
});

test("the API key goes to boat's API only: never to a signed file URL, a VM, a log or an error", async () => {
  const s = await started();
  const env = await s.env("1");
  const big = "x".repeat(200 * 1024);
  expect((await env.writeFile("big.txt", big, ctx)).ok).toBe(true);
  expect(await text(env, "big.txt")).toBe(big);
  const seen = await run(env, "env");
  expect(seen.stdout).not.toContain(KEY);
  expect(s.fake.leaks).toEqual([]);
  expect(JSON.stringify(s.fake.calls)).not.toContain(KEY);
  // boat echoing the key in an error: redacted before it leaves the client.
  s.fake.override = { method: "POST", path: /\/commands$/, answer: () => failure(400, "bad_request", `the key ${KEY} is wrong`) };
  const failed = await env.readTextFile("big.txt", ctx);
  expect(failed.ok).toBe(false);
  const message = failed.ok ? "" : failed.error.message;
  expect(message).toContain("[redacted]");
  expect(message).not.toContain(KEY);
  const exec = await run(env, "true");
  expect(exec.result.ok ? "" : exec.result.error.message).not.toContain(KEY);
  s.fake.override = undefined;
  expect(JSON.stringify(s.logs)).not.toContain(KEY);
  await stopApp(s);
});

// --- Lifecycle on a manual clock ------------------------------------------------------------------

test("idle: stopped after idleSeconds with nothing running, resumed by the next use with its files (resume latency logged)", async () => {
  const clock = createManualClock();
  const s = await started({}, { clock });
  s.fake.resumeMs = 80;
  const env = await s.env("1");
  expect((await env.writeFile("kept.txt", "before the stop", ctx)).ok).toBe(true);
  await clock.advance(IDLE - 60 * SECOND);
  await Bun.sleep(50);
  expect(stateOf(s, "1")).toEqual(["ready"]);
  await clock.advance(60 * SECOND);
  await until(() => stateOf(s, "1")[0] === "archived", "the idle stop");
  expect(s.fake.count("POST", /\/stop$/)).toBe(1);
  expect(await text(env, "kept.txt")).toBe("before the stop");
  expect(s.fake.count("POST", /\/resume$/)).toBe(1);
  expect((s.fake.calls.find((call) => call.path.endsWith("/resume"))?.body as Record<string, unknown>).noEnv).toBe(true);
  const resumed = s.logs.find((log) => log.message === "execution-boat: VM resumed");
  expect(resumed?.fields?.ms as number).toBeGreaterThanOrEqual(80);
  await stopApp(s);
});

test("idle stop never during a command: a long command keeps its VM, which stops once idle after it", async () => {
  const clock = createManualClock();
  const s = await started({}, { clock });
  const env = await s.env("1");
  const running = run(env, "sleep 1; echo done");
  await until(() => (s.fake.of(workspace("1"))[0]?.processes.size ?? 0) > 0, "the command");
  await clock.advance(2 * IDLE);
  await Bun.sleep(100);
  expect(stateOf(s, "1")).toEqual(["ready"]);
  const done = await running;
  expect(done.result).toEqual({ ok: true, value: { exitCode: 0 } });
  expect(done.stdout).toBe("done\n");
  await clock.advance(IDLE);
  await until(() => stateOf(s, "1")[0] === "archived", "the idle stop after the command");
  await stopApp(s);
});

test("idle stop never while a process a command left is running (marked PIKIT_BOAT_COMMAND, found in /proc)", async () => {
  const clock = createManualClock();
  const s = await started({}, { clock });
  const env = await s.env("1");
  const marker = await run(env, 'printf %s "$PIKIT_BOAT_COMMAND"');
  expect(marker.stdout).toBe("1");
  // What `sleep 600 &` leaves in a VM: a process whose environment carries the marker.
  mkdirSync(join(s.proc, "4242"), { recursive: true });
  writeFileSync(join(s.proc, "4242", "environ"), "PATH=/usr/bin\0PIKIT_BOAT_COMMAND=1\0HOME=/home/user\0");
  mkdirSync(join(s.proc, "4243"), { recursive: true });
  writeFileSync(join(s.proc, "4243", "environ"), "PATH=/usr/bin\0NOT_PIKIT_BOAT_COMMAND=1\0");
  await clock.advance(IDLE);
  await until(() => s.logs.some((log) => log.message.includes("left processes running; kept")), "the probe");
  expect(stateOf(s, "1")).toEqual(["ready"]);
  expect(s.logs.find((log) => log.message.includes("left processes running"))?.fields?.processes).toBe(1);
  rmSync(join(s.proc, "4242"), { recursive: true });
  await clock.advance(30 * SECOND);
  await until(() => stateOf(s, "1")[0] === "archived", "the stop once the process ended");
  await stopApp(s);
});

test("retention: a VM stopped for retentionDays is deleted (and only then); the next use gets a new, empty one", async () => {
  const clock = createManualClock();
  const s = await started({ retentionDays: 2 }, { clock });
  const env = await s.env("1");
  await env.writeFile("old.txt", "x", ctx);
  await clock.advance(IDLE);
  await until(() => stateOf(s, "1")[0] === "archived", "the idle stop");
  const fresh = await s.env("2");
  await fresh.writeFile("new.txt", "y", ctx);
  await clock.advance(DAY + HOUR);
  await Bun.sleep(100);
  expect(stateOf(s, "1")).toEqual(["archived"]);
  await clock.advance(DAY);
  await until(() => stateOf(s, "1").length === 0, "the deletion");
  expect(s.fake.count("DELETE", /^\/sandboxes\/[^/]+$/)).toBe(1);
  expect(s.logs.some((log) => log.message === "execution-boat: deleted VMs unused for retentionDays" && log.fields?.vms === 1)).toBe(true);
  // VM 2 was used more recently: stopped, kept.
  expect(stateOf(s, "2")).toEqual(["archived"]);
  expect(await env.exists("old.txt", ctx)).toEqual({ ok: true, value: false });
  expect(stateOf(s, "1")).toEqual(["ready"]);
  await stopApp(s);
});

test("a use that arrives while its VM is being deleted waits, then works in a new VM", async () => {
  const clock = createManualClock();
  const s = await started({ retentionDays: 1 }, { clock });
  const env = await s.env("1");
  await env.writeFile("old.txt", "x", ctx);
  await clock.advance(IDLE);
  await until(() => stateOf(s, "1")[0] === "archived", "the idle stop");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let deleting = false;
  const original = s.fake.fetch;
  s.fake.override = {
    method: "DELETE",
    path: /^\/sandboxes\/[^/]+$/,
    answer: async () => {
      deleting = true;
      await held;
      s.fake.override = undefined;
      return original(`https://boat.dev/api/v1/sandboxes/${s.fake.of(workspace("1"))[0]?.id}`, { method: "DELETE", headers: { authorization: `Bearer ${KEY}`, "x-ascii-confirm-delete": s.fake.of(workspace("1"))[0]?.id as string } });
    },
  };
  await clock.advance(DAY + HOUR);
  await until(() => deleting, "the deletion to start");
  const write = env.writeFile("new.txt", "after", ctx);
  await Bun.sleep(50);
  release();
  expect((await write).ok).toBe(true);
  expect(await text(env, "new.txt")).toBe("after");
  expect(await env.exists("old.txt", ctx)).toEqual({ ok: true, value: false });
  expect(s.fake.of(workspace("1")).length).toBe(1);
  await stopApp(s);
});

test("a restarted gateway adopts the VMs it left running, and stops them once idle", async () => {
  const clock = createManualClock();
  const root = temporaryDir();
  const first = await started({}, { clock, root });
  await (await first.env("1")).writeFile("a.txt", "x", ctx);
  await first.app.stop();
  const second = await started({}, { clock, root, fake: first.fake });
  await until(() => second.logs.some((log) => log.message === "execution-boat: retention sweep" && log.fields?.adopted === 1), "the adoption");
  await clock.advance(IDLE);
  await until(() => stateOf(second, "1")[0] === "archived", "the adopted VM's idle stop");
  await stopApp(second);
});

// --- Bounds ---------------------------------------------------------------------------------------

test("maxVms: a new VM stops the idlest; when all are in use, the use waits queueSeconds, then fails saying so", async () => {
  const s = await started({ maxVms: 1, queueSeconds: 0.3 });
  const one = await s.env("1");
  const two = await s.env("2");
  await one.writeFile("a.txt", "1", ctx);
  await two.writeFile("b.txt", "2", ctx);
  expect(stateOf(s, "1")).toEqual(["archived"]);
  expect(stateOf(s, "2")).toEqual(["ready"]);
  const controller = new AbortController();
  const long = run(two, "sleep 5", {}, withAbortSignal(controller.signal, ctx));
  await until(() => (s.fake.of(workspace("2"))[0]?.processes.size ?? 0) > 0, "the long command");
  const began = Date.now();
  const read = await one.readTextFile("a.txt", ctx);
  expect(Date.now() - began).toBeGreaterThanOrEqual(250);
  expect(read.ok ? "" : read.error.message).toMatch(/all 1 VMs \(maxVms\) are in use/);
  const exec = await one.exec("true", undefined, ctx);
  expect(exec.ok ? "" : exec.error.code).toBe("spawn_error");
  controller.abort();
  const stopped = (await long).result;
  expect(stopped.ok ? "ok" : stopped.error.code).toBe("aborted");
  expect(await text(one, "a.txt")).toBe("1");
  await stopApp(s);
});

test("every boat call has a deadline: an API that never answers fails the call after callSeconds", async () => {
  const s = await started({ callSeconds: 1 });
  const env = await s.env("1");
  await env.writeFile("a.txt", "x", ctx);
  s.fake.hang = true;
  const began = Date.now();
  const read = await env.readTextFile("a.txt", ctx);
  expect(Date.now() - began).toBeLessThan(8000);
  expect(read.ok ? "" : read.error.message).toMatch(/no answer within/);
  const exec = await env.exec("true", undefined, ctx);
  expect(exec.ok ? "" : exec.error.code).toBe("shell_unavailable");
  s.fake.hang = false;
  await stopApp(s);
}, 20_000);

test("a boat outage: commands answer shell_unavailable, files unknown, each saying why; the next use tries again", async () => {
  const s = await started();
  const env = await s.env("1");
  s.fake.down = true;
  const exec = await env.exec("echo hi", undefined, ctx);
  expect(exec.ok ? "" : `${exec.error.code}: ${exec.error.message}`).toMatch(/^shell_unavailable: .*boat API unreachable/);
  const read = await env.readTextFile("a.txt", ctx);
  expect(read.ok ? "" : `${read.error.code}: ${read.error.message}`).toMatch(/^unknown: .*boat API unreachable/);
  s.fake.down = false;
  expect((await run(env, "echo back")).stdout).toBe("back\n");
  await stopApp(s);
});

test("a malformed answer is an error, never a guess", async () => {
  const s = await started();
  const env = await s.env("1");
  s.fake.override = { method: "GET", path: /^\/sandboxes$/, answer: () => json(200, { ok: true, items: [] }) };
  const read = await env.readTextFile("a.txt", ctx);
  expect(read.ok ? "" : read.error.message).toMatch(/malformed|without `sandboxes`/);
  s.fake.override = undefined;
  await env.writeFile("a.txt", "x", ctx);
  s.fake.override = { method: "GET", path: /\/commands\/[0-9]+$/, answer: () => json(200, { ok: true, running: "yes" }) };
  const exec = await env.exec("echo hi", undefined, ctx);
  expect(exec.ok ? "" : `${exec.error.code}: ${exec.error.message}`).toMatch(/^shell_unavailable: .*status without its state/);
  s.fake.override = { method: "POST", path: /\/commands$/, answer: () => json(200, { ok: true, stdout: 5 }) };
  const info = await env.fileInfo("a.txt", ctx);
  expect(info.ok ? "" : info.error.message).toMatch(/without its exit code/);
  s.fake.override = undefined;
  await stopApp(s);
});

// --- Portability: the shared snapshot format ------------------------------------------------------

const prefixOf = (id: string, agent = "support") => workspace(id, agent);
const manifestOf = (data: Map<string, Uint8Array>, id: string) => {
  const bytes = data.get(`workspace-snapshots/${prefixOf(id)}/manifest.json`);
  return bytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
};

/** The names in a gzip'd tar, read by the system's tar. */
function namesIn(bytes: Uint8Array): string[] {
  const file = join(temporaryDir(), "a.tar.gz");
  writeFileSync(file, bytes);
  const listed = spawnSync("tar", ["-t", "-z", "-f", file]);
  return String(listed.stdout).split("\n").filter((line) => line !== "").map((line) => line.replace(/\/$/, "")).sort();
}

test("snapshots: an idle stop exports the workspace in the shared format; a VM deleted by retention comes back from it", async () => {
  const clock = createManualClock();
  const blob = memoryBlob();
  const s = await started({ snapshots: true, retentionDays: 1 }, { clock, providers: [blob.component] });
  const env = await s.env("1");
  await env.writeFile("notes/a.txt", "kept", ctx);
  const made = await run(env, "ln -s notes/a.txt inside && ln -s /etc/hosts outside && ln -s ../.. up && mkfifo fifo");
  expect(made.result).toEqual({ ok: true, value: { exitCode: 0 } });
  await clock.advance(IDLE);
  await until(() => stateOf(s, "1")[0] === "archived", "the idle stop");

  const manifest = manifestOf(blob.data, "1");
  expect(manifest).toMatchObject({ version: 1, agent: "support", createdAt: clock.now() });
  const object = String(manifest?.object);
  expect(object).toMatch(new RegExp(`^${prefixOf("1")}/snapshot-${clock.now()}-[0-9a-f]{16}\\.tar\\.gz$`));
  const archive = blob.data.get(`workspace-snapshots/${object}`) as Uint8Array;
  expect(manifest?.size).toBe(archive.length);
  expect(manifest?.sha256).toBe(new Bun.CryptoHasher("sha256").update(archive).digest("hex"));
  expect(object).toContain(String(manifest?.sha256).slice(0, 16));
  // Relative paths, the workspace's contents only; links out and the FIFO left out.
  expect(namesIn(archive)).toEqual(["inside", "notes", "notes/a.txt"]);
  expect(s.logs.find((log) => log.message === "execution-boat: workspace exported")?.fields).toMatchObject({ skipped: 3 });

  await clock.advance(DAY + HOUR);
  await until(() => stateOf(s, "1").length === 0, "the deletion");
  // Saved after the VM's last start: deleted without resuming it.
  expect(s.fake.count("POST", /\/resume$/)).toBe(0);
  expect(await text(env, "notes/a.txt")).toBe("kept");
  expect(await text(env, "inside")).toBe("kept");
  expect(s.fake.of(workspace("1")).length).toBe(1);
  expect(s.logs.some((log) => log.message === "execution-boat: workspace restored from its snapshot")).toBe(true);

  // The next export supersedes the first archive, deleted once the new manifest is written.
  await env.writeFile("notes/b.txt", "later", ctx);
  await clock.advance(IDLE);
  await until(() => stateOf(s, "1")[0] === "archived", "the second stop");
  const archives = [...blob.data.keys()].filter((key) => key.startsWith(`workspace-snapshots/${prefixOf("1")}/snapshot-`));
  expect(archives).toEqual([`workspace-snapshots/${String(manifestOf(blob.data, "1")?.object)}`]);
  expect(archives[0]).not.toBe(`workspace-snapshots/${object}`);
  await stopApp(s);
});

test("snapshots: a workspace that could not be exported is never deleted unsaved (the VM stays the truth)", async () => {
  const clock = createManualClock();
  const blob = memoryBlob(10);
  const s = await started({ snapshots: true, retentionDays: 1 }, { clock, providers: [blob.component] });
  const env = await s.env("1");
  await env.writeFile("a.txt", "too big for a 10-byte store", ctx);
  await clock.advance(IDLE);
  await until(() => stateOf(s, "1")[0] === "archived", "the idle stop");
  expect(s.logs.some((log) => log.message.includes("could not be exported before its VM stopped") && String(log.fields?.reason).includes("maxBytes"))).toBe(true);
  await clock.advance(DAY + HOUR);
  await until(() => s.logs.some((log) => log.message === "execution-boat: a VM past retentionDays was kept"), "the kept VM");
  // Resumed to export again, which failed: stopped again, not deleted.
  expect(s.fake.count("POST", /\/resume$/)).toBe(1);
  expect(s.fake.count("DELETE", /^\/sandboxes\/[^/]+$/)).toBe(0);
  expect(stateOf(s, "1")).toEqual(["archived"]);
  expect(manifestOf(blob.data, "1")).toBeUndefined();
  await stopApp(s);
});

test("snapshots: a workspace with no VM is restored from another backend's snapshot; one escaping the root is refused and no VM kept", async () => {
  const blob = memoryBlob();
  const s = await started({ snapshots: true }, { providers: [blob.component] });
  const put = async (id: string, archive: Uint8Array) => {
    const sha256 = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
    const object = `${prefixOf(id)}/snapshot-1000-${sha256.slice(0, 16)}.tar.gz`;
    blob.data.set(`workspace-snapshots/${object}`, archive);
    blob.data.set(`workspace-snapshots/${prefixOf(id)}/manifest.json`, new TextEncoder().encode(JSON.stringify({ version: 1, object, sha256, size: archive.length, createdAt: 1000, agent: "support" })));
  };
  await put("1", tarGz([{ name: "src/", type: "5" }, { name: "src/main.py", content: "print('from gondolin')\n" }, { name: "main", type: "2", linkname: "src/main.py" }]));
  const env = await s.env("1");
  expect(await text(env, "src/main.py")).toBe("print('from gondolin')\n");
  expect(await text(env, "main")).toBe("print('from gondolin')\n");

  await put("2", tarGz([{ name: "ok.txt", content: "x" }, { name: "../escaped.txt", content: "evil" }]));
  const refused = await (await s.env("2")).readTextFile("ok.txt", ctx);
  expect(refused.ok ? "" : refused.error.message).toMatch(/snapshot could not be restored, so no VM was kept: .*refused/);
  expect(s.fake.of(workspace("2"))).toEqual([]);
  // A tampered archive (its sha256 no longer the manifest's): refused the same way.
  await put("3", tarGz([{ name: "a", content: "a" }]));
  blob.data.set(`workspace-snapshots/${String(manifestOf(blob.data, "3")?.object)}`, tarGz([{ name: "a", content: "b" }]));
  const tampered = await (await s.env("3")).exists("a", ctx);
  expect(tampered.ok ? "" : tampered.error.message).toMatch(/does not match its manifest|its manifest says/);
  expect(s.fake.of(workspace("3"))).toEqual([]);
  await stopApp(s);
});
