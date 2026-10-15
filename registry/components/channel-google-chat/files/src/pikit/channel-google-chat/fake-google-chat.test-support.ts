// Owner: skeleton (shared test support). Every module's tests use it; add to it, never change what a test relies on.
/**
 * A fake Google for this channel's tests: no app, project or network needed.
 *
 * - **`startFakeGoogleChat()`**: the Chat REST API, the OAuth token endpoint and Google's signing keys,
 *   as a `fetch` double (`fake.fetch`, which also answers Google's real URLs) and served on a free
 *   local port (`fake.url`: an App's `apiBase`, `jwksUrl`, and the service account's `token_uri`).
 *   - `POST /token`: a service account's signed JWT (`grant_type=urn:ietf:params:oauth:grant-type:
 *     jwt-bearer`) checked against its public key (`iss`, `aud` the token URI, the `chat.bot` scope,
 *     `exp`), answered with an access token; every `/v1/` call needs one (`401` otherwise).
 *   - `GET /certs`: the ID tokens' JWKs, with `Cache-Control: public, max-age=<certsMaxAge>`.
 *   - `POST /v1/<space>/messages`: a `requestId` seen before returns the first message (also with
 *     another body); a `messageId` (`client-` and up to 56 of `[a-z0-9-]`) that exists is refused `409
 *     ALREADY_EXISTS`; a thread (`thread.name`) is answered in, a message of more than 32,000 bytes as
 *     JSON refused `400`. `forgetRequests()`: Google forgot every `requestId`.
 *   - `PATCH /v1/<message>?updateMask=…` (`allowMissing` creates a `client-` one), `DELETE`, `GET`;
 *     `GET /v1/<space>`; `GET /v1/media/<resourceName>?alt=media`.
 *   - Unknown spaces are made on first use (a threaded `SPACE`), unless `autoSpaces: false`;
 *     `removeSpace` makes one answer `404` (the app removed).
 *   - **`fail(match, failure, times)`**: the next matching calls fail: a status with Google's error body
 *     (`googleError`), a `429` with `retry-after`, `"hang"` (until the caller aborts, or `stop()`), or
 *     `"network"` (the `fetch` double rejects with a `TypeError`, as `fetch` does; through the port, a
 *     `502`).
 *   - Every call is recorded (`calls`, with the status it was answered with), and `waitForCall` waits
 *     for one.
 * - **`createIdTokens()`**: a test key pair, its JWKs, and ID tokens signed for an audience and a project
 *   number with the claims Google gives (`iss`, `aud`, `email` the add-on's service account,
 *   `email_verified`, `iat`, `exp`), any of them overridden, signed by another key, or with another `kid`.
 * - **`createTestServiceAccount()`**: a service account's JSON key (PKCS #8 PEM) whose public key the
 *   fake checks assertions with.
 * - **Events**: `messageEvent`, `addedEvent`, `removedEvent`, `clickEvent` build add-on event objects
 *   as Google posts them; `eventRequest` posts one with a bearer token.
 *
 * Test support: only tests import it (`*.test-support.ts`), so it never reaches a Worker's bundle.
 */

import type { webcrypto } from "node:crypto";
import type { AddOnEvent, ChatAttachment, ChatMessage, ChatSpace, ChatUser, FormInput, SpaceThreadingState } from "./event.ts";
import { addOnEmail } from "./instance.ts";
import type { IdTokenClaims } from "./types.ts";

// ---------------------------------------------------------------------------------------------------
// JWTs with WebCrypto

/** A JSON Web Key, as WebCrypto exports one. */
export type JsonWebKey = webcrypto.JsonWebKey;

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

/** `bytes` as base64url, no padding. */
export function base64url(bytes: Uint8Array | ArrayBuffer | string): string {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(data).toString("base64url");
}

/** A new RS256 key pair, extractable. */
export async function rsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
}

/** A JWT of `header` and `claims`, signed RS256 with `key`. */
export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const signing = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...header }))}.${base64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(RS256, key, encoder.encode(signing));
  return `${signing}.${base64url(signature)}`;
}

/** `token`'s header and claims when `key` signed it, else `undefined`. */
export async function verifyJwt(token: string, key: CryptoKey): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown> } | undefined> {
  const [header, claims, signature] = token.split(".");
  if (header === undefined || claims === undefined || signature === undefined) return undefined;
  const valid = await crypto.subtle.verify(RS256, key, Buffer.from(signature, "base64url"), encoder.encode(`${header}.${claims}`));
  if (!valid) return undefined;
  try {
    return { header: JSON.parse(Buffer.from(header, "base64url").toString()), claims: JSON.parse(Buffer.from(claims, "base64url").toString()) };
  } catch {
    return undefined;
  }
}

const pem = (der: ArrayBuffer, label: string): string =>
  `-----BEGIN ${label}-----\n${(Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

// ---------------------------------------------------------------------------------------------------
// A service account

export interface TestServiceAccount {
  /** The JSON key, as `GOOGLE_CHAT_SERVICE_ACCOUNT` holds it. */
  json: string;
  clientEmail: string;
  keyId: string;
  tokenUri: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** A service account whose key the fake checks, its `token_uri` `tokenUri`. */
export async function createTestServiceAccount(tokenUri: string, clientEmail = "chat-app@pikit-test.iam.gserviceaccount.com"): Promise<TestServiceAccount> {
  const pair = await rsaKeyPair();
  const keyId = `key-${crypto.randomUUID()}`;
  const json = JSON.stringify({
    type: "service_account",
    project_id: "pikit-test",
    private_key_id: keyId,
    private_key: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
    client_email: clientEmail,
    client_id: "1234567890",
    token_uri: tokenUri,
  });
  return { json, clientEmail, keyId, tokenUri, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** A service account's token request assertion, as auth.ts must sign one: for tests of the fake itself. */
export async function signAssertion(account: TestServiceAccount, nowSeconds = Math.floor(Date.now() / 1000), scope = "https://www.googleapis.com/auth/chat.bot"): Promise<string> {
  return signJwt({ kid: account.keyId }, { iss: account.clientEmail, scope, aud: account.tokenUri, iat: nowSeconds, exp: nowSeconds + 3600 }, account.privateKey);
}

// ---------------------------------------------------------------------------------------------------
// ID tokens

export interface IdTokenOptions {
  /** The endpoint URL (`GOOGLE_CHAT_AUDIENCE`). */
  audience: string;
  /** `GOOGLE_CHAT_PROJECT_NUMBER`. */
  projectNumber: string;
  /** Now, in ms (the App's clock in a test with a manual one). */
  now?: () => number;
}

export interface TestIdTokens {
  audience: string;
  projectNumber: string;
  /** The key id of the JWKs' key. */
  kid: string;
  /** What Google serves at `jwks_uri`. */
  jwks: { keys: JsonWebKey[] };
  /** Valid claims now, with `overrides`. */
  claims(overrides?: Partial<IdTokenClaims>): IdTokenClaims;
  /**
   * A token with `claims(overrides)`, signed by the JWKs' key; `foreignKey` signs with another key
   * (same `kid`), `kid` and `alg` change the header.
   */
  sign(overrides?: Partial<IdTokenClaims>, options?: { kid?: string; alg?: string; foreignKey?: boolean }): Promise<string>;
  /** `Bearer <sign(…)>`, an `Authorization` header. */
  bearer(overrides?: Partial<IdTokenClaims>, options?: { kid?: string; alg?: string; foreignKey?: boolean }): Promise<string>;
}

/** A key pair and its JWKs, signing ID tokens as Google signs an add-on's. */
export async function createIdTokens(options: IdTokenOptions): Promise<TestIdTokens> {
  const pair = await rsaKeyPair();
  const foreign = await rsaKeyPair();
  const kid = `kid-${crypto.randomUUID()}`;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const now = options.now ?? Date.now;
  const claims = (overrides: Partial<IdTokenClaims> = {}): IdTokenClaims => {
    const seconds = Math.floor(now() / 1000);
    return {
      iss: "https://accounts.google.com",
      aud: options.audience,
      email: addOnEmail(options.projectNumber),
      email_verified: true,
      iat: seconds,
      exp: seconds + 3600,
      sub: "112233445566778899000",
      ...overrides,
    };
  };
  const sign = async (overrides?: Partial<IdTokenClaims>, signing: { kid?: string; alg?: string; foreignKey?: boolean } = {}) =>
    signJwt({ kid: signing.kid ?? kid, ...(signing.alg !== undefined && { alg: signing.alg }) }, { ...claims(overrides) }, signing.foreignKey ? foreign.privateKey : pair.privateKey);
  return {
    audience: options.audience,
    projectNumber: options.projectNumber,
    kid,
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey] },
    claims,
    sign,
    bearer: async (overrides, signing) => `Bearer ${await sign(overrides, signing)}`,
  };
}

// ---------------------------------------------------------------------------------------------------
// The fake API

/** One call the fake received. */
export interface FakeCall {
  method: string;
  /** From the fake's root: `/v1/spaces/AAA/messages`, `/token`, `/certs`. */
  path: string;
  query: Record<string, string>;
  /** Parsed JSON, the form's text for `/token`, or `undefined`. */
  body: unknown;
  authorization: string | null;
  /** The status the fake answered with, once it did; absent while it hangs (or when it cut the connection). */
  status?: number;
}

/** How a call fails: a status with a body and headers, `"hang"`, or `"network"`. */
export type FakeFailure = { status: number; body?: unknown; headers?: Record<string, string> } | "hang" | "network";

/** Which calls: by method and path (a string is the whole path, a RegExp tests it), or a predicate. */
export type CallMatch = { method?: string; path?: string | RegExp } | ((call: FakeCall) => boolean);

/** Google's error body for `status`. */
export function googleError(status: number, code: string, message: string): { status: number; body: unknown } {
  return { status, body: { error: { code: status, message, status: code } } };
}

export interface FakeGoogleChatOptions {
  /** Unknown spaces are made on first use (a threaded `SPACE`). Default `true`. */
  autoSpaces?: boolean;
  /** `REPLY_MESSAGE_OR_FAIL` to a thread the fake does not know answers `404`. Default `false` (the thread is made). */
  strictThreads?: boolean;
  /** The ID tokens' audience and project number (default `https://pikit.test/google-chat` and `123456789012`). */
  audience?: string;
  projectNumber?: string;
  /** Now, in ms, for tokens and `exp` checks. */
  now?: () => number;
}

export interface FakeGoogleChat {
  /** `http://127.0.0.1:<port>`: the App's `apiBase`. */
  url: string;
  apiBase: string;
  /** The service account's `token_uri`. */
  tokenUri: string;
  /** The App's `jwksUrl`. */
  jwksUrl: string;
  /** A `fetch` double: answers its own URLs and Google's real ones (`chat.googleapis.com`, `oauth2.googleapis.com/token`, `www.googleapis.com/oauth2/v3/certs`); anything else rejects. */
  fetch: typeof fetch;
  serviceAccount: TestServiceAccount;
  idTokens: TestIdTokens;
  /** The secrets an App reads for the default instance (`GOOGLE_CHAT_…`), with `allowedSpaces`. */
  secrets(allowedSpaces?: readonly string[], prefix?: string): Record<string, string>;
  calls: FakeCall[];
  /** The calls matching `match`. */
  callsTo(match: CallMatch): FakeCall[];
  /** Resolves with the first call matching `match` from the `after`-th call on (default: any recorded); rejects after `timeoutMs` (default 2 s). */
  waitForCall(match: CallMatch, options?: { after?: number; timeoutMs?: number }): Promise<FakeCall>;
  /** Every message, by name: those the app created and those added. */
  messages: Map<string, ChatMessage>;
  spaces: Map<string, ChatSpace>;
  addSpace(space: ChatSpace): ChatSpace;
  /** The app is removed from it: every call about it answers `404`. */
  removeSpace(name: string): void;
  /** A message someone wrote (one a quote names): `getMessage` answers it. */
  addMessage(message: ChatMessage & { name: string }): ChatMessage;
  /** An attachment's bytes, for `media.download`. */
  addMedia(resourceName: string, bytes: Uint8Array | string, contentType: string): void;
  /** The next `times` calls matching `match` fail with `failure`. */
  fail(match: CallMatch, failure: FakeFailure, times?: number): void;
  /** Google forgot every `requestId`: a repeat is then refused by its `messageId`. */
  forgetRequests(): void;
  /** `max-age` of the JWKs (default 3600). */
  certsMaxAge: number;
  /** Access tokens issued. */
  tokensIssued: number;
  stop(): Promise<void>;
}

const GOOGLE_ORIGINS: Record<string, string> = {
  "https://chat.googleapis.com": "",
  "https://oauth2.googleapis.com/token": "/token",
  "https://www.googleapis.com/oauth2/v3/certs": "/certs",
};
const MESSAGE_BYTES = 32_000;
const MESSAGE_ID = /^client-[a-z0-9-]{1,56}$/;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const error = (status: number, code: string, message: string): Response => json(googleError(status, code, message).body, status);
const matches = (match: CallMatch, call: FakeCall): boolean =>
  typeof match === "function"
    ? match(call)
    : (match.method === undefined || match.method === call.method) &&
      (match.path === undefined || (typeof match.path === "string" ? match.path === call.path : match.path.test(call.path)));

/** Starts the fake on a free local port. `stop()` it after the test. */
export async function startFakeGoogleChat(options: FakeGoogleChatOptions = {}): Promise<FakeGoogleChat> {
  const now = options.now ?? Date.now;
  const autoSpaces = options.autoSpaces ?? true;
  const calls: FakeCall[] = [];
  const failures: { match: CallMatch; failure: FakeFailure; left: number }[] = [];
  const messages = new Map<string, ChatMessage>();
  const spaces = new Map<string, ChatSpace>();
  const removed = new Set<string>();
  const threads = new Set<string>();
  const media = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const requests = new Map<string, string>();
  const tokens = new Map<string, number>();
  const hanging = new Set<() => void>();
  const waiters = new Set<() => void>();
  let sequence = 0;
  const next = () => `${(++sequence).toString(36)}${crypto.randomUUID().slice(0, 8)}`;

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handle(request, "port") });
  const url = `http://127.0.0.1:${server.port}`;
  const serviceAccount = await createTestServiceAccount(`${url}/token`);
  const idTokens = await createIdTokens({ audience: options.audience ?? "https://pikit.test/google-chat", projectNumber: options.projectNumber ?? "123456789012", now });

  const spaceOf = (name: string): ChatSpace | undefined => {
    if (removed.has(name)) return undefined;
    const found = spaces.get(name);
    if (found !== undefined || !autoSpaces) return found;
    const made: ChatSpace = { name, spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES", displayName: name };
    spaces.set(name, made);
    return made;
  };

  /** `respond`, its status recorded on the call it made. */
  async function handle(request: Request, via: "fetch" | "port"): Promise<Response> {
    let made: FakeCall | undefined;
    const response = await respond(request, via, (call) => (made = call));
    if (made !== undefined) made.status = response.status;
    return response;
  }

  async function respond(request: Request, via: "fetch" | "port", record: (call: FakeCall) => void): Promise<Response> {
    const target = new URL(request.url);
    const path = decodeURIComponent(target.pathname);
    const raw = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    let body: unknown = raw === "" ? undefined : raw;
    if (raw !== "" && (request.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        return error(400, "INVALID_ARGUMENT", "Invalid JSON payload received.");
      }
    }
    const call: FakeCall = { method: request.method, path, query: Object.fromEntries(target.searchParams), body, authorization: request.headers.get("authorization") };
    calls.push(call);
    record(call);
    for (const wake of [...waiters]) wake();

    const failing = failures.find((each) => each.left > 0 && matches(each.match, call));
    if (failing !== undefined) {
      failing.left -= 1;
      const failure = failing.failure;
      if (failure === "hang") {
        return new Promise<Response>((resolve, reject) => {
          const release = () => {
            hanging.delete(release);
            resolve(new Response("stopped", { status: 503 }));
          };
          hanging.add(release);
          request.signal.addEventListener("abort", () => {
            hanging.delete(release);
            reject(request.signal.reason ?? new DOMException("aborted", "AbortError"));
          });
        });
      }
      if (failure === "network") {
        if (via === "fetch") throw new TypeError("fetch failed: the connection was reset (fake)");
        return new Response("bad gateway (fake network failure)", { status: 502 });
      }
      return json(failure.body ?? googleError(failure.status, "UNKNOWN", "failed (fake)").body, failure.status, failure.headers);
    }

    if (path === "/token" && request.method === "POST") return token(typeof body === "string" ? body : "");
    if (path === "/certs" && request.method === "GET") return json(idTokens.jwks, 200, { "cache-control": `public, max-age=${fake.certsMaxAge}, must-revalidate, no-transform` });
    if (!path.startsWith("/v1/")) return error(404, "NOT_FOUND", `no such path: ${path}`);

    const bearer = call.authorization?.startsWith("Bearer ") ? call.authorization.slice(7) : undefined;
    const expires = bearer === undefined ? undefined : tokens.get(bearer);
    if (expires === undefined || expires <= now()) return error(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    return chat(request.method, path.slice(3), call.query, body);
  }

  async function token(form: string): Promise<Response> {
    const params = new URLSearchParams(form);
    if (params.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json({ error: "unsupported_grant_type", error_description: "Invalid grant_type" }, 400);
    const verified = await verifyJwt(params.get("assertion") ?? "", serviceAccount.publicKey);
    if (verified === undefined) return json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400);
    const { claims } = verified;
    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== serviceAccount.clientEmail) return json({ error: "invalid_grant", error_description: "Invalid issuer" }, 400);
    if (claims.aud !== serviceAccount.tokenUri) return json({ error: "invalid_grant", error_description: "Invalid audience" }, 400);
    if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes("https://www.googleapis.com/auth/chat.bot")) return json({ error: "invalid_scope", error_description: "Invalid scope" }, 400);
    if (typeof claims.exp !== "number" || claims.exp <= seconds || typeof claims.iat !== "number" || claims.iat > seconds + 60) return json({ error: "invalid_grant", error_description: "Invalid JWT: Token must be a short-lived token" }, 400);
    const accessToken = `ya29.fake-${next()}`;
    tokens.set(accessToken, now() + 3600_000);
    fake.tokensIssued += 1;
    return json({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
  }

  function chat(method: string, path: string, query: Record<string, string>, body: unknown): Response {
    if (path.startsWith("/media/")) {
      if (method !== "GET" || query.alt !== "media") return error(400, "INVALID_ARGUMENT", "media.download needs alt=media");
      const found = media.get(path.slice("/media/".length));
      if (found === undefined) return error(404, "NOT_FOUND", "Requested entity was not found.");
      return new Response(found.bytes, { headers: { "content-type": found.contentType, "content-length": String(found.bytes.byteLength) } });
    }
    const parts = path.slice(1).split("/");
    const spaceName = `${parts[0]}/${parts[1]}`;
    if (parts[0] !== "spaces" || parts[1] === undefined) return error(404, "NOT_FOUND", `no such resource: ${path}`);
    const space = spaceOf(spaceName);
    if (space === undefined) return error(404, "NOT_FOUND", "Requested entity was not found.");
    if (parts.length === 2) return method === "GET" ? json(space) : error(405, "METHOD_NOT_ALLOWED", method);
    if (parts[2] !== "messages") return error(404, "NOT_FOUND", `no such resource: ${path}`);
    if (parts.length === 3) return method === "POST" ? create(space, query, body) : error(405, "METHOD_NOT_ALLOWED", method);
    const name = parts.slice(0, 4).join("/");
    const message = messages.get(name);
    switch (method) {
      case "GET":
        return message === undefined ? error(404, "NOT_FOUND", "Requested entity was not found.") : json(message);
      case "DELETE":
        if (message === undefined) return error(404, "NOT_FOUND", "Requested entity was not found.");
        messages.delete(name);
        return json({});
      case "PATCH": {
        const mask = (query.updateMask ?? "").split(",").filter((field) => field !== "");
        if (mask.length === 0) return error(400, "INVALID_ARGUMENT", "updateMask is required.");
        const update = (body ?? {}) as ChatMessage;
        if (message === undefined) {
          const id = parts[3] ?? "";
          if (query.allowMissing !== "true" || !MESSAGE_ID.test(id)) return error(404, "NOT_FOUND", "Requested entity was not found.");
          return create(space, { messageId: id }, update);
        }
        if (JSON.stringify(update).length > MESSAGE_BYTES) return error(400, "INVALID_ARGUMENT", "Message too large.");
        const changed: ChatMessage = { ...message, lastUpdateTime: new Date(now()).toISOString() };
        for (const field of mask) (changed as Record<string, unknown>)[field] = (update as Record<string, unknown>)[field];
        messages.set(name, changed);
        return json(changed);
      }
      default:
        return error(405, "METHOD_NOT_ALLOWED", method);
    }
  }

  function create(space: ChatSpace, query: Record<string, string>, body: unknown): Response {
    const request = query.requestId === undefined ? undefined : `${space.name}|${query.requestId}`;
    const known = request === undefined ? undefined : requests.get(request);
    if (known !== undefined && messages.has(known)) return json(messages.get(known));
    const sent = (body ?? {}) as ChatMessage;
    if (new TextEncoder().encode(JSON.stringify(sent)).byteLength > MESSAGE_BYTES) return error(400, "INVALID_ARGUMENT", "Message too large: a message is at most 32,000 bytes.");
    const messageId = query.messageId;
    if (messageId !== undefined && !MESSAGE_ID.test(messageId)) return error(400, "INVALID_ARGUMENT", "Invalid message id: client- and up to 56 lowercase letters, digits or hyphens.");
    const name = `${space.name}/messages/${messageId ?? next()}`;
    if (messages.has(name)) return error(409, "ALREADY_EXISTS", "Message with the requested message ID already exists.");
    let thread = sent.thread?.name;
    if (thread !== undefined) {
      if (!thread.startsWith(`${space.name}/threads/`)) return error(400, "INVALID_ARGUMENT", "The thread is not in the space.");
      if (!threads.has(thread) && options.strictThreads && query.messageReplyOption === "REPLY_MESSAGE_OR_FAIL") return error(404, "NOT_FOUND", "Thread not found.");
    } else thread = `${space.name}/threads/${next()}`;
    threads.add(thread);
    const message: ChatMessage = {
      ...sent,
      name,
      sender: { name: "users/app", type: "BOT", displayName: "Assistant" },
      createTime: new Date(now()).toISOString(),
      thread: { name: thread },
      space: { name: space.name },
      ...(messageId !== undefined && { clientAssignedMessageId: messageId }),
    };
    messages.set(name, message);
    if (request !== undefined) requests.set(request, name);
    return json(message);
  }

  const fake: FakeGoogleChat = {
    url,
    apiBase: url,
    tokenUri: `${url}/token`,
    jwksUrl: `${url}/certs`,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const target = new URL(request.url);
      const google = Object.entries(GOOGLE_ORIGINS).find(([origin]) => `${target.origin}${target.pathname}`.startsWith(origin));
      if (target.origin !== url && google === undefined) throw new TypeError(`fake Google: no network for ${target.origin}`);
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("aborted", "AbortError");
      const local =
        target.origin === url
          ? request
          : new Request(`${url}${google?.[1] === "" ? target.pathname : google?.[1]}${target.search}`, {
              method: request.method,
              headers: request.headers,
              body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
              signal: request.signal,
            });
      return handle(local, "fetch");
    }) as typeof fetch,
    serviceAccount,
    idTokens,
    secrets: (allowedSpaces = [], prefix = "GOOGLE_CHAT_") => ({
      [`${prefix}SERVICE_ACCOUNT`]: serviceAccount.json,
      [`${prefix}PROJECT_NUMBER`]: idTokens.projectNumber,
      [`${prefix}AUDIENCE`]: idTokens.audience,
      [`${prefix}ALLOWED_SPACES`]: allowedSpaces.join(","),
    }),
    calls,
    callsTo: (match) => calls.filter((call) => matches(match, call)),
    waitForCall: (match, { after = 0, timeoutMs = 2_000 } = {}) =>
      new Promise((resolve, reject) => {
        const look = () => {
          const found = calls.slice(after).find((call) => matches(match, call));
          if (found === undefined) return false;
          waiters.delete(wake);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const wake = () => void look();
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`fake Google: no call matching ${typeof match === "function" ? "the predicate" : JSON.stringify({ method: match.method, path: String(match.path) })} within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.add(wake);
        look();
      }),
    messages,
    spaces,
    addSpace(space) {
      spaces.set(space.name, space);
      removed.delete(space.name);
      return space;
    },
    removeSpace(name) {
      removed.add(name);
    },
    addMessage(message) {
      messages.set(message.name, message);
      if (message.thread?.name !== undefined) threads.add(message.thread.name);
      return message;
    },
    addMedia(resourceName, bytes, contentType) {
      media.set(resourceName, { bytes: typeof bytes === "string" ? encoder.encode(bytes) : bytes, contentType });
    },
    fail(match, failure, times = 1) {
      failures.push({ match, failure, left: times });
    },
    forgetRequests() {
      requests.clear();
    },
    certsMaxAge: 3600,
    tokensIssued: 0,
    async stop() {
      for (const release of [...hanging]) release();
      await server.stop(true);
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------------------------------
// Events

/** The app, as Google names it in a mention. */
export const APP_USER: ChatUser = { name: "users/app", displayName: "Assistant", type: "BOT" };
/** A person who talks to it. */
export const PERSON: ChatUser = { name: "users/1001", displayName: "Ada Lovelace", email: "ada@example.com", type: "HUMAN", domainId: "d1" };

export interface EventOptions {
  /** Default `spaces/AAA`. */
  space?: string;
  /** Default `SPACE`. */
  spaceType?: "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE";
  /** Default `THREADED_MESSAGES`; `null` leaves it out (the app must ask `spaces.get`). */
  threading?: SpaceThreadingState | null;
  /** Default `PERSON`. */
  user?: ChatUser;
  /** Repeated in `authorizationEventObject.systemIdToken`, as Google does. */
  idToken?: string;
}

let events = 0;

function base(options: EventOptions): { space: ChatSpace; user: ChatUser; common: Pick<AddOnEvent, "commonEventObject" | "authorizationEventObject"> } {
  const name = options.space ?? "spaces/AAA";
  const spaceType = options.spaceType ?? "SPACE";
  const threading = options.threading === undefined ? "THREADED_MESSAGES" : options.threading;
  const space: ChatSpace = {
    name,
    spaceType,
    type: spaceType === "DIRECT_MESSAGE" ? "DM" : "ROOM",
    displayName: spaceType === "DIRECT_MESSAGE" ? "" : `Space ${name.slice("spaces/".length)}`,
    ...(spaceType === "DIRECT_MESSAGE" && { singleUserBotDm: true }),
    ...(threading !== null && { spaceThreadingState: threading }),
  };
  return {
    space,
    user: options.user ?? PERSON,
    common: {
      commonEventObject: { hostApp: "CHAT", platform: "WEB", userLocale: "en", timeZone: { id: "Europe/Madrid", offset: 3_600_000 } },
      ...(options.idToken !== undefined && { authorizationEventObject: { systemIdToken: options.idToken } }),
    },
  };
}

export interface MessageEventOptions extends EventOptions {
  text?: string;
  /** Default: a new `spaces/…/messages/m<n>`. */
  name?: string;
  /** Default: a new thread of the space (`spaces/…/threads/t<n>`). */
  thread?: string;
  /** In a space, the text starts with the app's mention (`@Assistant `), annotated, and `argumentText` is without it. Default: `true` outside a DM. */
  mention?: boolean;
  attachments?: ChatAttachment[];
  /** The name of a message this one quotes. */
  quoted?: string;
  threadReply?: boolean;
}

/** A message to the app, as Google posts it. */
export function messageEvent(options: MessageEventOptions = {}): AddOnEvent {
  const { space, user, common } = base(options);
  const n = ++events;
  const mention = options.mention ?? space.spaceType !== "DIRECT_MESSAGE";
  const text = options.text ?? "hello";
  const handle = `@${APP_USER.displayName}`;
  const message: ChatMessage = {
    name: options.name ?? `${space.name}/messages/m${n}`,
    sender: user,
    createTime: new Date().toISOString(),
    text: mention ? `${handle} ${text}` : text,
    argumentText: mention ? ` ${text}` : text,
    thread: { name: options.thread ?? `${space.name}/threads/t${n}` },
    space,
    ...(mention && { annotations: [{ type: "USER_MENTION", startIndex: 0, length: handle.length, userMention: { user: APP_USER, type: "MENTION" } }] }),
    ...(options.attachments !== undefined && { attachment: options.attachments }),
    ...(options.quoted !== undefined && { quotedMessageMetadata: { name: options.quoted, lastUpdateTime: new Date().toISOString() } }),
    ...(options.threadReply !== undefined && { threadReply: options.threadReply }),
  };
  return { ...common, chat: { user, space, eventTime: new Date().toISOString(), messagePayload: { message, space } } };
}

/** The app added to a space. */
export function addedEvent(options: EventOptions & { interactionAdd?: boolean } = {}): AddOnEvent {
  const { space, user, common } = base(options);
  return { ...common, chat: { user, space, eventTime: new Date().toISOString(), addedToSpacePayload: { space, ...(options.interactionAdd !== undefined && { interactionAdd: options.interactionAdd }) } } };
}

/** The app removed from a space. */
export function removedEvent(options: EventOptions = {}): AddOnEvent {
  const { space, user, common } = base(options);
  return { ...common, chat: { user, space, eventTime: new Date().toISOString(), removedFromSpacePayload: { space } } };
}

export interface ClickEventOptions extends EventOptions {
  /** The message whose card was clicked (the app's, from the fake's `messages`); absent for a click inside a dialog. */
  message?: ChatMessage;
  parameters?: Record<string, string>;
  formInputs?: Record<string, FormInput>;
  /** The action's `function` (the endpoint URL). */
  invokedFunction?: string;
  dialogEventType?: "REQUEST_DIALOG" | "SUBMIT_DIALOG" | "CANCEL_DIALOG";
}

/** A button clicked or a form submitted. */
export function clickEvent(options: ClickEventOptions = {}): AddOnEvent {
  const { space, user, common } = base(options);
  return {
    ...common,
    commonEventObject: {
      ...common.commonEventObject,
      ...(options.parameters !== undefined && { parameters: options.parameters }),
      ...(options.formInputs !== undefined && { formInputs: options.formInputs }),
      ...(options.invokedFunction !== undefined && { invokedFunction: options.invokedFunction }),
    },
    chat: {
      user,
      space,
      eventTime: new Date().toISOString(),
      buttonClickedPayload: {
        space,
        ...(options.message !== undefined && { message: options.message }),
        ...(options.dialogEventType !== undefined && { isDialogEvent: true, dialogEventType: options.dialogEventType }),
      },
    },
  };
}

/** A form input of text values (`stringInputs`). */
export const textInput = (...values: string[]): FormInput => ({ stringInputs: { value: values } });
/** A date picker's input (`dateInput`), from `YYYY-MM-DD` (UTC midnight). */
export const dateInput = (day: string): FormInput => ({ dateInput: { msSinceEpoch: String(Date.parse(`${day}T00:00:00Z`)) } });

/** `event` posted to `url` as Google posts it, with `authorization` (a `Bearer …` header) or none. */
export function eventRequest(url: string, event: AddOnEvent | unknown, authorization: string | null): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Google-Workspace-Add-ons", ...(authorization !== null && { authorization }) },
    body: JSON.stringify(event),
  });
}
