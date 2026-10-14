// Owner: ingress. Google's ID token checked with WebCrypto against the fake's keys (token.ts).
/**
 * The verifier and Google's keys, against the fake Google's JWKs and ID tokens signed with its test key
 * pair, on a clock the tests move: every claim the feature note names refused when wrong, a malformed
 * token refused, the keys kept as `Cache-Control` says, fetched again for an unknown `kid` at most once
 * a minute and once for concurrent requests, and a failed fetch a rejection (the route's 500), never a
 * refusal.
 */

import { afterEach, expect, test } from "bun:test";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import { base64url, createIdTokens, type FakeGoogleChat, startFakeGoogleChat, type TestIdTokens } from "./fake-google-chat.test-support.ts";
import { addOnEmail } from "./instance.ts";
import { CLOCK_SKEW_MS, createIdTokenVerifier, createJwks, REFETCH_MS } from "./token.ts";
import type { IdTokenVerifier, Verification } from "./types.ts";

const fakes: FakeGoogleChat[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

interface Setup {
  google: FakeGoogleChat;
  clock: ManualClock;
  verifier: IdTokenVerifier;
  certs: () => number;
}

/** The fake Google on a manual clock, and a verifier of its tokens through its `fetch` double. */
async function setup(): Promise<Setup> {
  const clock = createManualClock(Date.now());
  const google = await startFakeGoogleChat({ now: clock.now });
  fakes.push(google);
  const jwks = createJwks({ url: google.jwksUrl, clock, fetch: google.fetch });
  const verifier = createIdTokenVerifier({ jwks, audience: google.idTokens.audience, email: addOnEmail(google.idTokens.projectNumber), clock });
  return { google, clock, verifier, certs: () => google.callsTo({ path: "/certs" }).length };
}

const reasonOf = (verification: Verification): string => (verification.ok ? "accepted" : verification.reason);

test("a token Google signed for this app is accepted, with its claims; Google's keys are fetched once, on first use", async () => {
  const { google, verifier, certs } = await setup();
  expect(certs()).toBe(0);
  const verification = await verifier.verify(await google.idTokens.bearer());
  expect(verification).toEqual({ ok: true, claims: expect.objectContaining({ aud: google.idTokens.audience, email: addOnEmail(google.idTokens.projectNumber), email_verified: true }) });
  expect((await verifier.verify(await google.idTokens.bearer({ iss: "accounts.google.com" }))).ok).toBe(true);
  expect((await verifier.verify(`bearer   ${await google.idTokens.sign()}`)).ok).toBe(true);
  expect(certs()).toBe(1);
});

test("each claim the note names, wrong, is refused, and the reason never holds the token", async () => {
  const { google, verifier } = await setup();
  const cases: [string, string, RegExp][] = [
    ["another issuer", await google.idTokens.bearer({ iss: "https://evil.example" }), /issuer/],
    ["another audience", await google.idTokens.bearer({ aud: "https://elsewhere.example/google-chat" }), /audience/],
    ["the audience with a trailing slash", await google.idTokens.bearer({ aud: `${google.idTokens.audience}/` }), /audience/],
    ["another project's service account", await google.idTokens.bearer({ email: addOnEmail("999") }), /email/],
    ["Chat's shared sender", await google.idTokens.bearer({ email: "chat@system.gserviceaccount.com" }), /email/],
    ["an email not verified", await google.idTokens.bearer({ email_verified: false }), /not verified/],
    ["another key, same kid", await google.idTokens.bearer({}, { foreignKey: true }), /signature/],
    ["a kid Google does not publish", await google.idTokens.bearer({}, { kid: "nobody" }), /does not publish/],
  ];
  for (const [what, authorization, reason] of cases) {
    const verification = await verifier.verify(authorization);
    expect({ what, reason: reasonOf(verification) }).toEqual({ what, reason: expect.stringMatching(reason) });
    expect(reasonOf(verification)).not.toContain(authorization.slice("Bearer ".length));
  }
});

test("expiry: a token past exp beyond the skew is refused, within it accepted; a token issued in the future is refused", async () => {
  const { google, verifier, clock } = await setup();
  const seconds = Math.floor(clock.now() / 1000);
  expect(reasonOf(await verifier.verify(await google.idTokens.bearer({ exp: seconds - Math.ceil(CLOCK_SKEW_MS / 1000) - 1 })))).toMatch(/expired/);
  expect((await verifier.verify(await google.idTokens.bearer({ exp: seconds - 10 }))).ok).toBe(true);
  expect(reasonOf(await verifier.verify(await google.idTokens.bearer({ iat: seconds + 3600 })))).toMatch(/future/);

  // A token valid now, then an hour and two minutes later.
  const token = await google.idTokens.bearer();
  expect((await verifier.verify(token)).ok).toBe(true);
  await clock.advance(3_600_000 + CLOCK_SKEW_MS + 1_000);
  expect(reasonOf(await verifier.verify(token))).toMatch(/expired/);
});

test("malformed: no header, not a bearer, not three base64url JSON parts, alg not RS256, no kid; none fetches Google's keys", async () => {
  const { google, verifier, certs } = await setup();
  const valid = await google.idTokens.sign();
  const [header = "", claims = "", signature = ""] = valid.split(".");
  const tokens: [string | null, RegExp][] = [
    [null, /no Authorization/],
    ["", /not a bearer/],
    [`Basic ${valid}`, /not a bearer/],
    ["Bearer", /not a bearer/],
    [`Bearer ${header}.${claims}`, /three parts/],
    [`Bearer ${header}.${claims}.${signature}.x`, /three parts/],
    [`Bearer ${header}.${claims}.${signature}=`, /base64url/],
    [`Bearer ${base64url("not json")}.${claims}.${signature}`, /base64url JSON/],
    [`Bearer ${base64url("[1]")}.${claims}.${signature}`, /base64url JSON/],
    [`Bearer ${header}.${base64url('"a string"')}.${signature}`, /base64url JSON/],
    [`Bearer ${"a".repeat(9_000)}.b.c`, /too long/],
    [`Bearer ${base64url(JSON.stringify({ alg: "none", kid: google.idTokens.kid }))}.${claims}.`, /RS256|base64url/],
    [`Bearer ${base64url(JSON.stringify({ alg: "HS256", kid: google.idTokens.kid }))}.${claims}.${signature}`, /alg is "HS256"/],
    [`Bearer ${base64url(JSON.stringify({ alg: "RS256" }))}.${claims}.${signature}`, /no key/],
  ];
  for (const [authorization, reason] of tokens) expect(reasonOf(await verifier.verify(authorization))).toMatch(reason);
  expect(certs()).toBe(0);

  // Signed, but its claims cannot be checked: no exp.
  const noExp = await google.idTokens.sign({ exp: undefined as unknown as number });
  expect(reasonOf(await verifier.verify(`Bearer ${noExp}`))).toMatch(/no expiry/);
});

test("the keys are kept as Cache-Control says (a minute at least), then fetched again", async () => {
  const { google, verifier, clock, certs } = await setup();
  google.certsMaxAge = 600;
  expect((await verifier.verify(await google.idTokens.bearer())).ok).toBe(true);
  await clock.advance(599_000);
  expect((await verifier.verify(await google.idTokens.bearer())).ok).toBe(true);
  expect(certs()).toBe(1);
  await clock.advance(2_000);
  expect((await verifier.verify(await google.idTokens.bearer())).ok).toBe(true);
  expect(certs()).toBe(2);

  // max-age=0 is kept a minute: every request does not fetch.
  google.certsMaxAge = 0;
  await clock.advance(601_000);
  for (let i = 0; i < 3; i++) expect((await verifier.verify(await google.idTokens.bearer())).ok).toBe(true);
  expect(certs()).toBe(3);
  await clock.advance(REFETCH_MS);
  expect((await verifier.verify(await google.idTokens.bearer())).ok).toBe(true);
  expect(certs()).toBe(4);
});

/** Google's keys served by hand: `serve` is what the next fetch gets. */
function servedKeys(clock: ManualClock) {
  let fetches = 0;
  let keys: unknown[] = [];
  let failure: number | "network" | undefined;
  let gate: Promise<void> | undefined;
  const fetcher = (async () => {
    fetches += 1;
    await gate;
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure !== undefined) return new Response("unavailable", { status: failure });
    return Response.json({ keys }, { headers: { "cache-control": "public, max-age=21600" } });
  }) as unknown as typeof fetch;
  const jwks = createJwks({ url: "https://www.googleapis.com/oauth2/v3/certs", clock, fetch: fetcher });
  return {
    jwks,
    fetches: () => fetches,
    serve: (...sets: TestIdTokens[]) => void (keys = sets.flatMap((set) => set.jwks.keys)),
    fail: (with_: number | "network" | undefined) => void (failure = with_),
    hold: () => {
      let release = () => {};
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

test("a kid the keys lack fetches them again at most once a minute: a rotated key is found, a forged kid makes no stampede", async () => {
  const clock = createManualClock(Date.now());
  const options = { audience: "https://pikit.test/google-chat", projectNumber: "123456789012", now: clock.now };
  const [current, next] = [await createIdTokens(options), await createIdTokens(options)];
  const google = servedKeys(clock);
  google.serve(current);
  const verifier = createIdTokenVerifier({ jwks: google.jwks, audience: options.audience, email: addOnEmail(options.projectNumber), clock });
  expect((await verifier.verify(await current.bearer())).ok).toBe(true);
  expect(google.fetches()).toBe(1);

  // Google rotates: the next key is published. Within the minute, its kid is not fetched for.
  google.serve(current, next);
  expect(reasonOf(await verifier.verify(await next.bearer()))).toMatch(/does not publish/);
  expect(google.fetches()).toBe(1);
  await clock.advance(REFETCH_MS);
  expect((await verifier.verify(await next.bearer())).ok).toBe(true);
  expect(google.fetches()).toBe(2);

  // A newer key, asked for by several requests while its fetch is in flight: they wait for it, one fetch.
  const newest = await createIdTokens(options);
  google.serve(current, next, newest);
  const newestToken = await newest.bearer();
  await clock.advance(REFETCH_MS);
  const holding = google.hold();
  const waiting = Promise.all(Array.from({ length: 5 }, () => verifier.verify(newestToken)));
  await clock.advance(0);
  holding();
  for (const verification of await waiting) expect(verification.ok).toBe(true);
  expect(google.fetches()).toBe(3);

  // Forged kids, many at once, then again a minute later: one fetch each time.
  await clock.advance(REFETCH_MS);
  const forgedTokens = await Promise.all(Array.from({ length: 20 }, (_, i) => current.bearer({}, { kid: `forged-${i}` })));
  const release = google.hold();
  const forged = Promise.all(forgedTokens.map((token) => verifier.verify(token)));
  await clock.advance(0);
  release();
  for (const verification of await forged) expect(reasonOf(verification)).toMatch(/does not publish/);
  expect(google.fetches()).toBe(4);
  for (let i = 0; i < 20; i++) await verifier.verify(await current.bearer({}, { kid: `forged-again-${i}` }));
  expect(google.fetches()).toBe(4);
  // The known key still verifies, from the keys kept.
  expect((await verifier.verify(await current.bearer())).ok).toBe(true);
  expect(google.fetches()).toBe(4);
});

test("Google's keys unreachable: verify rejects (the route answers 500, Google retries), never refuses; the next request fetches again", async () => {
  const clock = createManualClock(Date.now());
  const options = { audience: "https://pikit.test/google-chat", projectNumber: "123456789012", now: clock.now };
  const tokens = await createIdTokens(options);
  const google = servedKeys(clock);
  google.serve(tokens);
  const verifier = createIdTokenVerifier({ jwks: google.jwks, audience: options.audience, email: addOnEmail(options.projectNumber), clock });

  google.fail(503);
  await expect(verifier.verify(await tokens.bearer())).rejects.toThrow(/answered 503/);
  google.fail("network");
  await expect(verifier.verify(await tokens.bearer())).rejects.toThrow(/could not be fetched/);
  google.fail(undefined);
  google.serve();
  await expect(verifier.verify(await tokens.bearer())).rejects.toThrow(/no RS256 key/);
  google.serve(tokens);
  expect((await verifier.verify(await tokens.bearer())).ok).toBe(true);
  expect(google.fetches()).toBe(4);
});

test("concurrent first requests share one fetch; a caller that gives up does not fail the others", async () => {
  const clock = createManualClock(Date.now());
  const options = { audience: "https://pikit.test/google-chat", projectNumber: "123456789012", now: clock.now };
  const tokens = await createIdTokens(options);
  const google = servedKeys(clock);
  google.serve(tokens);
  const verifier = createIdTokenVerifier({ jwks: google.jwks, audience: options.audience, email: addOnEmail(options.projectNumber), clock });
  const token = await tokens.bearer();
  const release = google.hold();
  const giving = new AbortController();
  const first = verifier.verify(token, giving.signal);
  const others = Promise.all(Array.from({ length: 5 }, () => verifier.verify(token)));
  await clock.advance(0);
  giving.abort(new Error("gave up"));
  await expect(first).rejects.toThrow(/gave up/);
  release();
  for (const verification of await others) expect(verification.ok).toBe(true);
  expect(google.fetches()).toBe(1);
});

test("a token signed with RS256 by a key whose JWK says another alg is not accepted", async () => {
  const clock = createManualClock(Date.now());
  const options = { audience: "https://pikit.test/google-chat", projectNumber: "123456789012", now: clock.now };
  const tokens = await createIdTokens(options);
  const google = servedKeys(clock);
  google.serve({ ...tokens, jwks: { keys: tokens.jwks.keys.map((key) => ({ ...key, alg: "RS512" })) } });
  const verifier = createIdTokenVerifier({ jwks: google.jwks, audience: options.audience, email: addOnEmail(options.projectNumber), clock });
  await expect(verifier.verify(await tokens.bearer())).rejects.toThrow(/no RS256 key/);
});
