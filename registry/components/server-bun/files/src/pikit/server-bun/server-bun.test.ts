/**
 * server-bun's tests. They are copied with the component and keep running in your project. Every
 * server listens on 127.0.0.1 on a port the system picks (port 0).
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, type HttpRoute, silentLogger } from "@pikit/core";
import { createHttpRouteConformance, createLifecycleConformance } from "@pikit/core/testing";
import serverBun, { createServerBun } from "./index.ts";

const LOCAL = { "server-bun": { port: 0, hostname: "127.0.0.1" } };

/** A server on a free port, and a way to reach it once it listens. */
function listening() {
  let base: URL | undefined;
  const component = createServerBun({ onListening: (url) => void (base = url) });
  return {
    component,
    fetch(path: string, init?: RequestInit): Promise<Response> {
      if (base === undefined) return Promise.reject(new Error("server-bun is not listening"));
      return fetch(new URL(path, base), init);
    },
    /** 1 while something answers at the address the server listened on, 0 otherwise. */
    async openResources(): Promise<number> {
      if (base === undefined) return 0;
      return fetch(new URL("/health", base)).then(
        () => 1,
        () => 0,
      );
    },
  };
}

function routes(entries: Record<string, HttpRoute>) {
  return defineComponent({
    name: "routes-test",
    setup(pikit) {
      for (const [key, route] of Object.entries(entries)) pikit.provideKeyed("http.route", key, route);
    },
  });
}

// What every handler can rely on (SPEC §9.1, §14).
for (const c of createHttpRouteConformance(() => {
  const server = listening();
  return { components: [server.component], config: LOCAL, fetch: server.fetch };
})) {
  test(`server-bun ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline, and a stopped server no longer answers.
for (const c of createLifecycleConformance(() => {
  const server = listening();
  return { component: server.component, config: LOCAL, openResources: server.openResources };
})) {
  test(`server-bun ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [serverBun], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "server-bun", provides: [], requires: [], optional: ["http.route"] }]);
});

test("/health answers while the process lives; /ready only between runtime.ready and the stop", async () => {
  const server = listening();
  let finishStart!: () => void;
  const startGate = new Promise<void>((resolve) => (finishStart = resolve));
  let finishStop!: () => void;
  const stopGate = new Promise<void>((resolve) => (finishStop = resolve));
  let startEntered!: () => void;
  const inStart = new Promise<void>((resolve) => (startEntered = resolve));
  let stopEntered!: () => void;
  const inStop = new Promise<void>((resolve) => (stopEntered = resolve));
  // Starts after the server and stops before it: the app is up but not ready, then stopping.
  const slow = defineComponent({
    name: "slow-component",
    setup() {
      return {
        async start() {
          startEntered();
          await startGate;
        },
        async stop() {
          stopEntered();
          await stopGate;
        },
      };
    },
  });
  const app = await defineApp({ components: [server.component, slow], config: LOCAL, logger: silentLogger }).create();
  const status = async (path: string) => (await server.fetch(path)).status;

  const started = app.start();
  await inStart;
  const whileStarting = [await status("/health"), await status("/ready")];
  finishStart();
  await started;
  const whenReady = [await status("/health"), await status("/ready")];
  const stopped = app.stop();
  await inStop;
  const whileStopping = [await status("/health"), await status("/ready")];
  finishStop();
  await stopped;

  expect(whileStarting).toEqual([200, 503]);
  expect(whenReady).toEqual([200, 200]);
  expect(whileStopping).toEqual([200, 503]);
  expect(await server.openResources()).toBe(0);
});

test("it refuses to start when its port is taken", async () => {
  const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("someone else") });
  const app = await defineApp({
    components: [serverBun],
    config: { "server-bun": { port: taken.port, hostname: "127.0.0.1" } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).message)).toContain('"server-bun" failed to start');
  expect(String((error as Error).cause)).toContain("in use");
  await taken.stop(true);
});

test("a route cannot take the server's own /health or /ready", async () => {
  const server = listening();
  const app = await defineApp({
    components: [routes({ "GET /health": () => new Response("mine") }), server.component],
    config: LOCAL,
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).cause)).toContain(`"GET /health" is the server's own route`);
});

test("a body larger than maxRequestBodyBytes is refused before the route", async () => {
  const server = listening();
  let reached = false;
  const app = await defineApp({
    components: [
      routes({
        "POST /upload": () => {
          reached = true;
          return new Response("ok");
        },
      }),
      server.component,
    ],
    config: { "server-bun": { ...LOCAL["server-bun"], maxRequestBodyBytes: 16 } },
    logger: silentLogger,
  }).create();
  await app.start();

  const response = await server.fetch("/upload", { method: "POST", body: "x".repeat(1024) });

  expect(response.status).toBe(413);
  expect(reached).toBe(false);
  await app.stop();
});
