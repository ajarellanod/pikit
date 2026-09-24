/**
 * The `http.route` suite run against an in-memory double (S12): a "server" that routes a `Request`
 * to its handler with no socket. It proves the suite asks nothing specific to one server. A real
 * project serves routes with a component such as `server-bun`.
 */

import { test } from "bun:test";
import { type AppContext, defineComponent } from "../app.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../context.ts";
import type { HttpRoute } from "../contracts/http.ts";
import { createHttpRouteConformance } from "./http.ts";

const KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/|(\/([A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*))+)$/;

interface Route {
  method: string;
  segments: string[];
  handler: HttpRoute;
}

function matches(route: Route, method: string, path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return (
    route.method === method &&
    route.segments.length === segments.length &&
    route.segments.every((segment, i) => segment.startsWith(":") || segment === segments[i])
  );
}

function memoryServer() {
  /** What the fixture calls; set while the server runs. */
  const server: { fetch?: (request: Request) => Promise<Response> } = {};
  const component = defineComponent({
    name: "server-memory",
    setup(pikit) {
      const provided = pikit.useKeyed("http.route");
      let shutdown: AbortController | undefined;
      let inFlight = new Set<Promise<Response>>();
      return {
        start(ctx) {
          const routes: Route[] = provided.keys().map((key) => {
            if (!KEY.test(key)) throw new Error(`server-memory: cannot serve "${key}"`);
            const [method = "", path = ""] = key.split(" ");
            const handler = provided.get(key);
            if (handler === undefined) throw new Error(`server-memory: no handler for "${key}"`);
            return { method, segments: path.split("/").filter(Boolean), handler };
          });
          const stopping = new AbortController();
          shutdown = stopping;
          // Requests get a context of their own, never start's (SPEC §4.7).
          const base: AppContext = ctx.derive(() => BACKGROUND_CONTEXT);
          const handle = async (request: Request): Promise<Response> => {
            const route = routes.find((r) => matches(r, request.method, new URL(request.url).pathname));
            if (route === undefined) return new Response("not found", { status: 404 });
            const signal = AbortSignal.any([request.signal, stopping.signal]);
            try {
              return await route.handler(request, base.derive(() => withAbortSignal(signal, BACKGROUND_CONTEXT)));
            } catch {
              return new Response("internal error", { status: 500 });
            }
          };
          server.fetch = (request) => {
            const response = handle(request);
            inFlight.add(response);
            void response.finally(() => inFlight.delete(response));
            return response;
          };
        },
        async stop() {
          delete server.fetch;
          shutdown?.abort(new Error("server-memory: stopping"));
          await Promise.allSettled([...inFlight]);
          inFlight = new Set();
        },
      };
    },
  });
  return {
    component,
    fetch(path: string, init?: RequestInit): Promise<Response> {
      if (server.fetch === undefined) return Promise.reject(new Error("server-memory: not running"));
      return server.fetch(new Request(`http://memory${path}`, init));
    },
  };
}

for (const c of createHttpRouteConformance(() => {
  const server = memoryServer();
  return { components: [server.component], fetch: server.fetch };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
