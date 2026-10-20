/**
 * execution-remote's tests. They are copied with the component and keep running in your project.
 *
 * The sandbox host is a fake speaking the protocol (`protocol.ts`) on a local `Bun.serve`, so each
 * test decides what the host answers and sees every request: which sandbox, which operation, what
 * body, which token, which agent (`Pikit-Agent`). The registry's own test (`app.test.ts`, beside `files/`) runs the component
 * against a real execution-serve, under pi-durable's `ExecutionEnv` suite; the workerd lane runs it in
 * a Durable Object.
 */

import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { SecretStore } from "@pikit/contracts";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { withAbortSignal } from "@pikit/pi-adapter/execution";
import executionRemote, { keySandbox, objectSandbox } from "./index.ts";
import { AGENT_HEADER, MAX_AGENT_LENGTH, PROTOCOL_PATH, PROTOCOL_STATUS, type ProtocolErrorCode, type WireExecState } from "./protocol.ts";

const ctx = BACKGROUND_CONTEXT;
const TOKEN = "execution-remote-test-token-0123456789";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

type Seen = { sandbox: string; operation: string; body: Record<string, unknown>; authorization: string | null; agent: string | null };
type Reply = unknown | { status: ProtocolErrorCode; message?: string } | (() => unknown);

/** A fake sandbox host: `replies[operation]` answers (a value is `{ ok: true, value }`), in turn when it is a list. */
function fakeHost(replies: Record<string, Reply | Reply[]>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const [sandbox = "", operation = ""] = new URL(request.url).pathname.slice(PROTOCOL_PATH.length + 1).split("/");
      const body = (await request.json()) as Record<string, unknown>;
      seen.push({ sandbox, operation, body, authorization: request.headers.get("authorization"), agent: request.headers.get(AGENT_HEADER) });
      const listed = replies[operation];
      let reply = Array.isArray(listed) ? (listed.length > 1 ? listed.shift() : listed[0]) : listed;
      if (typeof reply === "function") reply = await (reply as () => unknown)();
      if (reply === undefined) return Response.json({ error: { code: "unknown_operation", message: operation } }, { status: 404 });
      if (typeof reply === "object" && reply !== null && "status" in reply) {
        const { status, message } = reply as { status: ProtocolErrorCode; message?: string };
        return Response.json({ error: { code: status, message: message ?? status } }, { status: PROTOCOL_STATUS[status] });
      }
      return Response.json({ ok: true, value: reply });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const OPEN = { cwd: "/work", home: "/home/agent" };
const ended = (command: string, exitCode = 0, chunks: WireExecState["chunks"] = []): WireExecState => ({ command, chunks, next: chunks.length, done: { ok: true, value: { exitCode } } });

async function started(endpoint: string, options: { values?: Record<string, string>; config?: Record<string, unknown>; object?: string } = {}) {
  let execution: Handle<ExecutionEnv> | undefined;
  let workspace: Handle<WorkspaceProvider> | undefined;
  const reader = defineComponent({
    name: "reader-test",
    setup(pikit) {
      execution = pikit.use("execution.shell");
      workspace = pikit.use("workspace");
    },
  });
  const object = options.object === undefined ? undefined : { id: options.object, storage: {}, onAlarm() {}, onDeliver() {} };
  const remote = object === undefined ? [executionRemote] : withWorkersHost({ env: {}, object }, [executionRemote]);
  const app = await defineApp({
    components: [secrets(options.values ?? { PIKIT_SANDBOX_TOKEN: TOKEN }), ...remote, reader],
    config: { "execution-remote": { endpoint, ...options.config } },
    logger: silentLogger,
  }).create();
  await app.start();
  cleanup.push(() => app.stop());
  return { app, execution: (execution as Handle<ExecutionEnv>).get(), workspace: (workspace as Handle<WorkspaceProvider>).get() };
}

async function startError(endpoint: string, options: { values?: Record<string, string>; host?: Parameters<typeof withWorkersHost>[0] } = {}) {
  const remote = options.host === undefined ? [executionRemote] : withWorkersHost(options.host, [executionRemote]);
  const app = await defineApp({ components: [secrets(options.values ?? { PIKIT_SANDBOX_TOKEN: TOKEN }), ...remote], config: { "execution-remote": { endpoint } }, logger: silentLogger }).create();
  return app.start().then(
    () => app.stop().then(() => "started"),
    (error: unknown) => String((error as Error).cause),
  );
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secrets({}), executionRemote], config: { "execution-remote": { endpoint: "https://sandbox.example.com" } }, logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "execution-remote")).toEqual({
    name: "execution-remote",
    provides: ["execution", "execution.shell", "workspace"],
    requires: ["secrets"],
    optional: [],
  });
});

test("it refuses to start without its token, with a short one, over http to another machine, or in the Worker's App", async () => {
  expect(await startError("https://sandbox.example.com", { values: {} })).toContain("the secret PIKIT_SANDBOX_TOKEN is not set");
  const short = await startError("https://sandbox.example.com", { values: { PIKIT_SANDBOX_TOKEN: "short-token" } });
  expect(short).toContain("shorter than 32 characters");
  expect(short).not.toContain("short-token");
  expect(await startError("http://sandbox.example.com")).toContain("must be https://");
  expect(await startError("https://user:pass@sandbox.example.com")).toContain("credentials");
  expect(await startError("http://127.0.0.1:1")).toBe("started");
  expect(await startError("https://sandbox.example.com", { host: { env: {} } })).toContain("WORKERS_HOST has no object");
});

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("on a server, a conversation's sandbox is k-<SHA-256 of its chat's key and agent>, the same through resets, every request naming the agent; execution alone works in `sandbox`, naming none", async () => {
  const host = fakeHost({ open: OPEN, exists: true });
  const { workspace, execution } = await started(host.url, { config: { sandbox: "tools" } });

  const env = (await workspace.resolve({ key: "telegram:42", agent: "assistant", conversationId: "c-1" }, ctx)).env;
  await env.exists("x", ctx);
  const reset = (await workspace.resolve({ key: "telegram:42", agent: "assistant", conversationId: "c-2" }, ctx)).env;
  await (await workspace.resolve({ key: "telegram:42", agent: "other", conversationId: "c-1" }, ctx)).env.exists("x", ctx);
  await execution.exists("x", ctx);

  const sandbox = await keySandbox("telegram:42", "assistant");
  const other = await keySandbox("telegram:42", "other");
  expect(sandbox).toBe(`k-${sha256("telegram:42\nassistant")}`);
  expect(other).toBe(`k-${sha256("telegram:42\nother")}`);
  expect(reset).toBe(env);
  expect(host.seen.map((request) => `${request.sandbox} ${request.operation} ${request.agent}`)).toEqual([
    `${sandbox} open assistant`,
    `${sandbox} exists assistant`,
    `${other} open other`,
    `${other} exists other`,
    "tools open null",
    "tools exists null",
  ]);
  expect(env.cwd).toBe("/work");
});

test("on a server, a delegated child works in its chat's sandbox (its origin's key): its parent's when of the same agent, its own agent's of the chat otherwise", async () => {
  const host = fakeHost({ open: OPEN, exists: true });
  const { workspace } = await started(host.url);
  const origin = { key: "gchat:spaces/AAA", agent: "assistant", conversationId: "c-1", channel: "google-chat" };

  const parent = (await workspace.resolve(origin, ctx)).env;
  const same = (await workspace.resolve({ key: "delegate:1:assistant:t-1", agent: "assistant", conversationId: "c-2", channel: "delegate", origin }, ctx)).env;
  const deeper = (await workspace.resolve({ key: "delegate:2:assistant.assistant:t-2", agent: "assistant", conversationId: "c-3", channel: "delegate", origin }, ctx)).env;
  const helper = (await workspace.resolve({ key: "delegate:1:assistant:t-3", agent: "helper", conversationId: "c-4", channel: "delegate", origin }, ctx)).env;
  const otherChat = (await workspace.resolve({ key: "delegate:1:assistant:t-1", agent: "assistant", conversationId: "c-5", channel: "delegate", origin: { ...origin, key: "gchat:spaces/BBB" } }, ctx)).env;
  await helper.exists("x", ctx);

  expect(same).toBe(parent);
  expect(deeper).toBe(parent);
  expect(helper).not.toBe(parent);
  expect(otherChat).not.toBe(parent);
  const sandbox = `k-${sha256("gchat:spaces/AAA\nassistant")}`;
  expect(parent.id).toBe(`execution-remote:${host.url}#${sandbox}`);
  expect(host.seen.map((request) => `${request.sandbox} ${request.operation} ${request.agent}`)).toEqual([
    `${sandbox} open assistant`,
    `k-${sha256("gchat:spaces/AAA\nhelper")} open helper`,
    `k-${sha256("gchat:spaces/BBB\nassistant")} open assistant`,
    `k-${sha256("gchat:spaces/AAA\nhelper")} exists helper`,
  ]);
});

test("in a Durable Object, each agent of the object has a sandbox of its own, o-<SHA-256 of object id and agent> (a delegated child of another agent too); execution alone works in o-<object id>, naming no agent", async () => {
  const host = fakeHost({ open: OPEN, exists: true });
  const { workspace, execution } = await started(host.url, { object: "a1b2c3" });

  const one = (await workspace.resolve({ key: "telegram:42", agent: "assistant", conversationId: "c-1" }, ctx)).env;
  const child = (await workspace.resolve({ key: "delegate:1:t", agent: "helper", conversationId: "c-2", channel: "delegate" }, ctx)).env;
  const sameAgent = (await workspace.resolve({ key: "delegate:1:u", agent: "assistant", conversationId: "c-3", channel: "delegate" }, ctx)).env;
  await child.exists("x", ctx);
  await execution.exists("x", ctx);

  const sandbox = await objectSandbox("a1b2c3", "assistant");
  expect(sandbox).toBe(`o-${sha256("a1b2c3\nassistant")}`);
  expect(one).not.toBe(execution);
  expect(child).not.toBe(one);
  expect(sameAgent).toBe(one);
  expect(one.id).toBe(`execution-remote:${host.url}#${sandbox}`);
  expect(host.seen.map((request) => `${request.sandbox} ${request.operation} ${request.agent}`)).toEqual([
    `${sandbox} open assistant`,
    `${await objectSandbox("a1b2c3", "helper")} open helper`,
    `${await objectSandbox("a1b2c3", "helper")} exists helper`,
    "o-a1b2c3 open null",
    "o-a1b2c3 exists null",
  ]);
});

test("a conversation whose agent is not an agent's name is refused, and nothing is asked of the host", async () => {
  const host = fakeHost({ open: OPEN });
  const { workspace } = await started(host.url);
  for (const agent of ["", "Bad", "_shared", "a/b", "a\nb", `a${"b".repeat(100)}`]) {
    await expect(workspace.resolve({ key: "telegram:1", agent, conversationId: "c-1" }, ctx)).rejects.toThrow("is not an agent name");
  }
  // The 100-character bound is this component's own (defineAgent has none): 101 is refused, saying so.
  const long = `a${"b".repeat(MAX_AGENT_LENGTH)}`;
  expect(long).toHaveLength(101);
  await expect(workspace.resolve({ key: "telegram:1", agent: long, conversationId: "c-1" }, ctx)).rejects.toThrow(`at most ${MAX_AGENT_LENGTH} characters`);
  expect(host.seen).toEqual([]);
});

test("paths are resolved here and sent absolute: relative, `..`, `~`, `file://`", async () => {
  const host = fakeHost({ open: OPEN, exists: true });
  const { execution } = await started(host.url);
  for (const path of ["notes/a.txt", "notes/../b.txt", "~", "~/c.txt", "file:///srv/d%20e.txt", "/abs//f/./g"]) await execution.exists(path, ctx);

  expect(host.seen.filter((request) => request.operation === "exists").map((request) => request.body.path)).toEqual(["/work/notes/a.txt", "/work/b.txt", "/home/agent", "/home/agent/c.txt", "/srv/d e.txt", "/abs/f/g"]);
  expect(await execution.joinPath(["a", "..", "..", "b"], ctx)).toEqual({ ok: true, value: "../b" });
});

test("the token travels only in the Authorization header; a command's variables are the caller's alone (C7)", async () => {
  const host = fakeHost({ open: OPEN, execStart: () => ended(host.seen.at(-1)?.body.command as string) });
  const { execution } = await started(host.url);

  await execution.exec("env", { env: { ONLY: "this" } }, ctx);

  expect(host.seen.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  expect(host.seen.map((request) => JSON.stringify(request.body)).join("\n")).not.toContain(TOKEN);
  expect(host.seen.at(-1)?.body).toMatchObject({ run: "env", env: { ONLY: "this" }, cwd: "/work" });
});

test("the protocol's failures are results, never throws: 401 permission_denied, no host unknown, a cancelled call aborted", async () => {
  const refusing = fakeHost({ open: { status: "unauthorized" }, execStart: { status: "unauthorized" } });
  const env = (await started(refusing.url)).execution;
  const read = await env.readTextFile("a.txt", ctx);
  expect(read.ok ? "ok" : [read.error.code, read.error.message]).toEqual(["permission_denied", expect.stringContaining("unauthorized")]);
  const run = await env.exec("true", undefined, ctx);
  expect(run.ok ? "ok" : run.error.code).toBe("unknown");

  const nobody = (await started("http://127.0.0.1:9")).execution;
  const unreachable = await nobody.fileInfo("a.txt", ctx);
  expect(unreachable.ok ? "ok" : [unreachable.error.code, unreachable.error.message]).toEqual(["unknown", expect.stringContaining("did not answer")]);

  const controller = new AbortController();
  controller.abort();
  expect(await nobody.fileInfo("a.txt", withAbortSignal(controller.signal, ctx))).toMatchObject({ ok: false, error: { code: "aborted" } });
});

test("a command's output reaches onOutput chunk by chunk, read from the cursor each answer gives, until it ended", async () => {
  let id = "";
  const host = fakeHost({
    open: OPEN,
    execStart: () => {
      id = host.seen.at(-1)?.body.command as string;
      return { command: id, chunks: [{ text: "one\n", stream: "stdout" }], next: 1 };
    },
    execRead: [
      () => ({ command: id, chunks: [{ text: "oops\n", stream: "stderr" }], next: 2 }),
      () => ({ command: id, chunks: [{ text: "tail\n", stream: "stdout", skipped: { bytes: 10, newlines: 2, endsWithNewline: true } }], next: 3, done: { ok: true, value: { exitCode: 3, spillPath: "/tmp/out.log" } } }),
    ],
  });
  const { execution } = await started(host.url);
  const output: unknown[] = [];

  const result = await execution.exec(["make", "it"], { cwd: "sub", onOutput: (text, _context, info) => output.push([text, info]) }, ctx);

  expect(result).toEqual({ ok: true, value: { exitCode: 3, spillPath: "/tmp/out.log" } });
  expect(output).toEqual([
    ["one\n", { stream: "stdout" }],
    ["oops\n", { stream: "stderr" }],
    ["tail\n", { stream: "stdout", skipped: { bytes: 10, newlines: 2, endsWithNewline: true } }],
  ]);
  const reads = host.seen.filter((request) => request.operation === "execRead").map((request) => request.body);
  expect(reads.map((body) => body.cursor)).toEqual([1, 2]);
  expect(reads.every((body) => body.command === id)).toBe(true);
  expect(host.seen.find((request) => request.operation === "execStart")?.body).toMatchObject({ run: ["make", "it"], cwd: "/work/sub" });
});

test("a read that got no answer is retried; a command the host lost is an unknown error", async () => {
  let id = "";
  const host = fakeHost({
    open: OPEN,
    execStart: () => {
      id = host.seen.at(-1)?.body.command as string;
      return { command: id, chunks: [], next: 0 };
    },
    execRead: [{ status: "unavailable" }, { status: "unavailable" }, () => ended(id, 0)],
  });
  const { execution } = await started(host.url);
  expect(await execution.exec("sleep 1", undefined, ctx)).toEqual({ ok: true, value: { exitCode: 0 } });

  const losing = fakeHost({ open: OPEN, execStart: () => ({ command: losing.seen.at(-1)?.body.command, chunks: [], next: 0 }), execRead: { status: "unknown_command" } });
  const lost = await (await started(losing.url)).execution.exec("sleep 1", undefined, ctx);
  expect(lost.ok ? "ok" : [lost.error.code, lost.error.message]).toEqual(["unknown", expect.stringContaining("lost the command")]);
});

test("cancelling stops the command on the host by its id, during its start too; an onOutput that throws stops it as well", async () => {
  const host = fakeHost({
    open: OPEN,
    execStart: async () => {
      await Bun.sleep(5_000);
      return {};
    },
    execKill: () => ({ ...ended(host.seen.at(-1)?.body.command as string), done: { ok: false, error: { code: "aborted", message: "aborted", spillPath: "/tmp/spill.log" } } }),
  });
  const { execution } = await started(host.url);
  const controller = new AbortController();
  const running = execution.exec("sleep 30", undefined, withAbortSignal(controller.signal, ctx));
  await Bun.sleep(100);
  controller.abort();
  const result = await running;

  expect(result.ok ? "ok" : [result.error.code, result.error.spillPath]).toEqual(["aborted", "/tmp/spill.log"]);
  const start = host.seen.find((request) => request.operation === "execStart");
  const kill = host.seen.find((request) => request.operation === "execKill");
  expect(kill?.body.command).toBe(start?.body.command);

  const chatty = fakeHost({ open: OPEN, execStart: () => ({ command: chatty.seen.at(-1)?.body.command, chunks: [{ text: "x", stream: "stdout" }], next: 1 }), execKill: () => ended(chatty.seen.at(-1)?.body.command as string) });
  const thrown = await (await started(chatty.url)).execution.exec(
    "yes",
    {
      onOutput: () => {
        throw new Error("the callback failed");
      },
    },
    ctx,
  );
  expect(thrown.ok ? "ok" : [thrown.error.code, thrown.error.message]).toEqual(["callback_error", "the callback failed"]);
  expect(chatty.seen.map((request) => request.operation)).toEqual(["open", "execStart", "execKill"]);
});

test("a small file comes whole with its opening; a larger one is read on the host in pieces, its reader closed once", async () => {
  const info = { name: "f.bin", path: "/work/f.bin", kind: "file", size: 6, mtimeMs: 1 };
  const host = fakeHost({
    open: OPEN,
    openBinaryReader: [{ info, base64: btoa("abc\ndef") }, { info: { ...info, size: 9_000_000 }, handle: "h1" }],
    readerRead: [{ base64: btoa("x".repeat(3)) }],
    readerClose: null,
  });
  const { execution } = await started(host.url);

  const small = await execution.openBinaryReader("f.bin", undefined, ctx);
  if (!small.ok) throw small.error;
  expect(await small.value.scanLines({ startLine: 1 }, ctx)).toMatchObject({ ok: true, value: { newlines: 1 } });
  await small.value.close(ctx);
  const large = await execution.openBinaryReader("f.bin", undefined, ctx);
  if (!large.ok) throw large.error;
  expect(await large.value.read(0, 5_000_000, ctx)).toMatchObject({ ok: true });
  await large.value.close(ctx);
  await large.value.close(ctx);
  expect(await large.value.read(0, 1, ctx)).toMatchObject({ ok: false, error: { code: "invalid" } });

  expect(host.seen.map((request) => request.operation)).toEqual(["open", "openBinaryReader", "openBinaryReader", "readerRead", "readerClose"]);
  expect(host.seen[1]?.body).toEqual({ path: "/work/f.bin", prefetch: 1024 * 1024 });
});

test("stop stops the commands still running", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const host = fakeHost({
    open: OPEN,
    execStart: async () => {
      await held;
      return {};
    },
    execKill: () => ended(host.seen.at(-1)?.body.command as string),
  });
  const { app, execution } = await started(host.url);
  const running = execution.exec("sleep 30", undefined, ctx);
  await Bun.sleep(50);

  await app.stop();
  release();
  await running;

  expect(host.seen.filter((request) => request.operation === "execKill")).toHaveLength(1);
});
