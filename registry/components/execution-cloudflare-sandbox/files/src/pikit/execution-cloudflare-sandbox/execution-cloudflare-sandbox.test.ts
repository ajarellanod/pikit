/**
 * The component's halves and its project files: what setup declares; the Worker's route (the token
 * first, the sandbox id as sent, `Pikit-Agent`, the body, the object named per sandbox and agent, a
 * reply mapped to its status, an object that never answers); its start refused without the token, the
 * binding or the Worker's App; secrets refused in the config; the machine of each agent; the object's
 * App composed over a fake container (`object.ts`); the host's `wrangler.jsonc` and images.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type App, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { HttpRoute, SecretStore } from "@pikit/contracts";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import { createFakeContainer, createObjectStorage } from "./fake-container.test-support.ts";
import sandboxHalf, { profileOf, refuseSecrets, type SandboxConfig, worker } from "./index.ts";
import { createSandboxObjectHost } from "./object.ts";
import { ROUTE_KEY } from "./protocol.ts";
import { objectName, type SandboxReply, type SandboxRequest } from "./sandbox.ts";
import type { SandboxNamespace } from "./worker.ts";

const TOKEN = "t".repeat(40);

function secrets(values: Record<string, string>): ComponentDefinition {
  const store: SecretStore = { get: async (name) => values[name] };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

/** A namespace whose objects answer with `reply`, recording what each was asked. */
function namespace(reply: (request: SandboxRequest) => Promise<SandboxReply> = async () => ({ ok: true, answer: { ok: true, value: null } as never })) {
  const asked: { name: string; request: SandboxRequest }[] = [];
  const binding: SandboxNamespace = {
    getByName: (name) => ({
      serve: (request) => {
        asked.push({ name, request });
        return reply(request);
      },
    }),
  };
  return { binding, asked };
}

async function workerApp(env: Record<string, unknown>, options: { token?: string; config?: Record<string, unknown>; object?: boolean } = {}) {
  let route: HttpRoute | undefined;
  const reader = defineComponent({
    name: "route-reader",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      return { start: () => void (route = routes.get(ROUTE_KEY)) };
    },
  });
  const host = { env, ...(options.object === true && { object: { id: "x", storage: {}, onAlarm() {}, onDeliver() {} } }) };
  const app: App = await defineApp({
    components: [secrets(options.token === undefined ? { PIKIT_SANDBOX_TOKEN: TOKEN } : { PIKIT_SANDBOX_TOKEN: options.token }), ...withWorkersHost(host, [worker]), reader],
    config: { "execution-cloudflare-sandbox-worker": options.config ?? {} },
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start(BACKGROUND_CONTEXT);
  const serve = (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
    (route as HttpRoute)(
      new Request(`https://sandbox.example${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
        body: init.body === undefined ? "{}" : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      }),
      app.context(),
    );
  return { app, serve };
}

describe("setup", () => {
  test("the default half uses storage.blob; the Worker's provides the route and uses secrets", () => {
    const provided: string[] = [];
    const used: string[] = [];
    const probe = {
      use: (name: string) => (used.push(name), { get: () => undefined }),
      useOptional: (name: string) => (used.push(name), { get: () => undefined }),
      useKeyed: (name: string) => (used.push(name), { get: () => undefined, keys: () => [] }),
      provide: (name: string) => void provided.push(name),
      provideKeyed: (name: string, key: string) => void provided.push(`${name} ${key}`),
    } as never;
    sandboxHalf.setup(probe, { image: "base", internet: false, agents: {}, root: "/workspace", idleMinutes: 10, backstopMinutes: 15, leaseSeconds: 120, callSeconds: 30, startSeconds: 45, snapshotSeconds: 300, maxUnpackedBytes: 1 } as never);
    expect(used).toEqual(["storage.blob"]);
    expect(provided).toEqual([]);
    used.length = 0;
    worker.setup(probe, { tokenSecret: "PIKIT_SANDBOX_TOKEN", binding: "SANDBOX", maxRequestBytes: 1024, callSeconds: 55 } as never);
    expect(used).toEqual(["secrets"]);
    expect(provided).toEqual([`http.route ${ROUTE_KEY}`]);
  });
});

describe("the Worker's route", () => {
  test("forwards a checked request to the object of its sandbox id and agent, and answers what it replies", async () => {
    const { binding, asked } = namespace(async (request) => ({ ok: true, answer: { ok: true, value: { cwd: "/workspace", home: "/root", echo: request.operation } } as never }));
    const { app, serve } = await workerApp({ SANDBOX: binding });
    const response = await serve("/execution/v1/sandboxes/k-abc/open", { headers: { "Pikit-Agent": "developer" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: { cwd: "/workspace", home: "/root", echo: "open" } });
    await serve("/execution/v1/sandboxes/k-abc/fileInfo", { body: { path: "/workspace/a" } });
    expect(asked).toEqual([
      { name: objectName("k-abc", "developer"), request: { sandbox: "k-abc", agent: "developer", operation: "open", body: {} } },
      { name: objectName("k-abc", undefined), request: { sandbox: "k-abc", operation: "fileInfo", body: { path: "/workspace/a" } } },
    ]);
    expect(objectName("k-abc", "developer")).not.toBe(objectName("k-abc", undefined));
    await app.stop(BACKGROUND_CONTEXT);
  });

  test("the object's protocol failure is its status; an environment's failure is 200", async () => {
    const replies: SandboxReply[] = [
      { ok: false, code: "too_many", message: "16 commands" },
      { ok: true, answer: { ok: false, error: { code: "not_found", message: "ENOENT" } } },
    ];
    const { binding } = namespace(async () => replies.shift() as SandboxReply);
    const { serve } = await workerApp({ SANDBOX: binding });
    const tooMany = await serve("/execution/v1/sandboxes/s/open");
    expect(tooMany.status).toBe(429);
    expect(await tooMany.json()).toEqual({ error: { code: "too_many", message: "16 commands" } });
    const missing = await serve("/execution/v1/sandboxes/s/open");
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: false, error: { code: "not_found", message: "ENOENT" } });
  });

  test("the token first: missing, another, another scheme are 401 before the URL or the body are looked at", async () => {
    const { binding, asked } = namespace();
    const { serve } = await workerApp({ SANDBOX: binding });
    for (const authorization of ["", `Bearer ${"x".repeat(40)}`, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const response = await serve("/execution/v1/sandboxes/..%2F/nope", { headers: { authorization }, body: "not json" });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect(asked).toEqual([]);
  });

  test("sandbox ids that are not one, unknown operations, malformed agents and bodies are refused before any object is asked", async () => {
    const { binding, asked } = namespace();
    const { serve } = await workerApp({ SANDBOX: binding }, { config: { maxRequestBytes: 1024 } });
    for (const path of ["/execution/v1/sandboxes/../open", "/execution/v1/sandboxes/%2e%2e/open", "/execution/v1/sandboxes/a%2Fb/open", "/execution/v1/sandboxes/ABC/open", `/execution/v1/sandboxes/${"a".repeat(101)}/open`, "/execution/v1/sandboxes/a/b/open"]) {
      expect((await serve(path)).status).toBe(400);
    }
    expect((await serve("/execution/v1/sandboxes/a/format")).status).toBe(404);
    for (const agent of ["Developer", "dev_eloper", "a".repeat(101), "-x"]) {
      expect((await serve("/execution/v1/sandboxes/a/open", { headers: { "Pikit-Agent": agent } })).status).toBe(400);
    }
    expect((await serve("/execution/v1/sandboxes/a/open", { headers: { "Pikit-Agent": "a".repeat(100) } })).status).toBe(200);
    expect((await serve("/execution/v1/sandboxes/a/fileInfo", { body: { path: "relative" } })).status).toBe(400);
    expect((await serve("/execution/v1/sandboxes/a/open", { body: { extra: true } })).status).toBe(400);
    expect((await serve("/execution/v1/sandboxes/a/open", { body: "{" })).status).toBe(400);
    expect((await serve("/execution/v1/sandboxes/a/writeFile", { body: { path: "/a", content: { text: "x".repeat(2000) } } })).status).toBe(413);
    expect(asked).toHaveLength(1);
  });

  test("an object that never answers is 503 after callSeconds past the request's wait", async () => {
    const { binding } = namespace(() => new Promise<never>(() => {}));
    const { serve } = await workerApp({ SANDBOX: binding }, { config: { callSeconds: 1 } });
    const started = Date.now();
    const response = await serve("/execution/v1/sandboxes/a/execRead", { body: { command: "c", cursor: 0, wait: 200, linger: 0 } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1150);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("its start is refused without the token, with a short one, without the binding, or in an object's App", async () => {
    const { binding } = namespace();
    const why = (started: Promise<unknown>) =>
      started.then(
        () => "started",
        (error: Error) => String((error.cause as Error | undefined)?.message ?? error.message),
      );
    expect(await why(workerApp({ SANDBOX: binding }, { token: "short" }))).toContain("shorter than 32");
    expect(await why(workerApp({}))).toContain("no Durable Object namespace bound as SANDBOX");
    expect(await why(workerApp({ SANDBOX: binding }, { object: true }))).toContain("runs only in the Worker's App");
    expect(
      await why(
        defineApp({ components: [secrets({}), ...withWorkersHost({ env: { SANDBOX: binding } }, [worker])], logger: silentLogger, target: "durable" })
          .create()
          .then((app) => app.start(BACKGROUND_CONTEXT)),
      ),
    ).toContain("PIKIT_SANDBOX_TOKEN is not set");
  });
});

describe("the config", () => {
  const config: SandboxConfig = { image: "base", instance: "lite", internet: false, agents: { designer: { image: "designer", internet: true }, big: { instance: "standard-4" } }, root: "/workspace", idleMinutes: 10, backstopMinutes: 15, leaseSeconds: 120, callSeconds: 30, startSeconds: 45, snapshotSeconds: 300, maxUnpackedBytes: 1 };

  test("a profile replaces the base field by field; an unknown agent and none get the base", () => {
    expect(profileOf(config, "designer")).toEqual({ image: "designer", internet: true, instance: "lite" });
    expect(profileOf(config, "big")).toEqual({ image: "base", internet: false, instance: "standard-4" });
    expect(profileOf(config, "nobody")).toEqual({ image: "base", internet: false, instance: "lite" });
    expect(profileOf(config, undefined)).toEqual({ image: "base", internet: false, instance: "lite" });
    expect(profileOf(config, "constructor")).toEqual({ image: "base", internet: false, instance: "lite" });
  });

  test("secrets, on the base or a profile, are refused: this host never gets secrets", async () => {
    expect(() => refuseSecrets({ ...config, secrets: [{ name: "GH_TOKEN" }] })).toThrow("this host never gets secrets");
    expect(() => refuseSecrets({ ...config, agents: { developer: { secrets: [{ name: "GH_TOKEN" }] } } })).toThrow("agents.developer names secrets");
    expect(() => refuseSecrets(config)).not.toThrow();
    await expect(
      defineApp({ components: [sandboxHalf], config: { "execution-cloudflare-sandbox": { agents: { developer: { secrets: ["GH_TOKEN"] } } } }, logger: silentLogger, target: "durable" }).create(),
    ).rejects.toThrow("never gets secrets");
  });

  test("agent keys that are not agents' names are refused", () => {
    expect(() => defineApp({ components: [sandboxHalf], config: { "execution-cloudflare-sandbox": { agents: { Developer: {} } } }, logger: silentLogger, target: "durable" })).toThrow("property names Developer are invalid");
  });
});

describe("the object's App (object.ts)", () => {
  const storageBlob = (blobs = createMemoryBlobStorage()) => defineComponent({ name: "blob-test", setup: (pikit) => pikit.provide("storage.blob", blobs) });
  const state = (container = createFakeContainer()) => ({ container, storage: createObjectStorage(), blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback() });

  test("composes the default App once with the container, and serves through it", async () => {
    const objectState = state();
    try {
      const host = createSandboxObjectHost(defineApp({ components: [storageBlob(), sandboxHalf], config: { "execution-cloudflare-sandbox": { root: objectState.container.root } } }), objectState, {}, { logger: silentLogger });
      const reply = await host.serve({ sandbox: "s-1", operation: "open", body: {} });
      expect(reply).toMatchObject({ ok: true, answer: { ok: true, value: { cwd: objectState.container.root } } });
      expect(objectState.container.starts).toHaveLength(1);
      await host.alarm();
    } finally {
      objectState.container.cleanup();
    }
  });

  test("without a container, or without this component in the App, it is unavailable", async () => {
    const noContainer = createSandboxObjectHost(defineApp({ components: [storageBlob(), sandboxHalf] }), { storage: createObjectStorage(), blockConcurrencyWhile: (callback) => callback() }, {}, { logger: silentLogger });
    expect(await noContainer.serve({ sandbox: "s", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    const objectState = state();
    try {
      const empty = createSandboxObjectHost(defineApp({ components: [storageBlob()] }), objectState, {}, { logger: silentLogger });
      expect(await empty.serve({ sandbox: "s", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      objectState.container.cleanup();
    }
  });

  test("in another App (deployment-cloudflare's /health object), the default half starts and does nothing", async () => {
    const app = await defineApp({ components: [storageBlob(), sandboxHalf], logger: silentLogger, target: "durable" }).create();
    await app.start(BACKGROUND_CONTEXT);
    await app.stop(BACKGROUND_CONTEXT);
  });
});

describe("the host's files", () => {
  const here = import.meta.dir;
  const jsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

  test("wrangler.host.jsonc binds the Sandbox class with its container, its images' Dockerfiles exist and install the helper", () => {
    const config = jsonc(readFileSync(join(here, "wrangler.host.jsonc"), "utf8"));
    expect(config.main).toBe("src/pikit/deployment-cloudflare/worker.ts");
    expect(config.durable_objects.bindings).toContainEqual({ name: "SANDBOX", class_name: "Sandbox" });
    expect(config.durable_objects.bindings).toContainEqual({ name: "CONVERSATION", class_name: "Conversation" });
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Conversation"] }, { tag: "v2", new_sqlite_classes: ["Sandbox"] }]);
    const [container] = config.containers;
    expect(container).toMatchObject({ class_name: "Sandbox", scheduling_policy: "durable_object" });
    expect(Object.keys(container.images)).toEqual(["base", "designer"]);
    for (const image of Object.values(container.images) as { dockerfile: string }[]) {
      const dockerfile = join(here, image.dockerfile.replace("./src/pikit/execution-cloudflare-sandbox/", ""));
      expect(existsSync(dockerfile)).toBe(true);
      const text = readFileSync(dockerfile, "utf8");
      expect(text).toContain("--platform=linux/amd64");
      expect(text).toContain("COPY pikit-sandbox /usr/local/bin/pikit-sandbox");
      expect(text).toMatch(/\btar\b/);
    }
  });

  test("only durable-object.ts and entrypoint.ts reach Workers or the project; the helper is no Worker module", () => {
    for (const file of ["index.ts", "worker.ts", "sandbox.ts", "object.ts", "container.ts", "context.ts", "protocol.ts", "output.ts"]) {
      const text = readFileSync(join(here, file), "utf8");
      expect(text).not.toContain("cloudflare:workers");
      expect(text).not.toContain("pikit.config.ts\"");
    }
    expect(readFileSync(join(here, "images", "pikit-sandbox"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
