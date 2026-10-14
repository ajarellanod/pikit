/**
 * The few calls of Cloudflare's API (v4) that `pikit expose` makes: the zone of a hostname, a remotely
 * managed tunnel (its configuration and its token), and the hostname's DNS record. Plain `fetch`, no SDK.
 *
 * A failure throws a `CloudflareError` with Cloudflare's own words and the HTTP status, never the token.
 */

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** What the API token needs: said whenever Cloudflare refuses it. */
export const TOKEN_PERMISSIONS = "Account > Cloudflare Tunnel > Edit, and Zone > DNS > Edit on the hostname's zone";

export interface CloudflareOptions {
  token: string;
  /** Default: `CLOUDFLARE_API`. Tests point it at a local stand-in. */
  base?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Cloudflare's codes for a token it does not take, whatever the HTTP status: a malformed one is a 400
 * (6003 "Invalid request headers", 6111 its Authorization header), an unknown or expired one 9109 or
 * 10000.
 */
const REFUSED_TOKEN = new Set([6003, 6111, 9106, 9109, 10000]);

export class CloudflareError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
  }
}

export interface Zone {
  id: string;
  name: string;
  accountId: string;
}

export interface Tunnel {
  id: string;
  name: string;
  /** `inactive` (never connected), `healthy`, `degraded` or `down`. */
  status: string;
  /** One per connector's connection to Cloudflare's edge. */
  connections: unknown[];
}

/** One ingress rule of a remotely managed tunnel: `hostname` and `path` (a Go regular expression), or neither (the catch-all). */
export interface IngressRule {
  hostname?: string;
  path?: string;
  service: string;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

export type DnsRecordInput = Omit<DnsRecord, "id">;

type Envelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T };

export type Cloudflare = ReturnType<typeof cloudflare>;

export function cloudflare(options: CloudflareOptions) {
  const base = (options.base ?? CLOUDFLARE_API).replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${options.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new CloudflareError(0, `Cloudflare's API could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    const envelope = (await response.json().catch(() => ({}))) as Envelope<T>;
    if (!response.ok || envelope.success === false) {
      const said = (envelope.errors ?? []).map((error) => `${error.message ?? "error"}${error.code === undefined ? "" : ` (${error.code})`}`).join("; ");
      const what = `${method} ${path.split("?")[0]}: HTTP ${response.status}${said === "" ? "" : `, ${said}`}`;
      const refused = response.status === 401 || response.status === 403 || (envelope.errors ?? []).some((error) => REFUSED_TOKEN.has(error.code ?? 0));
      const why = refused ? `Cloudflare refused the API token (${what}): it needs ${TOKEN_PERMISSIONS}` : `Cloudflare answered ${what}`;
      throw new CloudflareError(response.status, why);
    }
    return envelope.result as T;
  }

  const account = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`;

  return {
    /** The zone of the account that holds `hostname`: the longest suffix of it that is a zone, or undefined. */
    async zoneFor(hostname: string): Promise<Zone | undefined> {
      const labels = hostname.split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const name = labels.slice(i).join(".");
        const zones = await call<{ id: string; name: string; account: { id: string } }[]>("GET", `/zones?name=${encodeURIComponent(name)}`);
        const zone = zones[0];
        if (zone !== undefined) return { id: zone.id, name: zone.name, accountId: zone.account.id };
      }
      return undefined;
    },
    async findTunnel(accountId: string, name: string): Promise<Tunnel | undefined> {
      const tunnels = await call<Tunnel[]>("GET", `${account(accountId)}?name=${encodeURIComponent(name)}&is_deleted=false`);
      return tunnels.find((tunnel) => tunnel.name === name);
    },
    /** A remotely managed tunnel: its configuration lives in Cloudflare, so `cloudflared` needs only its token. */
    createTunnel(accountId: string, name: string): Promise<Tunnel> {
      return call<Tunnel>("POST", account(accountId), { name, config_src: "cloudflare" });
    },
    async ingress(accountId: string, tunnelId: string): Promise<IngressRule[]> {
      const result = await call<{ config?: { ingress?: IngressRule[] } | null } | null>("GET", `${account(accountId)}/${tunnelId}/configurations`);
      return result?.config?.ingress ?? [];
    },
    async putIngress(accountId: string, tunnelId: string, ingress: IngressRule[]): Promise<void> {
      await call("PUT", `${account(accountId)}/${tunnelId}/configurations`, { config: { ingress } });
    },
    tunnelToken(accountId: string, tunnelId: string): Promise<string> {
      return call<string>("GET", `${account(accountId)}/${tunnelId}/token`);
    },
    /** Ends the tunnel's connections, so it can be deleted while a connector still runs. */
    async cleanupConnections(accountId: string, tunnelId: string): Promise<void> {
      await call("DELETE", `${account(accountId)}/${tunnelId}/connections`);
    },
    async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
      await call("DELETE", `${account(accountId)}/${tunnelId}`);
    },
    dnsRecords(zoneId: string, name: string): Promise<DnsRecord[]> {
      return call<DnsRecord[]>("GET", `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}`);
    },
    createDnsRecord(zoneId: string, record: DnsRecordInput): Promise<DnsRecord> {
      return call<DnsRecord>("POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, record);
    },
    updateDnsRecord(zoneId: string, recordId: string, record: DnsRecordInput): Promise<DnsRecord> {
      return call<DnsRecord>("PUT", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, record);
    },
    async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
      await call("DELETE", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
    },
  };
}
