/**
 * `http.route`: one HTTP endpoint, as a standard fetch handler. A keyed capability:
 * each route is provided under its key, `"METHOD /path"` (`"POST /v1/messages"`), and one server
 * component serves them all. Channels and admin components provide routes; they never import the
 * server, and the same handler runs behind `Bun.serve` or a Cloudflare Worker.
 *
 * Keys:
 * - `METHOD` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
 * - The path is `/` or `/`-separated segments, with no trailing `/`. A segment is literal
 *   (letters, digits, `.`, `_`, `~`, `-`) or a parameter (`:id`), which matches exactly one
 *   segment. The handler reads parameters from `request.url`.
 * - A prefix: the last segment may be `*` (`GET /admin/*`), which matches the path before it and
 *   everything under it (`/admin`, `/admin/`, `/admin/assets/app.js`), for a component that serves
 *   a tree of its own (a dashboard's assets and API). `/*` matches every path.
 * - When several keys match a request, the most specific serves it: a key without parameters or `*`
 *   wins over one with parameters, which wins over a prefix; of two prefixes, the one with more
 *   segments before its `*`.
 * - A server refuses to start with a key it cannot serve. `HTTP_ROUTE_KEY` is the grammar.
 *
 * A server's own routes (`GET /health`) are served before any key, prefixes included.
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

import type { AppContext } from "@pikit/core";

export type HttpRoute = (request: Request, ctx: AppContext) => Response | Promise<Response>;

/** The grammar of an `http.route` key: `"METHOD /path"`, the path's last segment possibly `*`. */
export const HTTP_ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/|\/\*|(\/([A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*))+(\/\*)?)$/;

/** One key, parsed: what a server needs to match requests to it. */
export interface HttpRouteKey {
  method: string;
  /** The segments before `*` (all of them when there is none); `:name` for a parameter. */
  segments: string[];
  /** Whether the key ends in `*`: it matches its segments and anything under them. */
  prefix: boolean;
}

/** `key` parsed, or `undefined` when it is not one (`HTTP_ROUTE_KEY`). */
export function parseHttpRouteKey(key: string): HttpRouteKey | undefined {
  if (!HTTP_ROUTE_KEY.test(key)) return undefined;
  const [method = "", path = ""] = key.split(" ");
  const segments = path.split("/").filter((segment) => segment !== "");
  const prefix = segments.at(-1) === "*";
  return { method, segments: prefix ? segments.slice(0, -1) : segments, prefix };
}

/**
 * Whether `route` serves a request of `method` to `pathname`. A trailing `/` is a segment of its own
 * for an exact key (`/a/` is not `/a`) and is under a prefix (`/admin/` is under `/admin/*`).
 */
export function matchesHttpRoute(route: HttpRouteKey, method: string, pathname: string): boolean {
  if (route.method !== method) return false;
  const segments = pathname === "/" ? [] : pathname.split("/").slice(1);
  if (route.prefix ? segments.length < route.segments.length : segments.length !== route.segments.length) return false;
  return route.segments.every((segment, i) => (segment.startsWith(":") ? segments[i] !== "" : segment === segments[i]));
}

/**
 * Orders keys most specific first (see the rules above), so that the first match serves: exact
 * literal paths, then paths with parameters, then prefixes, the longest first.
 */
export function compareHttpRoutes(a: HttpRouteKey, b: HttpRouteKey): number {
  const rank = (route: HttpRouteKey) => (route.prefix ? 2 : route.segments.some((s) => s.startsWith(":")) ? 1 : 0);
  return rank(a) - rank(b) || (a.prefix && b.prefix ? b.segments.length - a.segments.length : 0);
}

declare module "@pikit/core" {
  interface AppKeyedCapabilities {
    /** Keyed by `"METHOD /path"`. */
    "http.route": HttpRoute;
  }
}
