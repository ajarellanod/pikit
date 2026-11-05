/**
 * execution-cloudflare-sandbox in workerd. The lane cannot run containers (miniflare gives a Durable
 * Object no `ctx.container` without Docker and Cloudflare's container runtime), so a container is a
 * double here:
 *
 * - the Worker's half behind deployment-cloudflare's real Worker `fetch` (its routes, a request's own
 *   context), the token read by secrets-workers from the Worker's env, and a fake `SANDBOX` namespace:
 *   a checked request reaches the object of its sandbox id and agent, the token and the sandbox id are
 *   checked first, an object that never answers is 503;
 * - the object's App (`object.ts`) composed in a real SQLite-backed Durable Object over a container
 *   double that answers the helper's `open` and `mkdir`: the identity kept in the object's storage,
 *   the idle alarm set in it, a container that never answers unavailable within the start's deadline;
 * - the shared snapshot format through workerd's Web Crypto, `CompressionStream` and
 *   `DecompressionStream`: written, read back, and an archive leaving the root refused.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import { expect, it } from "vitest";
import { createWorkerHost } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import { craftArchive } from "../../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/archive.test-support.ts";
import type { ContainerProcess, SandboxContainer } from "../../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/container.ts";
import executionCloudflareSandbox, { objectName, worker as sandboxWorker } from "../../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/index.ts";
import { createSandboxObjectHost } from "../../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/object.ts";
import type { SandboxReply, SandboxRequest } from "../../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/sandbox.ts";
import { readSnapshot, SnapshotRefused, snapshotPrefix, writeSnapshot } from "../../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/snapshot.ts";
import secretsWorkers from "../../../registry/components/secrets-workers/files/src/pikit/secrets-workers/index.ts";
import { workerEnv } from "./host.ts";

const TOKEN = "w".repeat(48);

function fakeNamespace(reply: (request: SandboxRequest) => Promise<SandboxReply>) {
  const asked: { name: string; request: SandboxRequest }[] = [];
  return {
    asked,
    binding: { getByName: (name: string) => ({ serve: (request: SandboxRequest) => (asked.push({ name, request }), reply(request)) }) },
  };
}

function workerFetch(namespace: unknown, config: Record<string, unknown> = {}) {
  const host = createWorkerHost(defineApp({ components: [secretsWorkers, sandboxWorker], config: { "execution-cloudflare-sandbox-worker": config } }), { logger: silentLogger });
  const workerEnvWith = { ...workerEnv, PIKIT_SANDBOX_TOKEN: TOKEN, SANDBOX: namespace };
  return (path: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
    host.fetch(new Request(`https://sandbox.example${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, ...init.headers }, body: init.body ?? "{}" }), workerEnvWith);
}

it("the Worker's route, behind deployment-cloudflare's real fetch: forwarded to the object of its sandbox id and agent", async () => {
  const { binding, asked } = fakeNamespace(async () => ({ ok: true, answer: { ok: true, value: { cwd: "/workspace", home: "/root" } } as never }));
  const fetch = workerFetch(binding);
  const response = await fetch("/execution/v1/sandboxes/o-abc/open", { headers: { "Pikit-Agent": "designer" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, value: { cwd: "/workspace", home: "/root" } });
  expect(asked).toEqual([{ name: objectName("o-abc", "designer"), request: { sandbox: "o-abc", agent: "designer", operation: "open", body: {} } }]);

  expect((await fetch("/execution/v1/sandboxes/o-abc/open", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  // workerd's URL resolves `%2e%2e` itself (no route then: 404); an encoded slash and capitals reach the check.
  expect((await fetch("/execution/v1/sandboxes/%2e%2e/open")).status).toBe(404);
  expect((await fetch("/execution/v1/sandboxes/a%2Fb/open")).status).toBe(400);
  expect((await fetch("/execution/v1/sandboxes/ABC/open")).status).toBe(400);
  expect((await fetch("/execution/v1/sandboxes/o-abc/open", { headers: { "Pikit-Agent": "Nope" } })).status).toBe(400);
  expect(asked).toHaveLength(1);
});

it("an object that never answers is 503 within callSeconds", async () => {
  const { binding } = fakeNamespace(() => new Promise<never>(() => {}));
  const fetch = workerFetch(binding, { callSeconds: 1 });
  const started = Date.now();
  const response = await fetch("/execution/v1/sandboxes/o-abc/open");
  expect(response.status).toBe(503);
  expect(Date.now() - started).toBeLessThan(5000);
});

/** A container double: the helper answers `open` and `mkdir`; `hang` never answers. */
function container(hang = false): SandboxContainer & { starts: number } {
  let running = false;
  const bytes = (text: string) => new Response(text).body as ReadableStream<Uint8Array>;
  const double = {
    starts: 0,
    get running() {
      return running;
    },
    images: { base: "registry.example/base@sha256:1" },
    start() {
      running = true;
      double.starts++;
    },
    async exec(cmd: string[]): Promise<ContainerProcess> {
      if (hang) return await new Promise<never>(() => {});
      const value = cmd[1] === "open" ? { home: "/root" } : null;
      return { stdout: bytes(`${JSON.stringify({ ok: true, value })}\n`), stderr: bytes(""), exitCode: Promise.resolve(0), kill() {} };
    },
    async destroy() {
      running = false;
    },
    async setInactivityTimeout() {},
  };
  return double;
}

const blobs = defineComponent({ name: "blob-test", setup: (pikit) => pikit.provide("storage.blob", createMemoryBlobStorage()) });

it("the object's App in a real Durable Object: its identity and idle alarm in the object's storage", async () => {
  const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const double = container();
    const host = createSandboxObjectHost(defineApp({ components: [blobs, executionCloudflareSandbox] }), { container: double, storage: state.storage as never, blockConcurrencyWhile: (callback) => state.blockConcurrencyWhile(callback) }, workerEnv, { logger: silentLogger });
    const reply = await host.serve({ sandbox: "o-abc", agent: "designer", operation: "open", body: {} });
    expect(reply).toEqual({ ok: true, answer: { ok: true, value: { cwd: "/workspace", home: "/root" } } });
    expect(double.starts).toBe(1);
    expect(await state.storage.get("identity")).toEqual({ sandbox: "o-abc", agent: "designer" });
    const alarm = await state.storage.getAlarm();
    expect(alarm).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(await host.serve({ sandbox: "o-abc", agent: "other", operation: "open", body: {} })).toMatchObject({ ok: false, code: "invalid_request" });
  });
});

it("a container that never answers is unavailable within the start's deadline", async () => {
  const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const host = createSandboxObjectHost(
      defineApp({ components: [blobs, executionCloudflareSandbox], config: { "execution-cloudflare-sandbox": { startSeconds: 1, callSeconds: 1 } } }),
      { container: container(true), storage: state.storage as never, blockConcurrencyWhile: (callback) => state.blockConcurrencyWhile(callback) },
      workerEnv,
      { logger: silentLogger },
    );
    const started = Date.now();
    expect(await host.serve({ sandbox: "o-abc", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

it("the shared snapshot format through workerd's Web APIs; an archive leaving the root refused", async () => {
  const store = createMemoryBlobStorage().namespace("workspace-snapshots");
  const prefix = await snapshotPrefix("execution-serve:o-abc", "designer");
  const archive = await craftArchive([{ name: "./", type: "5" }, { name: "./a.txt", content: "kept" }]);
  const written = await writeSnapshot({ store, prefix, agent: "designer", archive, createdAt: 1234, maxBytes: 1 << 20 });
  expect(written).toMatchObject({ version: 1, size: archive.length, createdAt: 1234, agent: "designer" });
  expect((await readSnapshot(store, prefix, "designer", 1 << 20))?.archive).toEqual(archive);

  const escaping = await craftArchive([{ name: "../out.txt", content: "x" }]);
  await writeSnapshot({ store, prefix, agent: "designer", archive: escaping, createdAt: 5678, maxBytes: 1 << 20 });
  await expect(readSnapshot(store, prefix, "designer", 1 << 20)).rejects.toThrow(SnapshotRefused);
});
