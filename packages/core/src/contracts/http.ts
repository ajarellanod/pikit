/**
 * `http.route` (SPEC §9.1): one HTTP endpoint, as a standard fetch handler. A keyed capability:
 * each route is provided under its key, `"METHOD /path"` (`"POST /v1/messages"`), and one server
 * component serves them all. Channels and admin components provide routes; they never import the
 * server, and the same handler runs behind `Bun.serve` or a Cloudflare Worker.
 *
 * Keys:
 * - `METHOD` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
 * - The path is `/` or `/`-separated segments, with no trailing `/`. A segment is literal
 *   (letters, digits, `.`, `_`, `~`, `-`) or a parameter (`:id`), which matches exactly one
 *   segment. The handler reads parameters from `request.url`.
 * - A server refuses to start with a key it cannot serve.
 *
 * What a server guarantees to every handler:
 * - The request as the client sent it.
 * - Its response unchanged.
 * - A context of its own. It carries the app's values, and its cancellation fires when the client
 *   goes away or the server stops. It is never `start`'s context.
 * - When the server stops, every handler still running sees its context cancelled and still
 *   answers.
 * - A handler that throws becomes a `500` that does not reveal the error.
 * - A request no route matches is a `404`.
 */

import type { AppContext } from "../app.ts";

export type HttpRoute = (request: Request, ctx: AppContext) => Response | Promise<Response>;

declare module "../capabilities.ts" {
  interface AppKeyedCapabilities {
    /** Keyed by `"METHOD /path"`. */
    "http.route": HttpRoute;
  }
}
