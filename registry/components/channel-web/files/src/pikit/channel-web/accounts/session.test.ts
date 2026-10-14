// The Worker's cheap check against cookies the real accounts set.

import { afterEach, expect, test } from "bun:test";
import { type Browser, type Fixture, fixture, ORIGIN, SECRET } from "./accounts.test-support.ts";
import { cachedUser } from "./session.ts";

const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
const make = (options: Parameters<typeof fixture>[0] = {}): Fixture => {
  const f = fixture({ withEmail: false, ...options });
  open.push(f);
  return f;
};

async function signedUp(f: Fixture, email: string, origin = ORIGIN): Promise<Browser> {
  const b = f.browser(undefined, origin);
  const response = await b.send("/chat/api/auth/sign-up/email", { json: { email, password: "correct horse battery", name: "Ana" } });
  if (response.status !== 200) throw new Error(`sign-up: ${response.status}`);
  return b;
}

const withCookies = (b: Browser, jar: Map<string, string> = b.jar): Request =>
  new Request(`${b.origin}/chat/api/conversations`, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });

test("a fresh cache cookie is the user, without the accounts", async () => {
  const f = make();
  const b = await signedUp(f, "ana@example.com");
  expect(await cachedUser(withCookies(b), SECRET)).toEqual({ id: expect.any(String), name: "Ana", email: "ana@example.com", emailVerified: false });

  const secure = await signedUp(f, "bo@example.com", "https://chat.test");
  expect((await cachedUser(withCookies(secure), SECRET))?.email).toBe("bo@example.com");
  // Behind a proxy that hands the App http URLs, `publicUrl` says the cookies are the https ones.
  const proxied = new Request("http://chat.test/chat/api/me", { headers: withCookies(secure).headers });
  expect(await cachedUser(proxied, SECRET)).toBeUndefined();
  expect((await cachedUser(proxied, SECRET, "https://chat.test"))?.email).toBe("bo@example.com");
});

test("a tampered cache, another session's token, the wrong secret or no cookies: none", async () => {
  const f = make();
  const ana = await signedUp(f, "ana@example.com");
  const bo = await signedUp(f, "bo@example.com");

  const data = ana.jar.get("pikit_chat.session_data") ?? "";
  const payload = JSON.parse(atob(decodeURIComponent(data).replace(/-/g, "+").replace(/_/g, "/")));
  payload.session.user.email = "eve@example.com";
  const forged = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tampered = new Map(ana.jar).set("pikit_chat.session_data", forged);
  expect(await cachedUser(withCookies(ana, tampered), SECRET)).toBeUndefined();

  const mixed = new Map(ana.jar).set("pikit_chat.session_token", bo.jar.get("pikit_chat.session_token") ?? "");
  expect(await cachedUser(withCookies(ana, mixed), SECRET)).toBeUndefined();

  const badToken = new Map(ana.jar).set("pikit_chat.session_token", "abc.def");
  expect(await cachedUser(withCookies(ana, badToken), SECRET)).toBeUndefined();

  expect(await cachedUser(withCookies(ana), "another-secret-of-at-least-thirty-two-chars")).toBeUndefined();
  expect(await cachedUser(new Request(`${ORIGIN}/chat/api/me`), SECRET)).toBeUndefined();
  expect((await cachedUser(withCookies(ana), SECRET))?.email).toBe("ana@example.com");
});

test("past its lifetime the cache is none: the caller asks the accounts", async () => {
  const f = make({ sessionCacheSeconds: 1 });
  const b = await signedUp(f, "ana@example.com");
  expect((await cachedUser(withCookies(b), SECRET))?.email).toBe("ana@example.com");
  await Bun.sleep(1100);
  expect(await cachedUser(withCookies(b), SECRET)).toBeUndefined();
  expect((await b.user())?.email).toBe("ana@example.com");
});
