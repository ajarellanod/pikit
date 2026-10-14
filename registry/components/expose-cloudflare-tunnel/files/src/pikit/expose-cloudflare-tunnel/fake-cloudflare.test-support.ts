/**
 * A local stand-in of the part of Cloudflare's API (v4) that `pikit expose` calls: zones, remotely
 * managed tunnels (configuration, token, connections) and DNS records, with Cloudflare's envelope and
 * its 403 for another token. It counts every write, so a test sees a second run make none. Only tests
 * import it.
 */

import type { DnsRecord, IngressRule } from "./cloudflare.ts";

export interface FakeTunnel {
  id: string;
  account: string;
  name: string;
  status: string;
  connections: unknown[];
  deleted: boolean;
  ingress?: IngressRule[];
}

export interface FakeCloudflare {
  /** The API's base URL, for `ExposeContext.api.base`. */
  base: string;
  tunnels: FakeTunnel[];
  /** DNS records by zone id. */
  records: Map<string, DnsRecord[]>;
  /** Every write, `METHOD /path`, in order. */
  writes: string[];
  /** The tunnel token Cloudflare gives for a tunnel. */
  tokenOf(tunnelId: string): string;
  stop(): void;
}

export function fakeCloudflare(options: { token: string; zones: { id: string; name: string; account: string }[] }): FakeCloudflare {
  const tunnels: FakeTunnel[] = [];
  const records = new Map<string, DnsRecord[]>(options.zones.map((zone) => [zone.id, []]));
  const writes: string[] = [];
  let next = 1;
  const id = () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
  const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  const fail = (status: number, message: string, code = 1000) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  const tokenOf = (tunnelId: string) => `tunnel-token-${tunnelId}`;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const authorization = request.headers.get("authorization") ?? "";
      // A token of Cloudflare's shape (40 characters) is unknown; any other is a malformed header, as Cloudflare answers.
      if (authorization !== `Bearer ${options.token}`) {
        return /^Bearer [A-Za-z0-9_-]{40}$/.test(authorization) ? fail(403, "Authentication error", 10000) : fail(400, "Invalid request headers", 6003);
      }
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/client\/v4/, "");
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : ((await request.json()) as Record<string, unknown>);
      if (request.method !== "GET") writes.push(`${request.method} ${path}`);
      let match: RegExpExecArray | null;

      if (request.method === "GET" && path === "/zones") {
        const name = url.searchParams.get("name");
        return ok(options.zones.filter((zone) => zone.name === name).map((zone) => ({ id: zone.id, name: zone.name, account: { id: zone.account } })));
      }
      if ((match = /^\/accounts\/([^/]+)\/cfd_tunnel$/.exec(path))) {
        const account = match[1] as string;
        if (request.method === "GET") {
          const name = url.searchParams.get("name");
          return ok(tunnels.filter((t) => t.account === account && !t.deleted && (name === null || t.name === name)).map(view));
        }
        if (request.method === "POST") {
          if (body?.config_src !== "cloudflare") return fail(400, "only remotely managed tunnels here");
          const tunnel: FakeTunnel = { id: id(), account, name: String(body.name), status: "inactive", connections: [], deleted: false };
          tunnels.push(tunnel);
          return ok(view(tunnel));
        }
      }
      if ((match = /^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
        const tunnel = tunnels.find((t) => t.account === match?.[1] && t.id === match?.[2] && !t.deleted);
        if (tunnel === undefined) return fail(404, "Tunnel not found", 1003);
        const part = match[3];
        if (part === "/configurations" && request.method === "GET") return ok({ tunnel_id: tunnel.id, config: tunnel.ingress === undefined ? null : { ingress: tunnel.ingress } });
        if (part === "/configurations" && request.method === "PUT") {
          tunnel.ingress = ((body?.config ?? {}) as { ingress?: IngressRule[] }).ingress ?? [];
          return ok({ tunnel_id: tunnel.id, config: { ingress: tunnel.ingress } });
        }
        if (part === "/token" && request.method === "GET") return ok(tokenOf(tunnel.id));
        if (part === "/connections" && request.method === "DELETE") {
          tunnel.connections = [];
          return ok(null);
        }
        if (part === undefined && request.method === "DELETE") {
          if (tunnel.connections.length > 0) return fail(400, "Cannot delete a tunnel with active connections", 1022);
          tunnel.deleted = true;
          return ok(view(tunnel));
        }
      }
      if ((match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path))) {
        const zone = records.get(match[1] as string);
        if (zone === undefined) return fail(404, "Zone not found", 7003);
        const recordId = match[2];
        if (recordId === undefined && request.method === "GET") return ok(zone.filter((record) => record.name === url.searchParams.get("name")));
        if (recordId === undefined && request.method === "POST") {
          const record = { ...(body as Omit<DnsRecord, "id">), id: id() };
          zone.push(record);
          return ok(record);
        }
        const index = zone.findIndex((record) => record.id === recordId);
        if (index < 0) return fail(404, "Record not found", 81044);
        if (request.method === "PUT") {
          zone[index] = { ...(body as Omit<DnsRecord, "id">), id: recordId as string };
          return ok(zone[index]);
        }
        if (request.method === "DELETE") {
          zone.splice(index, 1);
          return ok({ id: recordId });
        }
      }
      return fail(404, `no route ${request.method} ${path}`, 7000);
    },
  });

  function view(tunnel: FakeTunnel) {
    return { id: tunnel.id, name: tunnel.name, status: tunnel.status, connections: tunnel.connections };
  }

  return { base: `http://127.0.0.1:${server.port}/client/v4`, tunnels, records, writes, tokenOf, stop: () => server.stop(true) };
}
