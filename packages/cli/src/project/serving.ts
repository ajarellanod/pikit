/**
 * Whether the composed Apps answer anyone: what the capability graph does not say, since a router
 * provides nothing (it is a `route.resolve` stage) and a server only uses `http.route`s. Read from the
 * probe's `describe()` of each App, never from component names:
 *
 * - a component that admits messages, one that uses `conversations.registry` (what `admitInbound`
 *   takes: a channel), needs a `route.resolve` stage in its App; without one, every message ends
 *   `no_route` and nobody is answered;
 * - an App whose components provide `http.route`s needs a component that serves them, one that uses
 *   `http.route` (a server); without one, no request reaches them. Not the Worker's App
 *   (`export const worker`): its host serves the routes itself, with a server it adds (C1).
 *
 * `doctor` reports each as a problem; `remove` refuses, unless forced, to leave one the project did
 * not have.
 */

import type { AppDescription, ProbeResult } from "./probe.ts";

const ADMITS = "conversations.registry";
const ROUTER_PIPELINE = "route.resolve";
const HTTP_ROUTE = "http.route";

export interface ServingGap {
  kind: "router" | "server";
  /** Which App: "" for the default export's, " in the Worker's App". */
  where: string;
  message: string;
}

/** Each App's gaps; `without`: as if those components were gone (the one `remove` takes out). */
export function servingGaps(result: Extract<ProbeResult, { ok: true }>, without: (component: string) => boolean = () => false): ServingGap[] {
  return [
    ...gapsOf(result.description, { where: "", hostServesRoutes: false, without }),
    ...(result.worker === undefined ? [] : gapsOf(result.worker, { where: " in the Worker's App", hostServesRoutes: true, without })),
  ];
}

function gapsOf(app: AppDescription, { where, hostServesRoutes, without }: { where: string; hostServesRoutes: boolean; without: (component: string) => boolean }): ServingGap[] {
  const components = app.components.filter((c) => !without(c.name));
  const using = (capability: string) => components.filter((c) => [...c.requires, ...c.optional].includes(capability)).map((c) => c.name);
  const gaps: ServingGap[] = [];

  const channels = using(ADMITS);
  const routers = (app.stagesBy[ROUTER_PIPELINE] ?? []).filter((c) => !without(c));
  if (channels.length > 0 && routers.length === 0) {
    gaps.push({
      kind: "router",
      where,
      message: `${list(channels)} ${channels.length === 1 ? "admits" : "admit"} messages${where}, but no component has a ${ROUTER_PIPELINE} stage: no message would be answered. Add a router (a component with a ${ROUTER_PIPELINE} stage)`,
    });
  }

  const routes = [...new Set(app.capabilities[HTTP_ROUTE]?.providers ?? [])].filter((c) => !without(c));
  if (!hostServesRoutes && routes.length > 0 && using(HTTP_ROUTE).length === 0) {
    gaps.push({
      kind: "server",
      where,
      message: `${list(routes)} ${routes.length === 1 ? "provides" : "provide"} ${HTTP_ROUTE}${where}, but no component serves it: no request would reach ${routes.length === 1 ? "it" : "them"}. Add a server (a component that uses ${HTTP_ROUTE})`,
    });
  }
  return gaps;
}

const list = (names: string[]) => names.join(", ");
