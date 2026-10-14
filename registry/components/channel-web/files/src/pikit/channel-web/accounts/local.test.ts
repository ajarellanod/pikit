// createLocalAccounts end to end through better-auth's routes: password, magic link, OIDC (a fake
// provider on a local Bun.serve), the sign-up policy for each, invitations, resets, bans, removal,
// the operator's list, cookies and the session cache. No network.

import { afterEach, expect, setSystemTime, test } from "bun:test";
import { ActorCallError } from "@pikit/contracts";
import { hashPassword } from "better-auth/crypto";
import { Browser, type Fixture, fakeOidc, fixture, linkIn, ORIGIN, type Profile } from "./accounts.test-support.ts";
import { allowed, createLocalAccounts } from "./local.ts";

const open: Fixture[] = [];
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
  for (const stop of stops.splice(0)) await stop();
});
const make = (options: Parameters<typeof fixture>[0] = {}): Fixture => {
  const f = fixture(options);
  open.push(f);
  return f;
};

const PASSWORD = "correct horse battery";
const signUp = (b: Browser, email: string, password = PASSWORD) => b.send("/chat/api/auth/sign-up/email", { json: { email, password, name: "Ana" } });
const signIn = (b: Browser, email: string, password = PASSWORD) => b.send("/chat/api/auth/sign-in/email", { json: { email, password } });
const codeOf = async (response: Response): Promise<string | undefined> => ((await response.json()) as { code?: string }).code;
const refusedWith = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ActorCallError) return error.code;
    throw error;
  }
  throw new Error("not refused");
};

test("scrypt: one password hash's cost (better-auth's default)", async () => {
  await hashPassword("warm up the code");
  const started = performance.now();
  await hashPassword(PASSWORD);
  const ms = performance.now() - started;
  console.log(`channel-web accounts: one scrypt password hash took ${ms.toFixed(1)} ms`);
  expect(ms).toBeGreaterThan(0);
});

test("password: sign up, then sign in; the session is the user's", async () => {
  const f = make({ withEmail: false });
  const b = f.browser();
  const up = await signUp(b, "Ana@Example.com");
  expect(up.status).toBe(200);
  expect(await b.user()).toEqual({ id: expect.any(String), name: "Ana", email: "ana@example.com", emailVerified: false });

  const other = f.browser();
  expect(await other.user()).toBeUndefined();
  expect((await signIn(other, "ana@example.com", "wrong password")).status).toBe(401);
  expect((await signIn(other, "ana@example.com")).status).toBe(200);
  expect((await other.user())?.email).toBe("ana@example.com");
  expect(await f.accounts.methods((await other.user())?.id ?? "", f.ctx)).toEqual(["password"]);
});

test("cookies: pikit_chat.*, path /chat/, HttpOnly, SameSite=Lax; __Secure- and Secure on https", async () => {
  const f = make({ withEmail: false });
  const plain = await signUp(f.browser(), "ana@example.com");
  const cookies = plain.headers.getSetCookie();
  expect(cookies.map((c) => c.split("=")[0]).sort()).toEqual(["pikit_chat.session_data", "pikit_chat.session_token"]);
  for (const cookie of cookies) {
    expect(cookie).toContain("Path=/chat/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("/admin");
  }

  const secure = f.browser(undefined, "https://localhost:3443");
  const response = await signUp(secure, "bo@example.com");
  const names = response.headers.getSetCookie().map((c) => c.split("=")[0]).sort();
  expect(names).toEqual(["__Secure-pikit_chat.session_data", "__Secure-pikit_chat.session_token"]);
  for (const cookie of response.headers.getSetCookie()) expect(cookie).toContain("; Secure");
  expect((await secure.user())?.email).toBe("bo@example.com");
});

test("session: the cookie cache answers without the database; past it, the database does", async () => {
  const f = make({ withEmail: false, sessionCacheSeconds: 1 });
  const ana = f.browser();
  await signUp(ana, "ana@example.com");
  const bo = f.browser();
  await signUp(bo, "bo@example.com");
  const anaId = (await ana.user())?.id;

  await f.sql.run(`DELETE FROM channel_web_session WHERE "userId" = ?`, [anaId ?? ""]);
  expect((await ana.user())?.email).toBe("ana@example.com"); // the cache: no database read

  await Bun.sleep(1100);
  expect(await ana.user()).toBeUndefined(); // the database: the session is gone
  expect((await bo.user())?.email).toBe("bo@example.com"); // the database: still there
});

test("session: read from the database, it comes with a renewed cookie cache, which then vouches without the database; from the cache, no cookie", async () => {
  const f = make({ withEmail: false, sessionCacheSeconds: 1 });
  const ana = f.browser();
  await signUp(ana, "ana@example.com");
  expect((await ana.session())?.cookies).toEqual([]); // the cache vouched: nothing to renew

  await Bun.sleep(1100);
  const renewed = await ana.session();
  expect(renewed?.user.email).toBe("ana@example.com");
  // The expired cache cleared, then the new one (a browser keeps the last).
  expect(renewed?.cookies.map((cookie) => cookie.split("=")[0])).toEqual(["pikit_chat.session_data", "pikit_chat.session_data"]);
  expect(renewed?.cookies[0]).toMatch(/Max-Age=0/i);
  expect(renewed?.cookies[1]).not.toMatch(/Max-Age=0/i);
  for (const cookie of renewed?.cookies ?? []) expect(cookie).toContain("Path=/chat/");

  // The renewed cache answers alone: the session row gone, the user is still vouched for (within its lifetime).
  await f.sql.run(`DELETE FROM channel_web_session WHERE "userId" = ?`, [renewed?.user.id ?? ""]);
  expect(await ana.session()).toMatchObject({ user: { email: "ana@example.com" }, cookies: [] });
  // A cache hit renews nothing: past its lifetime the database answers, and the session is gone.
  await Bun.sleep(1100);
  expect(await ana.user()).toBeUndefined();
});

test("signUp invite: password, magic link and OIDC sign-ups are all refused", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  const f = make({
    mode: "invite",
    oidc: [{ id: "corp", name: "Corp", discoveryUrl: oidc.discoveryUrl, clientId: "corp-client", clientSecret: "corp-secret" }],
  });

  // With email verification on, better-auth answers a refused sign-up as a fresh one (no account
  // enumeration): nothing is made and nothing is sent.
  const password = await signUp(f.browser(), "ana@example.com");
  expect(password.status).toBe(200);
  expect(f.emails).toHaveLength(0);
  const plain = make({ withEmail: false, mode: "invite" });
  const refused = await signUp(plain.browser(), "ana@example.com");
  expect(refused.status).toBe(403);
  expect(await codeOf(refused)).toBe("SIGN_UP_NOT_ALLOWED");

  const link = await magicLinkLanding(f, "ana@example.com");
  expect(link.status).toBe(302);
  expect(link.headers.get("location")).toContain("error=SIGN_UP_NOT_ALLOWED");

  const sso = await oidcLanding(f, oidc, { sub: "s1", email: "ana@example.com", email_verified: true, name: "Ana" });
  expect(sso.response.headers.get("location")).toContain("error=SIGN_UP_NOT_ALLOWED");
  expect(await sso.browser.user()).toBeUndefined();

  const [users] = await f.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM channel_web_user");
  expect(users?.n).toBe(0);
});

test("signUp allowlist: by email and by @domain, verified only; others refused", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  const f = make({
    mode: "allowlist",
    allow: ["ana@example.com", "@corp.test"],
    oidc: [{ id: "corp", name: "Corp", discoveryUrl: oidc.discoveryUrl, clientId: "corp-client", clientSecret: "corp-secret" }],
  });

  // Password: admitted, then verified by email before any session.
  const ana = f.browser();
  const up = await signUp(ana, "ANA@example.com");
  expect(up.status).toBe(200);
  expect(await ana.user()).toBeUndefined();
  expect(f.emails.at(-1)?.message.to).toBe("ana@example.com");
  const sent = f.emails.length;
  expect((await signUp(f.browser(), "eve@example.com")).status).toBe(200); // answered as a fresh one
  expect(f.emails).toHaveLength(sent);

  // Magic link: by domain.
  const link = await magicLinkLanding(f, "bo@corp.test");
  expect(link.headers.get("location")).toBe(`${ORIGIN}/chat/`);
  expect((await magicLinkLanding(f, "eve@other.test")).headers.get("location")).toContain("error=SIGN_UP_NOT_ALLOWED");

  // OIDC: by domain, the provider's email verified; an unverified one is refused.
  const cy = await oidcLanding(f, oidc, { sub: "cy", email: "cy@corp.test", email_verified: true, name: "Cy" });
  expect(cy.response.headers.get("location")).toBe("/chat/");
  expect((await cy.browser.user())?.email).toBe("cy@corp.test");
  const unverified = await oidcLanding(f, oidc, { sub: "dee", email: "dee@corp.test", email_verified: false, name: "Dee" });
  expect(unverified.response.headers.get("location")).toContain("error=SIGN_UP_NOT_ALLOWED");
  const outsider = await oidcLanding(f, oidc, { sub: "eve", email: "eve@other.test", email_verified: true, name: "Eve" });
  expect(outsider.response.headers.get("location")).toContain("error=SIGN_UP_NOT_ALLOWED");
});

test("signUp allowlist without email.send: a password sign-up, which nothing verifies, is refused", async () => {
  const f = make({ withEmail: false, mode: "allowlist", allow: ["@example.com"] });
  const response = await signUp(f.browser(), "ana@example.com");
  expect(response.status).toBe(403);
  expect(await codeOf(response)).toBe("SIGN_UP_NOT_ALLOWED");
});

test("signUp open: password, magic link and OIDC sign-ups are admitted; the policy is read live", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  const f = make({
    mode: "invite",
    oidc: [{ id: "corp", name: "Corp", discoveryUrl: oidc.discoveryUrl, clientId: "corp-client", clientSecret: "corp-secret" }],
  });
  await signUp(f.browser(), "ana@example.com");
  expect(f.emails).toHaveLength(0);
  f.policy.mode = "open";
  expect((await signUp(f.browser(), "ana@example.com")).status).toBe(200);
  expect(f.emails.map((e) => e.message.subject)).toEqual(["Confirm your email for Ada"]);
  expect((await magicLinkLanding(f, "bo@example.com")).headers.get("location")).toBe(`${ORIGIN}/chat/`);
  const cy = await oidcLanding(f, oidc, { sub: "cy", email: "cy@example.com", email_verified: true, name: "Cy" });
  expect(cy.response.headers.get("location")).toBe("/chat/");
  expect(await f.accounts.methods((await cy.browser.user())?.id ?? "", f.ctx)).toEqual(["corp"]);
});

test("a sign-up cannot mark itself invited (invitedAt is not an input)", async () => {
  const f = make({ withEmail: false, mode: "invite" });
  const response = await f.browser().send("/chat/api/auth/sign-up/email", {
    json: { email: "eve@example.com", password: PASSWORD, name: "Eve", invitedAt: new Date().toISOString() },
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect((await f.accounts.list({ limit: 10 }, f.ctx)).items).toEqual([]);
});

test("invite: a link that sets a password, then signs in; emailed; exists once in use", async () => {
  const f = make({ mode: "invite" });
  const invited = await f.accounts.invite({ email: "Ana@Example.com", name: "Ana" }, "https://bot.example.com", f.ctx);
  expect(invited.link).toMatch(/^https:\/\/bot\.example\.com\/chat\/#\/set-password\?token=[\w-]+&email=ana%40example\.com&invite=1$/);
  expect(invited.emailed).toBe(true);
  expect(invited.expiresAt).toBeGreaterThan(Date.now() + 71 * 3_600_000);
  expect(f.emails).toHaveLength(1);
  expect(f.emails[0]?.message).toMatchObject({ to: "ana@example.com", subject: "You are invited to Ada" });
  expect(f.emails[0]?.message.text).toContain(invited.link);
  expect(f.emails[0]?.ctx).toBe(f.ctx);

  // Before it is used, inviting again gives a new link.
  const again = await f.accounts.invite({ email: "ana@example.com" }, ORIGIN, f.ctx);
  expect(again.userId).toBe(invited.userId);

  const token = new URL(invited.link.replace("#/", "")).searchParams.get("token");
  const b = f.browser();
  expect((await b.send("/chat/api/auth/reset-password", { json: { token, newPassword: PASSWORD } })).status).toBe(200);
  expect((await b.send("/chat/api/auth/reset-password", { json: { token, newPassword: "another password" } })).status).toBe(400);
  expect((await signIn(b, "ana@example.com")).status).toBe(200);
  expect(await b.user()).toMatchObject({ id: invited.userId, email: "ana@example.com", name: "Ana", emailVerified: true });

  expect(await refusedWith(f.accounts.invite({ email: "ana@example.com" }, ORIGIN, f.ctx))).toBe("exists");
  expect(await refusedWith(f.accounts.invite({ email: "not an email" }, ORIGIN, f.ctx))).toBe("invalid_request");
});

test("invite without email.send: the link only, for the operator to hand over", async () => {
  const f = make({ withEmail: false, mode: "invite" });
  const invited = await f.accounts.invite({ email: "ana@example.com" }, ORIGIN, f.ctx);
  expect(invited.emailed).toBe(false);
  expect(invited.link.startsWith(`${ORIGIN}/chat/#/set-password?token=`)).toBe(true);
});

test("an invited user signs in with a provider whose verified email is theirs (linked); an unverified one is not", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  const f = make({
    mode: "invite",
    oidc: [{ id: "corp", name: "Corp", discoveryUrl: oidc.discoveryUrl, clientId: "corp-client", clientSecret: "corp-secret" }],
  });
  const ana = await f.accounts.invite({ email: "ana@example.com" }, ORIGIN, f.ctx);
  const bo = await f.accounts.invite({ email: "bo@example.com" }, ORIGIN, f.ctx);

  const unverified = await oidcLanding(f, oidc, { sub: "bo", email: "bo@example.com", email_verified: false, name: "Bo" });
  expect(unverified.response.headers.get("location")).toContain("error=");
  expect(await f.accounts.methods(bo.userId, f.ctx)).toEqual([]);

  const verified = await oidcLanding(f, oidc, { sub: "ana", email: "ana@example.com", email_verified: true, name: "Ana" });
  expect(verified.response.headers.get("location")).toBe("/chat/");
  expect((await verified.browser.user())?.id).toBe(ana.userId);
  expect(await f.accounts.methods(ana.userId, f.ctx)).toEqual(["corp"]);
});

test("resetLink: a new password works, the old does not; not_found for no user", async () => {
  const f = make({ withEmail: false, sessionCacheSeconds: 0 });
  const b = f.browser();
  await signUp(b, "ana@example.com");
  const id = (await b.user())?.id ?? "";
  const reset = await f.accounts.resetLink(id, ORIGIN, f.ctx);
  expect(reset.link).toMatch(/\/chat\/#\/set-password\?token=[\w-]+&email=ana%40example\.com$/);
  const token = new URL(reset.link.replace("#/", "")).searchParams.get("token");
  expect((await b.send("/chat/api/auth/reset-password", { json: { token, newPassword: "a brand new password" } })).status).toBe(200);
  expect(await b.user()).toBeUndefined(); // sessions revoked on reset
  expect((await signIn(f.browser(), "ana@example.com")).status).toBe(401);
  expect((await signIn(f.browser(), "ana@example.com", "a brand new password")).status).toBe(200);
  expect(await refusedWith(f.accounts.resetLink("nobody", ORIGIN, f.ctx))).toBe("not_found");
});

test("forgot password by email: a link to the page that sets it", async () => {
  const f = make();
  const ana = await f.accounts.invite({ email: "ana@example.com" }, ORIGIN, f.ctx);
  f.emails.length = 0;
  const b = f.browser();
  expect((await b.send("/chat/api/auth/request-password-reset", { json: { email: "ana@example.com", redirectTo: "/chat/" } })).status).toBe(200);
  const link = linkIn(f.emails[0]?.message.text ?? "");
  expect(link.startsWith(`${ORIGIN}/chat/#/set-password?token=`)).toBe(true);
  expect(new URL(link.replace("#/", "")).searchParams.get("email")).toBe("ana@example.com");
  expect(f.emails[0]?.message.subject).toBe("Set your password for Ada");
  const token = new URL(link.replace("#/", "")).searchParams.get("token");
  expect((await b.send("/chat/api/auth/reset-password", { json: { token, newPassword: PASSWORD } })).status).toBe(200);
  expect((await signIn(b, "ana@example.com")).status).toBe(200);
  expect((await b.user())?.id).toBe(ana.userId);
});

test("a password sign-up with email: its password is nobody's; the emailed link sets the first one, which verifies the email", async () => {
  const f = make({ mode: "open" });
  const b = f.browser();
  expect((await signUp(b, "ana@example.com")).status).toBe(200);
  expect(await b.user()).toBeUndefined();
  // The password the sign-up came with never works, verified or not.
  expect((await signIn(f.browser(), "ana@example.com")).status).toBe(401);
  expect(f.emails.map((e) => e.message.subject)).toEqual(["Confirm your email for Ada"]);
  const link = linkIn(f.emails[0]?.message.text ?? "");
  expect(link).toMatch(new RegExp(`^${ORIGIN}/chat/#/set-password\\?token=[\\w-]+&email=ana%40example\\.com&welcome=1$`));
  const token = new URL(link.replace("#/", "")).searchParams.get("token");
  expect((await b.send("/chat/api/auth/reset-password", { json: { token, newPassword: "ana's own password" } })).status).toBe(200);
  expect((await signIn(b, "ana@example.com", "ana's own password")).status).toBe(200);
  expect(await b.user()).toMatchObject({ email: "ana@example.com", emailVerified: true });
  // Signing in again sends nothing (no verification email on sign-in).
  expect(f.emails).toHaveLength(1);
});

test("SQUATTING: a sign-up with another person's address and a password of the attacker's never lets the attacker in once the owner comes", async () => {
  const f = make({ mode: "open" });
  const attacker = f.browser();
  expect((await signUp(attacker, "victim@example.com", "attacker's password")).status).toBe(200);
  // The owner signs in with a magic link: the address is verified, the account theirs.
  const owner = await magicLinkLanding(f, "victim@example.com");
  expect(owner.status).toBe(302);
  const late = f.browser();
  expect((await signIn(late, "victim@example.com", "attacker's password")).status).toBe(401);
  expect(await late.user()).toBeUndefined();

  // Or the owner opens the confirmation the sign-up sent them, and sets their own password.
  const g = make({ mode: "open" });
  await signUp(g.browser(), "owner@example.com", "attacker's password");
  const token = new URL(linkIn(g.emails[0]?.message.text ?? "").replace("#/", "")).searchParams.get("token");
  expect((await g.browser().send("/chat/api/auth/reset-password", { json: { token, newPassword: "the owner's password" } })).status).toBe(200);
  expect((await signIn(g.browser(), "owner@example.com", "attacker's password")).status).toBe(401);
  expect((await signIn(g.browser(), "owner@example.com", "the owner's password")).status).toBe(200);
  // However the sign-up is spelled (a form, a trailing slash), its password is nobody's.
  for (const [path, type, body] of [
    ["/chat/api/auth/sign-up/email", "application/x-www-form-urlencoded", "email=form%40example.com&password=attackers-pass&name=x"],
    ["/chat/api/auth/sign-up/email/", "application/json", JSON.stringify({ email: "slash@example.com", password: "attackers-pass", name: "x" })],
  ] as const) {
    await g.accounts.handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": type }, body }), g.ctx);
  }
  for (const email of ["form@example.com", "slash@example.com"]) expect({ email, status: (await signIn(g.browser(), email, "attackers-pass")).status }).toEqual({ email, status: 401 });
});

test("HOST: without publicUrl, a server's accounts answer only a loopback host; another (a spoofed Host) is 400 and makes no link nor email", async () => {
  const f = make({ mode: "open" });
  await f.accounts.invite({ email: "victim@example.com" }, ORIGIN, f.ctx);
  f.emails.length = 0;
  const evil = f.browser(undefined, "http://evil.example");
  for (const [path, json] of [
    ["/chat/api/auth/request-password-reset", { email: "victim@example.com", redirectTo: "/chat/" }],
    ["/chat/api/auth/sign-in/magic-link", { email: "victim@example.com", callbackURL: "/chat/" }],
    ["/chat/api/auth/sign-up/email", { email: "new@example.com", password: PASSWORD, name: "x" }],
  ] as const) {
    const response = await evil.send(path, { json });
    expect({ path, status: response.status, body: await response.json() }).toEqual({ path, status: 400, body: { error: "public_url_required", message: expect.any(String) } });
  }
  expect(f.emails).toEqual([]);
  // Each loopback host works, any port: development.
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:8080"]) {
    expect((await f.browser(undefined, origin).send("/chat/api/auth/request-password-reset", { json: { email: "victim@example.com", redirectTo: "/chat/" } })).status).toBe(200);
    expect(linkIn(f.emails.at(-1)?.message.text ?? "").startsWith(`${origin}/chat/#/set-password?token=`)).toBe(true);
  }
  // On Cloudflare the Worker's own host is trusted (Cloudflare routes by it).
  const cloud = make({ mode: "open", trustRequestHost: true });
  await cloud.browser(undefined, "https://chat.example.workers.dev").send("/chat/api/auth/sign-in/magic-link", { json: { email: "ana@example.com", callbackURL: "/chat/" } });
  expect(linkIn(cloud.emails[0]?.message.text ?? "").startsWith("https://chat.example.workers.dev/chat/api/auth/magic-link/verify?")).toBe(true);
  // With publicUrl, any host is answered and every link is under publicUrl.
  const pub = make({ mode: "open", publicUrl: "https://bot.example.com" });
  const spoofed = new Browser(pub.accounts, pub.ctx, "https://bot.example.com", "10.9.9.9");
  const request = spoofed.build("/chat/api/auth/sign-in/magic-link", { json: { email: "ana@example.com", callbackURL: "/chat/" } });
  const evilUrl = new Request(request.url.replace("bot.example.com", "evil.example"), { method: "POST", headers: request.headers, body: await request.text() });
  expect((await pub.accounts.handle(evilUrl, pub.ctx)).status).toBe(200);
  expect(linkIn(pub.emails[0]?.message.text ?? "").startsWith("https://bot.example.com/chat/api/auth/magic-link/verify?")).toBe(true);
});

test("magic link: the emailed link signs in", async () => {
  const f = make({ mode: "open" });
  const b = f.browser();
  expect((await b.send("/chat/api/auth/sign-in/magic-link", { json: { email: "ana@example.com", callbackURL: "/chat/" } })).status).toBe(200);
  const sent = f.emails[0];
  expect(sent?.message).toMatchObject({ to: "ana@example.com", subject: "Sign in to Ada" });
  expect(sent?.ctx).toBe(f.ctx);
  const landing = await b.send(linkIn(sent?.message.text ?? ""));
  expect(landing.status).toBe(302);
  expect(await b.user()).toMatchObject({ email: "ana@example.com", emailVerified: true });
});

test("ban: sessions revoked, sign-in refused; lifted, sign-in works", async () => {
  const f = make({ withEmail: false, sessionCacheSeconds: 0 });
  const b = f.browser();
  await signUp(b, "ana@example.com");
  const id = (await b.user())?.id ?? "";
  await f.accounts.ban(id, true, f.ctx);
  expect(await b.user()).toBeUndefined();
  const refused = await signIn(f.browser(), "ana@example.com");
  expect(refused.status).toBe(403);
  expect(await codeOf(refused)).toBe("BANNED");
  expect((await f.accounts.list({ limit: 10 }, f.ctx)).items[0]?.banned).toBe(true);

  await f.accounts.ban(id, false, f.ctx);
  expect((await signIn(b, "ana@example.com")).status).toBe(200);
  expect((await b.user())?.id).toBe(id);
  expect(await refusedWith(f.accounts.ban("nobody", true, f.ctx))).toBe("not_found");
});

test("remove: the user, their sessions and accounts are gone", async () => {
  const f = make({ withEmail: false, sessionCacheSeconds: 0 });
  const b = f.browser();
  await signUp(b, "ana@example.com");
  const id = (await b.user())?.id ?? "";
  await f.accounts.remove(id, f.ctx);
  expect(await b.user()).toBeUndefined();
  for (const table of ["channel_web_user", "channel_web_session", "channel_web_account"]) {
    const [row] = await f.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    expect(row?.n).toBe(0);
  }
  expect((await signIn(f.browser(), "ana@example.com")).status).toBe(401);
  expect(await refusedWith(f.accounts.remove(id, f.ctx))).toBe("not_found");
});

test("list: newest first, paged by cursor, with methods, last seen and bans", async () => {
  const f = make({ withEmail: false, mode: "invite" });
  const ids: string[] = [];
  for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
    ids.push((await f.accounts.invite({ email }, ORIGIN, f.ctx)).userId);
    await Bun.sleep(3);
  }
  f.policy.mode = "open";
  const b = f.browser();
  await signUp(b, "d@example.com");
  const d = (await b.user())?.id ?? "";

  const first = await f.accounts.list({ limit: 2 }, f.ctx);
  const [a, bb, c] = ids as [string, string, string];
  expect(first.items.map((u) => u.id)).toEqual([d, c]);
  expect(first.items[0]).toMatchObject({ email: "d@example.com", methods: ["password"], banned: false });
  expect(first.items[0]?.lastSeenAt).toBeGreaterThan(0);
  expect(first.items[1]?.lastSeenAt).toBeUndefined();
  expect(first.items[1]?.methods).toEqual([]);
  const second = await f.accounts.list({ limit: 2, ...(first.next !== undefined && { cursor: first.next }) }, f.ctx);
  expect(second.items.map((u) => u.id)).toEqual([bb, a]);
  expect(second.next).toBeUndefined();
  expect(await refusedWith(f.accounts.list({ limit: 2, cursor: "garbage" }, f.ctx))).toBe("invalid_request");
});

test("last seen is the user's: kept through a ban and every session gone; a database read writes it at most once a while", async () => {
  const f = make({ withEmail: false, mode: "open", sessionCacheSeconds: 0 });
  const b = f.browser();
  await signUp(b, "ana@example.com");
  const id = (await b.user())?.id ?? "";
  const seen = async () => (await f.accounts.list({ limit: 10 }, f.ctx)).items.find((u) => u.id === id)?.lastSeenAt;
  const first = await seen();
  expect(first).toBeGreaterThan(0);

  await f.accounts.ban(id, true, f.ctx);
  expect(await seen()).toBe(first);
  await f.accounts.ban(id, false, f.ctx);
  // "Sign out everywhere": every session gone.
  await f.sql.run(`DELETE FROM channel_web_session WHERE "userId" = ?`, [id]);
  expect(await seen()).toBe(first);

  // A new session writes it at once.
  const old = "2020-01-01T00:00:00.000Z";
  await f.sql.run(`UPDATE channel_web_user SET "lastSeenAt" = ? WHERE "id" = ?`, [old, id]);
  expect((await signIn(b, "ana@example.com")).status).toBe(200);
  expect(await seen()).toBeGreaterThan(Date.parse(old));
  // Each request reads the database here (no cache): within a minute nothing is written again; past it, once.
  await f.sql.run(`UPDATE channel_web_user SET "lastSeenAt" = ? WHERE "id" = ?`, [old, id]);
  expect((await b.user())?.id).toBe(id);
  expect(await seen()).toBe(Date.parse(old));
  try {
    setSystemTime(new Date(Date.now() + 61_000));
    expect((await b.user())?.id).toBe(id);
    expect(await seen()).toBeGreaterThan(Date.now() - 1000);
  } finally {
    setSystemTime();
  }
});

test("a magic link's user (no account row) signed out everywhere is not invited again: seen, theirs", async () => {
  const f = make({ mode: "open" });
  const b = f.browser();
  await b.send("/chat/api/auth/sign-in/magic-link", { json: { email: "ana@example.com", callbackURL: "/chat/" } });
  await b.send(linkIn(f.emails[0]?.message.text ?? ""));
  const id = (await b.user())?.id ?? "";
  await f.sql.run(`DELETE FROM channel_web_session WHERE "userId" = ?`, [id]);
  const [listed] = (await f.accounts.list({ limit: 10 }, f.ctx)).items;
  expect(listed).toMatchObject({ id, methods: [] });
  expect(listed?.lastSeenAt).toBeGreaterThan(0);
  expect(await refusedWith(f.accounts.invite({ email: "ana@example.com" }, ORIGIN, f.ctx))).toBe("exists");
});

test("rate limits: a fourth sign-in from one address within 10 s is refused", async () => {
  const f = make({ withEmail: false });
  const b = f.browser("198.51.100.7");
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await signIn(b, "nobody@example.com")).status);
  expect(statuses).toEqual([401, 401, 401, 429]);
  expect((await signIn(f.browser("198.51.100.8"), "nobody@example.com")).status).toBe(401);
});

test("rate limits are by the address the server saw: a client's x-forwarded-for changes nothing, unless a proxy's header is trusted", async () => {
  const f = make({ withEmail: false });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const request = f.browser("198.51.100.20").build("/chat/api/auth/sign-in/email", { json: { email: "nobody@example.com", password: PASSWORD } });
    request.headers.set("x-forwarded-for", `203.0.113.${i + 1}`);
    request.headers.set("cf-connecting-ip", `203.0.113.${i + 1}`);
    statuses.push((await f.accounts.handle(request, f.ctx)).status);
  }
  expect(statuses).toEqual([401, 401, 401, 429]);

  // Behind a proxy that sets it (trustedProxyHeaders), its header is the client's.
  const proxied = make({ withEmail: false, ipHeaders: ["x-forwarded-for", "x-pikit-client-address"] });
  const behind: number[] = [];
  for (let i = 0; i < 4; i++) {
    const request = proxied.browser("198.51.100.21").build("/chat/api/auth/sign-in/email", { json: { email: "nobody@example.com", password: PASSWORD } });
    request.headers.set("x-forwarded-for", `203.0.113.${50 + i}`);
    behind.push((await proxied.accounts.handle(request, proxied.ctx)).status);
  }
  expect(behind).toEqual([401, 401, 401, 401]);
});

test("built-in providers: each configured, sign-in goes to it with the chat's callback", async () => {
  const f = make({
    withEmail: false,
    social: [
      { id: "google", clientId: "g-id", clientSecret: "g-secret" },
      { id: "github", clientId: "gh-id", clientSecret: "gh-secret" },
    ],
  });
  for (const [provider, host] of [
    ["google", "accounts.google.com"],
    ["github", "github.com"],
  ] as const) {
    const response = await f.browser().send("/chat/api/auth/sign-in/social", { json: { provider, callbackURL: "/chat/" } });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    expect(url.host).toBe(host);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/chat/api/auth/callback/${provider}`);
    expect(url.searchParams.get("client_id")).toBe(provider === "google" ? "g-id" : "gh-id");
  }
  const unknown = await f.browser().send("/chat/api/auth/sign-in/social", { json: { provider: "gitlab", callbackURL: "/chat/" } });
  expect(unknown.status).toBe(404);
});

test("publicUrl: links and cookies follow it, whatever the request's host", async () => {
  const f = make({ withEmail: true, publicUrl: "https://bot.example.com", mode: "open" });
  const b = f.browser(undefined, "https://bot.example.com");
  await b.send("/chat/api/auth/sign-in/magic-link", { json: { email: "ana@example.com", callbackURL: "/chat/" } });
  expect(linkIn(f.emails[0]?.message.text ?? "").startsWith("https://bot.example.com/chat/api/auth/magic-link/verify?")).toBe(true);
  expect([...b.jar.keys()].every((name) => name.startsWith("__Secure-"))).toBe(true);
});

test("handle: a body over 64 KiB is refused with 413", async () => {
  const f = make({ withEmail: false });
  const request = new Request(`${ORIGIN}/chat/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(70 * 1024), origin: ORIGIN },
    body: "x".repeat(70 * 1024),
  });
  expect((await f.accounts.handle(request, f.ctx)).status).toBe(413);
});

test("refuses to start: a short secret; a magic link without email.send", () => {
  const base = { sql: () => ({}) as never, name: "Ada", password: true, magicLink: false, social: [], oidc: [], signUp: async () => ({ mode: "open" as const, allow: [] }) };
  expect(() => createLocalAccounts({ ...base, secret: "short" })).toThrow("32 characters");
  expect(() => createLocalAccounts({ ...base, secret: "x".repeat(40), magicLink: true })).toThrow("email.send");
});

test("allowed: an entry, or an @domain entry's ending, case-insensitive", () => {
  expect(allowed(["ana@example.com"], "ANA@example.com")).toBe(true);
  expect(allowed(["@corp.test"], "bo@Corp.Test")).toBe(true);
  expect(allowed(["@corp.test"], "bo@notcorp.test")).toBe(false);
  expect(allowed(["@corp.test"], "bo@sub.corp.test")).toBe(false);
  expect(allowed(["ana@example.com"], "ana@example.com.evil")).toBe(false);
  expect(allowed([], "ana@example.com")).toBe(false);
});

/** A magic link asked for `email`, followed: better-auth's redirect. */
async function magicLinkLanding(f: Fixture, email: string): Promise<Response> {
  const b = f.browser();
  const before = f.emails.length;
  const asked = await b.send("/chat/api/auth/sign-in/magic-link", { json: { email, callbackURL: "/chat/", errorCallbackURL: "/chat/#/sign-in" } });
  if (asked.status !== 200) throw new Error(`magic link refused: ${asked.status} ${await asked.text()}`);
  const sent = f.emails[before];
  if (sent === undefined) throw new Error("no magic link sent");
  return b.send(linkIn(sent.message.text));
}

/** An OIDC sign-in with the fake provider, the person consenting as `profile`. */
async function oidcLanding(f: Fixture, oidc: Awaited<ReturnType<typeof fakeOidc>>, profile: Profile): Promise<{ browser: Browser; response: Response }> {
  const browser = f.browser();
  const started = await browser.send("/chat/api/auth/sign-in/social", { json: { provider: "corp", callbackURL: "/chat/", errorCallbackURL: "/chat/#/sign-in" } });
  if (started.status !== 200) throw new Error(`OIDC sign-in refused: ${started.status} ${await started.text()}`);
  const { url } = (await started.json()) as { url: string };
  const response = await browser.send(oidc.approve(url, profile));
  return { browser, response };
}
