/**
 * What `main.ts` runs: the project's definition with server-bun on this machine's loopback, and,
 * under the supervisor (`PIKIT_SERVICE=1`, set by the unit and the plist), the log file and the
 * `/health` watchdog. `pikit dev` runs the same `main.ts` without them: its lines on the terminal.
 */

import type { AppDefinition } from "@pikit/core";
import type { EntrypointOptions } from "./entrypoint.ts";
import { createJsonLogger, createRotatingFile } from "./logger.ts";
import { APP_LOG } from "./supervisor.ts";

export interface LocalOptions {
  /** Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where server-bun listens when `pikit.config.ts` leaves it on every interface (`0.0.0.0`, its default,
   * or `::`). Default: `127.0.0.1`, as deployment-docker publishes `127.0.0.1:3000` only: on a server's
   * public address the bearer token would be the only lock. Serving other machines is `pikit expose`, a
   * TLS proxy, or `"0.0.0.0"` here, knowingly.
   */
  hostname?: string;
}

const EVERY_INTERFACE = new Set(["0.0.0.0", "::"]);

/** The app to run and the entrypoint's options. */
export function local(definition: AppDefinition, options: LocalOptions = {}): { app: AppDefinition; options: EntrypointOptions } {
  const env = options.env ?? process.env;
  const hostname = options.hostname ?? "127.0.0.1";
  const server = definition.config["server-bun"] as { hostname?: unknown; port?: unknown } | undefined;
  const config =
    server !== undefined && typeof server.hostname === "string" && EVERY_INTERFACE.has(server.hostname)
      ? { ...definition.config, "server-bun": { ...server, hostname } }
      : definition.config;
  const app: AppDefinition = { ...definition, config };
  if (env.PIKIT_SERVICE !== "1") return { app, options: {} };

  const port = typeof server?.port === "number" ? server.port : undefined;
  return {
    app,
    options: {
      logger: createJsonLogger({ write: createRotatingFile(APP_LOG) }),
      // Without server-bun (or on a port it picks itself) there is no /health to watch.
      ...(port !== undefined && port > 0 && { watchdog: { url: `http://127.0.0.1:${port}/health` } }),
    },
  };
}
