// The accounts' tests' doubles: a fake OIDC provider on a local Bun.serve (discovery, authorize by
// hand, token with a signed id_token, userinfo, JWKS), a browser with a cookie jar, and a fixture of
// `createLocalAccounts` on a SQLite file with Durable Object limits. No network.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext, Logger } from "@pikit/core";
import { openSqliteDatabase, type SqliteDatabase } from "@pikit/pi-adapter/testing";
import { createLocalAccounts, type EmailMessage, type LocalAccountsOptions, type SignUpPolicy } from "./local.ts";
import type { Accounts } from "./types.ts";

export const ORIGIN = "http://chat.test";
export const SECRET = "test-secret-of-at-least-thirty-two-characters";

export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const b64url = (bytes: Uint8Array | string): string =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type Profile = { sub: string; email: string; email_verified: boolean; name: string };

/** A fake OIDC platform. `approve(authorizeUrl, profile)` stands for the person consenting. */
export async function fakeOidc(clientId: string) {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string | null; profile: Profile }>();
  const tokens = new Map<string, Profile>();
  let base = "";
  const sign = async (claims: Record<string, unknown>): Promise<string> => {
    const head = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }))}.${b64url(JSON.stringify(claims))}`;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(head)));
    return `${head}.${b64url(signature)}`;
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
          jwks_uri: `${base}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
          response_types_supported: ["code"],
        });
      }
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const grant = codes.get(form.get("code") ?? "");
        if (grant === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(form.get("code") ?? "");
        const access = crypto.randomUUID();
        tokens.set(access, grant.profile);
        const now = Math.floor(Date.now() / 1000);
        const idToken = await sign({ iss: base, aud: clientId, iat: now, exp: now + 300, ...(grant.nonce !== null && { nonce: grant.nonce }), ...grant.profile });
        return Response.json({ access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: "openid email profile" });
      }
      if (url.pathname === "/userinfo") {
        const profile = tokens.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
        return profile === undefined ? new Response("no", { status: 401 }) : Response.json(profile);
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  return {
    discoveryUrl: `${base}/.well-known/openid-configuration`,
    base,
    /** The callback URL the person's browser is sent to, once they consent as `profile`. */
    approve(authorizeUrl: string, profile: Profile): string {
      const url = new URL(authorizeUrl);
      if (!url.href.startsWith(`${base}/authorize`)) throw new Error(`not this provider's authorization URL: ${authorizeUrl}`);
      const code = crypto.randomUUID();
      codes.set(code, { nonce: url.searchParams.get("nonce"), profile });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return back.toString();
    },
    stop: () => server.stop(true),
  };
}

/** A browser on the chat page: its cookies, its address. */
export class Browser {
  readonly jar = new Map<string, string>();
  constructor(
    private readonly accounts: Accounts,
    private readonly ctx: AppContext,
    readonly origin = ORIGIN,
    readonly ip = "203.0.113.1",
  ) {}

  /** A request as the browser sends it (cookies, origin, address). */
  build(path: string, init: { method?: string; json?: unknown } = {}): Request {
    const headers = new Headers({ origin: this.origin, "x-forwarded-for": this.ip });
    if (this.jar.size > 0) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const url = path.startsWith("http") ? path : `${this.origin}${path}`;
    return new Request(url, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, ...(body !== undefined && { body }) });
  }

  async send(path: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
    const response = await this.accounts.handle(this.build(path, init), this.ctx);
    this.keep(response);
    return response;
  }

  keep(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0\b/i.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  /** The session's user, as a route asks; the cookies renewed on the way are kept, as a browser does. */
  async user() {
    return (await this.session())?.user;
  }

  async session() {
    const found = await this.accounts.user(this.build("/chat/api/me"), this.ctx);
    if (found !== undefined) this.keep(new Response(null, { headers: found.cookies.map((cookie): [string, string] => ["set-cookie", cookie]) }));
    return found;
  }
}

export type Fixture = {
  accounts: Accounts;
  ctx: AppContext;
  emails: { message: EmailMessage; ctx: AppContext }[];
  policy: SignUpPolicy;
  sql: SqliteDatabase["database"];
  browser(ip?: string, origin?: string): Browser;
  close(): Promise<void>;
};

/** better-auth's in-memory rate limits are shared by every instance in a process: an address per browser. */
let addresses = 0;
const nextAddress = (): string => `10.${(++addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`;

/** `createLocalAccounts` on a fresh SQLite file; `email: false` for an App without `email.send`. */
export function fixture(options: Partial<LocalAccountsOptions> & { withEmail?: boolean; mode?: SignUpPolicy["mode"]; allow?: string[] } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "channel-web-accounts-"));
  const sqlite = openSqliteDatabase(join(dir, "accounts.db"), { durableObjectLimits: true });
  const ctx = { name: "test-context" } as unknown as AppContext;
  const emails: Fixture["emails"] = [];
  const policy: SignUpPolicy = { mode: options.mode ?? "open", allow: options.allow ?? [] };
  const { withEmail = true, mode: _mode, allow: _allow, ...rest } = options;
  const accounts = createLocalAccounts({
    sql: () => sqlite.database,
    secret: SECRET,
    name: "Ada",
    password: true,
    magicLink: withEmail,
    social: [],
    oidc: [],
    signUp: async () => policy,
    ...(withEmail && { email: async (message: EmailMessage, at: AppContext) => void emails.push({ message, ctx: at }) }),
    logger: silent,
    ...rest,
  });
  return {
    accounts,
    ctx,
    emails,
    policy,
    sql: sqlite.database,
    browser: (ip, origin) => new Browser(accounts, ctx, origin ?? ORIGIN, ip ?? nextAddress()),
    async close() {
      await sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The first link in a text. */
export const linkIn = (text: string): string => {
  const found = /https?:\/\/\S+/.exec(text)?.[0];
  if (found === undefined) throw new Error(`no link in: ${text}`);
  return found;
};
