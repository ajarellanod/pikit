/**
 * execution-serve's tests. They are copied with the component and keep running in your project.
 *
 * The sandboxes are a double of a `workspace` provider keyed as execution-gondolin's is: a directory
 * per `ConversationRef.conversationId` alone, which must be `^[A-Za-z0-9_-]{1,128}$` (else it
 * throws), over pi-durable's local environment in a temporary directory, recording every ref it is
 * asked for. Requests go to the route itself, as server-bun hands them over.
 * `execution-remote`'s registry test runs the whole protocol end to end, through HTTP, under
 * pi-durable's `ExecutionEnv` suite.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ConversationRef, HttpRoute, SecretStore } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { toChord, type WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd } from "@pikit/pi-adapter/execution";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { MAX_COMMANDS, SandboxHost, sandboxConversation } from "./host.ts";
import executionServe from "./index.ts";
import { OutputLog } from "./output.ts";
import { MAX_SANDBOX_ID_LENGTH, type Operation, PROTOCOL_PATH, type ProtocolFailure, ROUTE_KEY, type Values, type WireExecState } from "./protocol.ts";

const TOKEN = "execution-serve-test-token-0123456789";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

/** A workspace per `conversationId` alone (execution-gondolin's rule): `<root>/<conversationId>`, over one local environment. Records what it was asked. */
function sandboxes() {
  const root = mkdtempSync(join(tmpdir(), "execution-serve-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const env = createLocalExecution({ cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const asked: ConversationRef[] = [];
  const provider: WorkspaceProvider = {
    async resolve(conversation, context) {
      asked.push(conversation);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversation.conversationId)) throw new Error(`unsafe conversationId ${conversation.conversationId}`);
      const dir = join(root, conversation.conversationId);
      mkdirSync(dir, { recursive: true });
      return { env: await atCwd(env, dir, toChord(context)) };
    },
  };
  const component = defineComponent({ name: "workspace-test", setup: (pikit) => pikit.provide("workspace", provider) });
  return { root, asked, component };
}

async function served(options: { token?: string; config?: Record<string, unknown> } = {}) {
  const box = sandboxes();
  let route: HttpRoute | undefined;
  const reader = defineComponent({
    name: "route-reader",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      return { start: () => void (route = routes.get(ROUTE_KEY)) };
    },
  });
  const app: App = await defineApp({
    components: [secrets({ PIKIT_SANDBOX_TOKEN: options.token ?? TOKEN }), box.component, executionServe, reader],
    config: { "execution-serve": options.config ?? {} },
    logger: silentLogger,
  }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const send = async (path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => {
    const request = new Request(`http://sandbox.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return (route as HttpRoute)(request, app.context());
  };
  const call = async <O extends Operation>(sandbox: string, operation: O, body: unknown) => {
    const response = await send(`${PROTOCOL_PATH}/${sandbox}/${operation}`, body);
    return { status: response.status, body: (await response.json()) as { ok: true; value: Values[O] } | { ok: false; error: { code: string } } | ProtocolFailure };
  };
  const value = async <O extends Operation>(sandbox: string, operation: O, body: unknown): Promise<Values[O]> => {
    const answer = await call(sandbox, operation, body);
    if (answer.status !== 200 || !("ok" in answer.body) || !answer.body.ok) throw new Error(`${operation}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body.value;
  };
  return { ...box, app, send, call, value };
}

const failureOf = (answer: { status: number; body: unknown }) => [answer.status, (answer.body as ProtocolFailure).error?.code];

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secrets({}), sandboxes().component, executionServe], logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "execution-serve")).toEqual({ name: "execution-serve", provides: ["http.route"], requires: ["secrets", "workspace"], optional: [] });
});

for (const c of createLifecycleConformance(() => ({ component: executionServe, providers: [secrets({ PIKIT_SANDBOX_TOKEN: TOKEN }), sandboxes().component] }))) {
  test(`execution-serve ${c.group}: ${c.name}`, () => c.run());
}

test("it refuses to start without its token, or with one shorter than 32 characters, naming the secret, never the value", async () => {
  for (const [values, message] of [
    [{}, "PIKIT_SANDBOX_TOKEN is not set"],
    [{ PIKIT_SANDBOX_TOKEN: "short-token" }, "PIKIT_SANDBOX_TOKEN is shorter than 32 characters"],
  ] as const) {
    const app = await defineApp({ components: [secrets(values), sandboxes().component, executionServe], logger: silentLogger }).create();
    const error = await app.start().then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(String(error?.cause)).toContain(message);
    expect(String(error?.cause)).not.toContain("short-token");
  }
});

test("a request without the token, or with another, is 401 before its sandbox or its body is looked at", async () => {
  const host = await served();
  const path = `${PROTOCOL_PATH}/a/fileInfo`;
  for (const headers of [{}, { authorization: `Bearer ${TOKEN}x` }, { authorization: `Bearer ${TOKEN.slice(0, -1)}` }, { authorization: `Basic ${btoa(`x:${TOKEN}`)}` }, { authorization: TOKEN }, { "x-token": TOKEN }]) {
    const response = await host.send(path, "{ not json", headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(((await response.json()) as ProtocolFailure).error.code).toBe("unauthorized");
  }
  expect(host.asked).toEqual([]);
});

test("a sandbox id that is not one (another sandbox's path, an encoded traversal, a capital, too long) is 400, and no sandbox is asked for", async () => {
  const host = await served();
  for (const sandbox of ["..", "%2e%2e", "a%2F..%2Fb", "a..b", "A", "a_b", "-a", "a-", `a${"b".repeat(128)}`, ""]) {
    expect(failureOf(await host.call(sandbox, "open", {}))).toEqual([400, "invalid_request"]);
  }
  // Extra segments are no sandbox either.
  expect((await host.send(`${PROTOCOL_PATH}/a/b/open`, {})).status).toBe(400);
  expect(host.asked).toEqual([]);
});

test("a path is the sandbox's own: relative paths are refused, and an absolute one only ever reaches the sandbox in the URL", async () => {
  const host = await served();
  mkdirSync(join(host.root, "remote-b"), { recursive: true });
  writeFileSync(join(host.root, "remote-b", "secret.txt"), "b's");

  expect(failureOf(await host.call("a", "readTextFile", { path: "../b/secret.txt" }))).toEqual([400, "invalid_request"]);
  await host.call("a", "readTextFile", { path: "/../../b/secret.txt" });

  // Whatever the path, only `a` was resolved: the walls between sandboxes are the provider's (a VM's root).
  expect(host.asked.map((ref) => ref.conversationId)).toEqual(["remote-a"]);
});

test("a sandbox is resolved as the conversation remote-<id>: never one of the host's own (1, 2...), always a safe conversationId", async () => {
  const host = await served();
  const sandbox = `o-${"0123456789abcdef".repeat(4)}`;
  const opened = await host.value(sandbox, "open", {});

  expect(host.asked).toEqual([{ key: `execution-serve:${sandbox}`, agent: sandbox, conversationId: `remote-${sandbox}` }]);
  expect(opened.cwd).toBe(join(host.root, `remote-${sandbox}`));
  expect(sandboxConversation("shared")).toEqual({ key: "execution-serve:shared", agent: "shared", conversationId: "remote-shared" });
  // The longest id the protocol takes still makes one; a longer one, which the route refuses first, does not.
  expect(sandboxConversation(`a${"b".repeat(MAX_SANDBOX_ID_LENGTH - 1)}`).conversationId).toHaveLength(MAX_SANDBOX_ID_LENGTH + "remote-".length);
  expect(() => sandboxConversation(`a${"b".repeat(127)}`)).toThrow("makes no conversation id");
  expect(() => sandboxConversation("a/../b")).toThrow("makes no conversation id");
  expect(failureOf(await host.call(`a${"b".repeat(MAX_SANDBOX_ID_LENGTH)}`, "open", {}))).toEqual([400, "invalid_request"]);
});

test("an unknown operation is 404, a body that is not the operation's 400", async () => {
  const host = await served();
  expect(failureOf(await host.call("a", "constructor" as Operation, {}))).toEqual([404, "unknown_operation"]);
  expect(failureOf(await host.call("a", "nothing" as Operation, {}))).toEqual([404, "unknown_operation"]);
  expect(failureOf(await host.call("a", "fileInfo", { path: "/x", extra: true }))).toEqual([400, "invalid_request"]);
  expect(failureOf(await host.call("a", "writeFile", { path: "/x", content: { base64: 1 } }))).toEqual([400, "invalid_request"]);
  expect((await host.send(`${PROTOCOL_PATH}/a/fileInfo`, "{ not json")).status).toBe(400);
});

test("a reader and a command are their sandbox's: from another, or unknown, they are 404", async () => {
  const host = await served();
  const a = await host.value("a", "open", {});
  await host.value("a", "writeFile", { path: `${a.cwd}/big.txt`, content: { text: "0123456789" } });
  const opened = await host.value("a", "openBinaryReader", { path: `${a.cwd}/big.txt`, prefetch: 0 });
  if (!("handle" in opened)) throw new Error("expected a handle");
  const dir = await host.value("a", "openDirReader", { path: a.cwd });
  const command = crypto.randomUUID();
  await host.value("a", "execStart", { command, run: "sleep 5", cwd: a.cwd, wait: 0, linger: 0 });

  expect(failureOf(await host.call("b", "readerRead", { handle: opened.handle, offset: 0, length: 4 }))).toEqual([404, "unknown_handle"]);
  expect(failureOf(await host.call("b", "dirNext", { handle: dir.handle, maxEntries: 10 }))).toEqual([404, "unknown_handle"]);
  expect(failureOf(await host.call("b", "execRead", { command, cursor: 0, wait: 0, linger: 0 }))).toEqual([404, "unknown_command"]);
  expect(failureOf(await host.call("b", "execKill", { command, cursor: 0, wait: 0 }))).toEqual([404, "unknown_command"]);
  expect(failureOf(await host.call("a", "execRead", { command: crypto.randomUUID(), cursor: 0, wait: 0, linger: 0 }))).toEqual([404, "unknown_command"]);
  expect(failureOf(await host.call("a", "dirNext", { handle: opened.handle, maxEntries: 1 }))).toEqual([404, "unknown_handle"]);
  // Still the owner's.
  const read = await host.value("a", "readerRead", { handle: opened.handle, offset: 2, length: 4 });
  expect(atob(read.base64)).toBe("2345");
  await host.value("a", "readerClose", { handle: opened.handle });
  expect(failureOf(await host.call("a", "readerInfo", { handle: opened.handle }))).toEqual([404, "unknown_handle"]);
  expect(failureOf(await host.call("a", "execStart", { command, run: "true", cwd: a.cwd, wait: 0, linger: 0 }))).toEqual([400, "invalid_request"]);
  await host.value("a", "execKill", { command, cursor: 0, wait: 1000 });
});

test("execKill stops a running command at once: it ends aborted", async () => {
  const host = await served();
  const a = await host.value("a", "open", {});
  const command = crypto.randomUUID();
  const started = await host.value("a", "execStart", { command, run: "echo started; sleep 30", cwd: a.cwd, wait: 2000, linger: 0 });
  expect(started.done).toBeUndefined();
  const began = Date.now();

  const killed = await host.value("a", "execKill", { command, cursor: started.next, wait: 5000 });

  expect(killed.done).toMatchObject({ ok: false, error: { code: "aborted" } });
  expect(Date.now() - began).toBeLessThan(3000);
});

test("two sandboxes run commands at once, each in its own directory, neither seeing the other's files", async () => {
  const host = await served();
  const [a, b] = await Promise.all([host.value("a", "open", {}), host.value("b", "open", {})]);
  const run = (sandbox: string, cwd: string) =>
    host.value(sandbox, "execStart", { command: crypto.randomUUID(), run: `sleep 0.2; pwd -P; echo ${sandbox} > mine.txt; ls`, cwd, wait: 5000, linger: 5000 });

  const [ranA, ranB] = await Promise.all([run("a", a.cwd), run("b", b.cwd)]);

  const text = (state: WireExecState) => state.chunks.map((chunk) => chunk.text).join("");
  expect(text(ranA)).toBe(`${realpathSync(a.cwd)}\nmine.txt\n`);
  expect(text(ranB)).toBe(`${realpathSync(b.cwd)}\nmine.txt\n`);
  expect(a.cwd).not.toBe(b.cwd);
  expect(await host.value("a", "readTextFile", { path: `${a.cwd}/mine.txt` })).toBe("a\n");
});

test("output is read from a cursor: an answer lost is read again, never twice, and a cursor already passed is refused", async () => {
  const host = await served();
  const a = await host.value("a", "open", {});
  const command = crypto.randomUUID();
  const first = await host.value("a", "execStart", { command, run: "echo one; sleep 0.3; echo two", cwd: a.cwd, wait: 2000, linger: 50 });
  expect(first.chunks.map((c) => c.text)).toEqual(["one\n"]);

  const lost = await host.value("a", "execRead", { command, cursor: first.next, wait: 3000, linger: 3000 });
  const again = await host.value("a", "execRead", { command, cursor: first.next, wait: 3000, linger: 3000 });

  expect(again).toEqual(lost);
  expect(lost.chunks.map((c) => c.text)).toEqual(["two\n"]);
  expect(lost.done).toEqual({ ok: true, value: { exitCode: 0 } });
  const after = await host.value("a", "execRead", { command, cursor: lost.next, wait: 0, linger: 0 });
  expect(after.chunks).toEqual([]);
  expect(failureOf(await host.call("a", "execRead", { command, cursor: 0, wait: 0, linger: 0 }))).toEqual([400, "invalid_request"]);
  expect(failureOf(await host.call("a", "execRead", { command, cursor: lost.next + 5, wait: 0, linger: 0 }))).toEqual([400, "invalid_request"]);
});

test(`a sandbox runs at most ${MAX_COMMANDS} commands at once (429)`, async () => {
  const host = await served();
  const a = await host.value("a", "open", {});
  const ids: string[] = [];
  for (let i = 0; i < MAX_COMMANDS; i++) {
    const command = crypto.randomUUID();
    ids.push(command);
    await host.value("a", "execStart", { command, run: "sleep 5", cwd: a.cwd, wait: 0, linger: 0 });
  }
  expect(failureOf(await host.call("a", "execStart", { command: crypto.randomUUID(), run: "true", cwd: a.cwd, wait: 0, linger: 0 }))).toEqual([429, "too_many"]);
  // Another sandbox is not held up.
  const b = await host.value("b", "open", {});
  expect((await host.value("b", "execStart", { command: crypto.randomUUID(), run: "true", cwd: b.cwd, wait: 2000, linger: 0 })).done).toEqual({ ok: true, value: { exitCode: 0 } });
  await Promise.all(ids.map((command) => host.value("a", "execKill", { command, cursor: 0, wait: 2000 })));
});

test("a command nobody reads for the lease is stopped, saying so, then forgotten; an idle reader is closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "execution-serve-lease-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const env = createLocalExecution({ cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  let now = 1_000_000;
  const host = new SandboxHost({ resolve: async () => env, leaseMs: 60_000, now: () => now });
  cleanup.push(() => host.close());
  const ctx = BACKGROUND_CONTEXT as Parameters<SandboxHost["serve"]>[3];
  await env.writeFile("f.txt", "x", toChord(ctx));
  const command = crypto.randomUUID();
  await host.serve("a", "execStart", { command, run: "sleep 30", cwd: root, wait: 0, linger: 0 }, ctx);
  const reader = await host.serve("a", "openBinaryReader", { path: join(root, "f.txt"), prefetch: 0 }, ctx);
  const handle = reader.ok && "handle" in reader.value ? reader.value.handle : "";

  now += 30_000;
  await host.sweep();
  const kept = await host.serve("a", "execRead", { command, cursor: 0, wait: 0, linger: 0 }, ctx);
  expect(kept.ok && kept.value.done).toBeUndefined();

  now += 61_000;
  await host.sweep();
  const deadline = Date.now() + 5000;
  let stopped = await host.serve("a", "execRead", { command, cursor: 0, wait: 2000, linger: 0 }, ctx);
  while (stopped.ok && stopped.value.done === undefined && Date.now() < deadline) stopped = await host.serve("a", "execRead", { command, cursor: 0, wait: 2000, linger: 0 }, ctx);
  expect(stopped.ok && stopped.value.done).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining("nobody read it for the lease") } });
  await expect(host.serve("a", "readerInfo", { handle }, ctx)).rejects.toMatchObject({ code: "unknown_handle" });

  now += 61_000;
  await host.sweep();
  await expect(host.serve("a", "execRead", { command, cursor: 0, wait: 0, linger: 0 }, ctx)).rejects.toMatchObject({ code: "unknown_command" });
});

test("stopping the host stops its commands, and requests after are 503", async () => {
  const host = await served();
  const a = await host.value("a", "open", {});
  const command = crypto.randomUUID();
  await host.value("a", "execStart", { command, run: "echo $$ > pid; sleep 30", cwd: a.cwd, wait: 1000, linger: 1000 });
  const pid = Number(await host.value("a", "readTextFile", { path: `${a.cwd}/pid` }));

  await host.app.stop();

  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  expect(alive(pid)).toBe(false);
  expect((await host.send(`${PROTOCOL_PATH}/a/open`, {})).status).toBe(503);
});

// The output log, alone.

test("without a window every chunk is delivered, in order, with its stream; a large backlog in several reads", () => {
  const log = new OutputLog();
  log.append("one\n", "stdout");
  log.append("err\n", "stderr");
  log.append("two\n", "stdout");

  const first = log.read(0, 4);
  expect(first).toEqual({ chunks: [{ text: "one\n", stream: "stdout" }], next: 1, complete: false });
  const rest = log.read(first.next, 1000);
  expect(rest).toEqual({
    chunks: [
      { text: "err\n", stream: "stderr" },
      { text: "two\n", stream: "stdout" },
    ],
    next: 3,
    complete: true,
  });
  expect(log.pendingBytes).toBe(8);
  log.read(3, 1000);
  expect(log.pendingBytes).toBe(0);
});

test("with a window, what was never sent is folded into one skip once more than the window follows it, counted exactly", () => {
  const window = { maxBytes: 20, maxLines: 3, minIntervalMs: 0, bytesPerSecond: 1e9 };
  const log = new OutputLog(window);
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}\n`);
  for (const line of lines) log.append(line, "stdout");

  const read = log.read(0, 1_000_000);
  const [chunk] = read.chunks;
  expect(read.chunks).toHaveLength(1);
  const skipped = chunk?.skipped;
  if (chunk === undefined || skipped === undefined) throw new Error("expected a skip");
  // Everything after the skip is more than the window, and the counts add up to the whole output.
  const after = new TextEncoder().encode(chunk.text).length;
  expect(after > window.maxBytes || chunk.text.split("\n").length - 1 > window.maxLines).toBe(true);
  expect(skipped.bytes + after).toBe(lines.join("").length);
  expect(skipped.newlines + chunk.text.split("\n").length - 1).toBe(100);
  expect(skipped.endsWithNewline).toBe(true);
  expect(chunk.text.endsWith("line-99\n")).toBe(true);
  expect(log.pendingBytes).toBe(after);
});

test("with a window, output already sent is never folded: an answer lost reads the same text again, then a skip", () => {
  const log = new OutputLog({ maxBytes: 10, maxLines: 1, minIntervalMs: 0, bytesPerSecond: 1e9 });
  log.append("aaaa\n", "stdout");
  const lost = log.read(0, 1000);
  for (let i = 0; i < 10; i++) log.append(`b${i}\n`, "stderr");

  const again = log.read(0, 1000);

  expect(again.chunks[0]).toEqual(lost.chunks[0] as (typeof lost.chunks)[number]);
  expect(again.chunks[1]?.skipped).toBeDefined();
  const total = again.chunks.reduce((sum, chunk) => sum + chunk.text.length + (chunk.skipped?.bytes ?? 0), 0);
  expect(total).toBe(5 + 30);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
