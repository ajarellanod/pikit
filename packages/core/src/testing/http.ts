/**
 * `http.route` conformance (SPEC §9.1, §14): what every server of `http.route` must guarantee to
 * the handlers it serves. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createHttpRouteConformance(() => myServerFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite provides the routes and sends requests through the fixture, the way a client would.
 */

import { type ComponentDefinition, defineApp, defineComponent, type App, type AppContext } from "../app.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../context.ts";
import type { HttpRoute } from "../contracts/http.ts";
import { silentLogger } from "../contracts/logger.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";

/** A server under test, built for one case. */
export interface HttpRouteFixture {
  /** The component that serves `http.route`, and what it uses. The suite adds the routes. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** Send a request to the started server. `path` starts with `/` and may carry a query. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Release what the fixture holds. */
  dispose?(): Promise<void>;
}

export interface HttpRouteConformanceOptions {
  /** How long to wait for a response or a hook. Default 5000 ms. */
  timeoutMs?: number;
}

const GROUP = "http.route";
const expect = expecter(GROUP);
const check = checker(GROUP);

export function createHttpRouteConformance(
  factory: () => HttpRouteFixture | Promise<HttpRouteFixture>,
  options: HttpRouteConformanceOptions = {},
): readonly ConformanceCase[] {
  const timeoutMs = options.timeoutMs ?? 5000;
  const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${GROUP}: timed out after ${timeoutMs} ms waiting for ${what}`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  /** A case over a started server; `build` makes its routes and checks afresh for each run. */
  const routeCase = (name: string, build: () => RouteCase): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const { routes, run, start } = build();
      const fixture = await factory();
      const app = await createApp(fixture, routes);
      try {
        await within((start ?? ((a: App) => a.start()))(app), "the app to start");
        const fetch: HttpRouteFixture["fetch"] = (path, init) => within(fixture.fetch(path, init), `${init?.method ?? "GET"} ${path}`);
        await run({ app, fetch });
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  const text = (body: string, status = 200): Response => new Response(body, { status });

  return [
    routeCase("a request reaches the route of its method and path", () => ({
      routes: {
        "GET /conformance/a": () => text("get a"),
        "POST /conformance/a": () => text("post a", 201),
        "GET /conformance/b": () => text("get b"),
        "GET /": () => text("root"),
      },
      async run({ fetch }) {
        const get = await fetch("/conformance/a");
        const post = await fetch("/conformance/a", { method: "POST" });
        const other = await fetch("/conformance/b");
        const root = await fetch("/");

        expect([get.status, await get.text()], [200, "get a"], "GET /conformance/a");
        expect([post.status, await post.text()], [201, "post a"], "POST /conformance/a");
        expect([other.status, await other.text()], [200, "get b"], "GET /conformance/b");
        expect([root.status, await root.text()], [200, "root"], "GET /");
      },
    })),

    routeCase("a parameter segment matches exactly one segment", () => ({
      routes: { "GET /conformance/items/:id": (request) => text(new URL(request.url).pathname) },
      async run({ fetch }) {
        const found = await fetch("/conformance/items/42");
        const none = await fetch("/conformance/items");
        const deeper = await fetch("/conformance/items/42/more");

        expect([found.status, await found.text()], [200, "/conformance/items/42"], "GET /conformance/items/42");
        expect(none.status, 404, "GET /conformance/items");
        expect(deeper.status, 404, "GET /conformance/items/42/more");
      },
    })),

    routeCase("a request no route matches is a 404; a known path with another method is a 404 or 405", () => ({
      routes: { "POST /conformance/only-post": () => text("posted") },
      async run({ fetch }) {
        const unknown = await fetch("/conformance/nothing-here");
        const wrongMethod = await fetch("/conformance/only-post");

        expect(unknown.status, 404, "GET /conformance/nothing-here");
        check(wrongMethod.status === 404 || wrongMethod.status === 405, `GET on a POST route to be 404 or 405, got ${wrongMethod.status}`);
      },
    })),

    routeCase("the handler sees the request as the client sent it", () => ({
      routes: {
        "POST /conformance/echo": async (request) => {
          const url = new URL(request.url);
          return Response.json({
            method: request.method,
            path: url.pathname,
            query: url.searchParams.get("q"),
            authorization: request.headers.get("authorization"),
            body: await request.text(),
          });
        },
      },
      async run({ fetch }) {
        const response = await fetch("/conformance/echo?q=a%20b", {
          method: "POST",
          headers: { authorization: "Bearer conformance", "content-type": "application/json" },
          body: '{"text":"ñandú ✓"}',
        });

        expect(
          await response.json(),
          { method: "POST", path: "/conformance/echo", query: "a b", authorization: "Bearer conformance", body: '{"text":"ñandú ✓"}' },
          "what the handler saw",
        );
      },
    })),

    routeCase("the handler's response reaches the client unchanged", () => ({
      routes: {
        "GET /conformance/teapot": () => new Response("short and stout", { status: 418, headers: { "x-conformance": "yes" } }),
      },
      async run({ fetch }) {
        const response = await fetch("/conformance/teapot");

        expect(
          [response.status, response.headers.get("x-conformance"), await response.text()],
          [418, "yes", "short and stout"],
          "the response",
        );
      },
    })),

    routeCase("a handler that throws is a 500 that does not reveal the error", () => ({
      routes: {
        "GET /conformance/throws": () => {
          throw new Error("conformance-internal-detail-8f2c");
        },
      },
      async run({ fetch }) {
        const response = await fetch("/conformance/throws");
        const body = await response.text();

        expect(response.status, 500, "status");
        check(!body.includes("conformance-internal-detail-8f2c"), "the error message not to reach the client");
      },
    })),

    routeCase("requests are handled concurrently", () => {
      const gate = deferred();
      const slowEntered = deferred();
      return {
        routes: {
          "GET /conformance/slow": async () => {
            slowEntered.resolve();
            await gate.promise;
            return text("slow");
          },
          "GET /conformance/fast": () => text("fast"),
        },
        async run({ fetch }) {
          const slow = fetch("/conformance/slow");
          await within(slowEntered.promise, "the slow handler to run");

          const fast = await fetch("/conformance/fast");

          expect(await fast.text(), "fast", "a request while another is in its handler");
          gate.resolve();
          expect(await (await slow).text(), "slow", "the slow request");
        },
      };
    }),

    routeCase("each request has a live context of its own, not start's", () => {
      const startDeadline = new AbortController();
      return {
        routes: {
          "GET /conformance/context": (_request, ctx: AppContext) =>
            Response.json({
              aborted: ctx.abortSignal?.aborted ?? false,
              isAppContext: typeof ctx.emit === "function" && typeof ctx.run === "function",
            }),
        },
        start: (app) => app.start(withAbortSignal(startDeadline.signal, BACKGROUND_CONTEXT)),
        async run({ fetch }) {
          // Start's deadline passes once the app is up; requests must not inherit it.
          startDeadline.abort(new Error("conformance: start's deadline"));

          const response = await fetch("/conformance/context");

          expect(await response.json(), { aborted: false, isAppContext: true }, "the handler's context");
        },
      };
    }),

    routeCase("stopping the server cancels the context of a handler in flight, which still answers", () => {
      const handlerEntered = deferred();
      return {
        routes: {
          "GET /conformance/waits": async (_request, ctx) => {
            handlerEntered.resolve();
            const signal = ctx.abortSignal;
            if (signal === undefined) return text("no cancellation", 500);
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return text("stopping", 503);
          },
        },
        async run({ app, fetch }) {
          const waiting = fetch("/conformance/waits");
          await within(handlerEntered.promise, "the handler to run");

          const stopped = app.stop();
          const response = await waiting;

          expect([response.status, await response.text()], [503, "stopping"], "the handler's answer");
          await within(stopped, "stop() to resolve");
        },
      };
    }),

    ...["FETCH /conformance/x", "GET conformance/x", "GET /conformance/x/", "GET /conformance/{x}", "get /conformance/x"].map(
      (key): ConformanceCase => ({
        group: GROUP,
        name: `a key it cannot serve fails start: "${key}"`,
        run: async () => {
          const fixture = await factory();
          const app = await createApp(fixture, { [key]: () => text("never") });
          try {
            const failed = await within(
              app.start().then(
                () => false,
                () => true,
              ),
              "start() to settle",
            );
            check(failed, `start() to reject the key "${key}"`);
          } finally {
            await app.stop().catch(() => {});
            await fixture.dispose?.();
          }
        },
      }),
    ),
  ];
}

interface RouteCase {
  routes: Record<string, HttpRoute>;
  run(s: { app: App; fetch: HttpRouteFixture["fetch"] }): Promise<void>;
  /** How the case starts the app. Default: `app.start()`. */
  start?(app: App): Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function createApp(fixture: HttpRouteFixture, routes: Record<string, HttpRoute>): Promise<App> {
  const provider = defineComponent({
    name: "http-conformance-routes",
    setup(pikit) {
      for (const [key, route] of Object.entries(routes)) pikit.provideKeyed("http.route", key, route);
    },
  });
  return defineApp({
    components: [provider, ...fixture.components],
    ...(fixture.config !== undefined && { config: fixture.config }),
    logger: silentLogger,
  }).create();
}
