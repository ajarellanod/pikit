/**
 * server-bun: the HTTP server of the server target (SPEC §9.1), with Hono on `Bun.serve`.
 *
 * It serves every `http.route` that other components provide (a channel's webhook, an admin page),
 * plus two routes of its own:
 * - `GET /health`: 200 while the process can answer at all. A supervisor restarts on failure.
 * - `GET /ready`: 200 only once every component has started (`runtime.ready`), and 503 before that
 *   and from the moment the app starts stopping. A load balancer sends traffic only when it is 200.
 *
 * Routes are standard fetch handlers, so channels never see Hono, and the same handler runs on
 * Cloudflare. Hono only does the routing.
 *
 * Each request gets a context of its own, never `start`'s: its cancellation fires when the client
 * goes away or the server stops. Stopping cancels every request in flight, so a handler that waits
 * (a channel waiting for the agent's answer) answers at once, and the stop does not wait for it.
 *
 * Target: `server` (it uses `Bun.serve`).
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent, withAbortSignal } from "@pikit/core";
import { Hono } from "hono";
import Type from "typebox";

const Config = Type.Object({
  port: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  hostname: Type.String({ minLength: 1, default: "0.0.0.0" }),
  /** Larger request bodies are refused with 413 before any route sees them. */
  maxRequestBodyBytes: Type.Integer({ minimum: 1, default: 1_048_576 }),
  /**
   * Bun closes a connection that stays idle this long, even while its handler is still working
   * (after about twice this long). A channel that waits for the agent's answer needs it longer
   * than its own reply timeout; 255 is Bun's maximum.
   */
  idleTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 255, default: 255 }),
});

/** `"METHOD /path"` as SPEC §9.1 defines it. */
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/|(\/([A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*))+)$/;
/** This server's own routes. */
const RESERVED = new Set(["GET /health", "GET /ready"]);

export interface ServerBunOptions {
  /** Called once the server listens, with its URL. Tests listen on port 0 and read the port here. */
  onListening?(url: URL): void;
}

export function createServerBun(options: ServerBunOptions = {}) {
  return defineComponent({
    name: "server-bun",
    config: Config,
    setup(pikit, config) {
      const routes = pikit.useKeyed("http.route");

      // Events only flip a flag: the server itself is opened in start and closed in stop.
      let ready = false;
      pikit.on("runtime.ready", () => {
        ready = true;
      });
      pikit.on("runtime.stopping", () => {
        ready = false;
      });

      let server: ReturnType<typeof Bun.serve> | undefined;
      /** Cancels every request in flight when the server stops. */
      let stopping: AbortController | undefined;

      return {
        start(ctx) {
          ctx.abortSignal?.throwIfAborted();
          // Requests must not inherit start's deadline (SPEC §4.7); each derives its own context.
          const base: AppContext = ctx.derive(() => BACKGROUND_CONTEXT);
          const shutdown = new AbortController();

          const app = new Hono();
          app.get("/health", (c) => c.json({ status: "ok" }));
          app.get("/ready", (c) => (ready ? c.json({ status: "ready" }) : c.json({ status: "not_ready" }, 503)));
          for (const key of routes.keys()) {
            if (!ROUTE_KEY.test(key)) throw new Error(`server-bun: cannot serve the http.route key "${key}" (expected "METHOD /path")`);
            if (RESERVED.has(key)) throw new Error(`server-bun: "${key}" is the server's own route`);
            const route = routes.get(key);
            if (route === undefined) continue;
            const [method = "", path = ""] = key.split(" ");
            app.on(method, path, (c) => {
              const request = c.req.raw;
              const signal = AbortSignal.any([request.signal, shutdown.signal]);
              return route(request, base.derive(() => withAbortSignal(signal, BACKGROUND_CONTEXT)));
            });
          }
          app.notFound((c) => c.json({ error: "not_found" }, 404));
          // The client learns only that it failed; the log says why.
          app.onError((error, c) => {
            base.logger.error("server-bun: a route failed", { route: `${c.req.method} ${c.req.path}`, error: String(error) });
            return c.json({ error: "internal" }, 500);
          });

          // Throws when the port is taken: the start fails, and the app does not look healthy.
          server = Bun.serve({
            port: config.port,
            hostname: config.hostname,
            maxRequestBodySize: config.maxRequestBodyBytes,
            idleTimeout: config.idleTimeoutSeconds,
            fetch: app.fetch,
          });
          stopping = shutdown;
          const host = config.hostname === "0.0.0.0" ? "127.0.0.1" : config.hostname === "::" ? "[::1]" : config.hostname;
          options.onListening?.(new URL(`http://${host}:${server.port}`));
        },

        async stop(ctx) {
          ready = false;
          const running = server;
          server = undefined;
          stopping?.abort(new Error("server-bun: stopping"));
          stopping = undefined;
          if (running === undefined) return;
          // Stop listening and let the requests in flight finish; they were just cancelled, so they
          // answer promptly. At the stop deadline, close whatever is left.
          const graceful = running.stop();
          const signal = ctx.abortSignal;
          if (signal === undefined) return graceful;
          await Promise.race([
            graceful,
            new Promise<void>((resolve) => {
              const force = () => void running.stop(true).then(resolve, resolve);
              if (signal.aborted) force();
              else signal.addEventListener("abort", force, { once: true });
            }),
          ]);
        },
      };
    },
  });
}

export default createServerBun();
