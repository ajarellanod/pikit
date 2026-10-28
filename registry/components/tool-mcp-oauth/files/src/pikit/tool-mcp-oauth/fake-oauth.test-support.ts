/**
 * A fake MCP server behind OAuth, as a `fetch` handler, for tool-mcp-oauth's tests and the workerd
 * lane's outbound service: the MCP endpoint (`/mcp`, any `FakeMcpServer` given) and, on the same
 * origin, its authorization server: protected resource and authorization server metadata, dynamic
 * client registration (`/register`), the authorization endpoint (`/authorize`, which approves at once
 * and redirects with a code) and the token endpoint (`/token`: the code with PKCE S256, and refresh).
 *
 * Like a strict real one:
 * - **Rotating refresh tokens.** Each refresh issues a new access token and a new refresh token, and
 *   revokes both old ones: a refresh with any but the latest refresh token is `invalid_grant`.
 * - **Only the latest access token** opens `/mcp`; any other is `401` with a `WWW-Authenticate`
 *   challenge naming the resource metadata.
 * - **PKCE is checked**: the code's verifier must hash (SHA-256, base64url) to its challenge.
 *
 * Neutral (Web APIs only) and with no import at run time: workerd's outbound service loads it in Node.
 */

import type { FakeMcpServer } from "@pikit/pi-adapter/mcp/testing";

export interface FakeOAuthServer {
  fetch(request: Request): Promise<Response>;
  /** Each registration's body, as sent. */
  readonly registrations: Record<string, unknown>[];
  /** Each token request's form, as sent (`grant_type`, `refresh_token`, `code_verifier`…). */
  readonly tokenRequests: Record<string, string>[];
  /** The `Authorization` header of each request to `/mcp`. */
  readonly mcpAuthorizations: (string | null)[];
  /** The tokens valid now. */
  readonly current: { access: string | undefined; refresh: string | undefined };
  /** Every token it ever issued: what must appear nowhere. */
  readonly issued: string[];
  /** The access token is no longer valid (it expired): `/mcp` refuses it until a refresh. */
  expireAccess(): void;
  /** Refuses every refresh with this OAuth error (`invalid_grant`), or answers them again. */
  refuseRefreshes(error: string | undefined): void;
  /** The next `n` refreshes fail with HTTP 500 `server_error`. */
  failRefreshes(n: number): void;
  /** How long each refresh takes to answer, in ms. */
  refreshDelayMs: number;
}

export interface FakeOAuthServerOptions {
  /** The MCP server behind the OAuth check (`createFakeMcpServer`, without its own `token`). */
  mcp: FakeMcpServer;
  /** The client names registration accepts; any other is `403`. Absent: any. */
  clientNames?: string[];
  /** The access tokens' `expires_in`, in seconds. */
  expiresIn?: number;
  /** A word in every token, to tell two servers' apart. */
  name?: string;
}

const base64url = (bytes: ArrayBuffer): string => {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function createFakeOAuthServer(options: FakeOAuthServerOptions): FakeOAuthServer {
  const name = options.name ?? "fake";
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const mcpAuthorizations: (string | null)[] = [];
  const issued: string[] = [];
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  const current: { access: string | undefined; refresh: string | undefined } = { access: undefined, refresh: undefined };
  let refused: string | undefined;
  let failing = 0;
  let serial = 0;

  const issue = () => {
    serial++;
    const random = crypto.randomUUID().slice(0, 8);
    current.access = `${name}-access-${serial}-${random}`;
    current.refresh = `${name}-refresh-${serial}-${random}`;
    issued.push(current.access, current.refresh);
    return Response.json({ access_token: current.access, refresh_token: current.refresh, token_type: "Bearer", expires_in: options.expiresIn ?? 3600 });
  };
  const oauthError = (status: number, error: string, description?: string) =>
    Response.json({ error, ...(description !== undefined && { error_description: description }) }, { status });

  const server: FakeOAuthServer = {
    registrations,
    tokenRequests,
    mcpAuthorizations,
    current,
    issued,
    refreshDelayMs: 0,
    expireAccess() {
      current.access = undefined;
    },
    refuseRefreshes(error) {
      refused = error;
    },
    failRefreshes(n) {
      failing = n;
    },
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource/mcp":
        case "/.well-known/oauth-protected-resource":
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp"] });
        case "/.well-known/oauth-authorization-server":
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        case "/register": {
          const body = (await request.json()) as Record<string, unknown>;
          registrations.push(body);
          if (options.clientNames !== undefined && !options.clientNames.includes(String(body.client_name))) return new Response("Forbidden: client not in the catalog", { status: 403 });
          const clientId = `client-${registrations.length}`;
          clients.set(clientId, { redirectUris: (body.redirect_uris as string[] | undefined) ?? [] });
          return Response.json({ ...body, client_id: clientId, token_endpoint_auth_method: "none" }, { status: 201 });
        }
        case "/authorize": {
          const clientId = url.searchParams.get("client_id") ?? "";
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          const challenge = url.searchParams.get("code_challenge") ?? "";
          if (!clients.get(clientId)?.redirectUris.includes(redirectUri)) return new Response("unknown client or redirect", { status: 400 });
          if (url.searchParams.get("code_challenge_method") !== "S256" || challenge === "") return new Response("PKCE S256 required", { status: 400 });
          const code = `code-${crypto.randomUUID()}`;
          codes.set(code, { clientId, challenge, redirectUri });
          const back = new URL(redirectUri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", url.searchParams.get("state") ?? "");
          return new Response(null, { status: 302, headers: { location: back.href } });
        }
        case "/token": {
          const form = Object.fromEntries(new URLSearchParams(await request.text())) as Record<string, string>;
          tokenRequests.push(form);
          if (form.grant_type === "authorization_code") {
            const granted = codes.get(form.code ?? "");
            codes.delete(form.code ?? "");
            if (granted === undefined || granted.clientId !== form.client_id || granted.redirectUri !== form.redirect_uri) return oauthError(400, "invalid_grant", "unknown code");
            const hashed = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier ?? "")));
            if (hashed !== granted.challenge) return oauthError(400, "invalid_grant", "PKCE verification failed");
            return issue();
          }
          if (form.grant_type === "refresh_token") {
            if (server.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.refreshDelayMs));
            if (failing > 0) {
              failing--;
              return oauthError(500, "server_error", "try later");
            }
            if (refused !== undefined) return oauthError(400, refused, "the refresh token was revoked");
            if (form.refresh_token === undefined || form.refresh_token !== current.refresh) return oauthError(400, "invalid_grant", "the refresh token was revoked");
            return issue();
          }
          return oauthError(400, "unsupported_grant_type");
        }
        case "/mcp": {
          const authorization = request.headers.get("authorization");
          mcpAuthorizations.push(authorization);
          if (current.access === undefined || authorization !== `Bearer ${current.access}`) {
            return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
          }
          return options.mcp.fetch(request);
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  };
  return server;
}
