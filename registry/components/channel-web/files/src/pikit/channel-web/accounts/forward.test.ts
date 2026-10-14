// Forwarding better-auth's requests and responses as JSON (the Worker to the accounts actor), with a
// real sign-up through local accounts in the middle.

import { afterEach, expect, test } from "bun:test";
import { type Fixture, fixture, ORIGIN } from "./accounts.test-support.ts";
import {
  checkForwardedRequest,
  checkForwardedResponse,
  forwardRequest,
  forwardResponse,
  MAX_AUTH_BODY,
  requestOf,
  responseOf,
  TooLarge,
} from "./forward.ts";

const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

/** What crosses an actor: a JSON copy. */
const overTheWire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

test("a sign-up forwarded both ways: the request arrives whole, both set-cookie headers come back", async () => {
  const f = fixture({ withEmail: false });
  open.push(f);
  const request = new Request(`${ORIGIN}/chat/api/auth/sign-up/email?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "192.0.2.10", cookie: "a=1" },
    body: JSON.stringify({ email: "ana@example.com", password: "correct horse battery", name: "Ana" }),
  });

  const arrived = checkForwardedRequest(overTheWire(await forwardRequest(request)));
  expect(arrived).toBeDefined();
  expect(arrived?.url).toBe(`${ORIGIN}/chat/api/auth/sign-up/email?x=1`);
  const answered = await f.accounts.handle(requestOf(arrived as never), f.ctx);
  expect(answered.headers.getSetCookie()).toHaveLength(2);

  const back = checkForwardedResponse(overTheWire(await forwardResponse(answered)));
  expect(back?.headers.filter(([name]) => name === "set-cookie")).toHaveLength(2);
  const response = responseOf(back as never);
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie().map((c) => c.split("=")[0]).sort()).toEqual(["pikit_chat.session_data", "pikit_chat.session_token"]);
  expect(((await response.json()) as { user: { email: string } }).user.email).toBe("ana@example.com");
});

test("what better-auth reads of a request crosses whole: Origin, Referer, Cookie, User-Agent, the client's address headers, a form's body", async () => {
  const headers = {
    origin: "https://chat.example.com",
    referer: "https://chat.example.com/chat/#/account",
    cookie: "__Secure-pikit_chat.session_token=t.s; __Secure-pikit_chat.session_data=d",
    "user-agent": "Mozilla/5.0 (test)",
    "cf-connecting-ip": "198.51.100.7",
    "x-forwarded-for": "198.51.100.7, 10.0.0.1",
    "content-type": "application/x-www-form-urlencoded",
  };
  const request = new Request("https://chat.example.com/chat/api/auth/callback/corp", { method: "POST", headers, body: "code=c&state=s" });
  const arrived = requestOf(checkForwardedRequest(overTheWire(await forwardRequest(request))) as never);
  for (const [name, value] of Object.entries(headers)) expect({ name, value: arrived.headers.get(name) }).toEqual({ name, value });
  expect(arrived.method).toBe("POST");
  expect(arrived.url).toBe("https://chat.example.com/chat/api/auth/callback/corp");
  expect(await arrived.text()).toBe("code=c&state=s");
});

test("a redirect keeps its location and cookies, with no body", async () => {
  const headers = new Headers({ location: "/chat/" });
  headers.append("set-cookie", "a=1; Path=/chat/");
  headers.append("set-cookie", "b=2; Path=/chat/");
  const forwarded = checkForwardedResponse(overTheWire(await forwardResponse(new Response(null, { status: 302, headers }))));
  const response = responseOf(forwarded as never);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/chat/");
  expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/chat/", "b=2; Path=/chat/"]);
});

test("a request body over 64 KiB is refused, declared or streamed", async () => {
  const big = "x".repeat(MAX_AUTH_BODY + 1);
  const declared = new Request(`${ORIGIN}/chat/api/auth/sign-in/email`, { method: "POST", headers: { "content-length": String(big.length) }, body: big });
  await expect(forwardRequest(declared)).rejects.toBeInstanceOf(TooLarge);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  const streamed = new Request(`${ORIGIN}/chat/api/auth/sign-in/email`, { method: "POST", body: stream });
  await expect(forwardRequest(streamed)).rejects.toBeInstanceOf(TooLarge);
  const fits = new Request(`${ORIGIN}/chat/api/auth/sign-in/email`, { method: "POST", body: "x".repeat(MAX_AUTH_BODY) });
  expect((await forwardRequest(fits)).body).toHaveLength(MAX_AUTH_BODY);
});

test("checked on arrival: method, an auth URL, header pairs, bounded bodies", () => {
  const good = { method: "POST", url: `${ORIGIN}/chat/api/auth/sign-in/email`, headers: [["content-type", "application/json"]], body: "{}" };
  expect(checkForwardedRequest(good)).toEqual(good as never);
  expect(checkForwardedRequest({ ...good, method: "DELETE" })).toBeUndefined();
  expect(checkForwardedRequest({ ...good, url: `${ORIGIN}/chat/api/conversations` })).toBeUndefined();
  expect(checkForwardedRequest({ ...good, url: `${ORIGIN}/admin/api/auth/x` })).toBeUndefined();
  expect(checkForwardedRequest({ ...good, url: "file:///chat/api/auth/x" })).toBeUndefined();
  expect(checkForwardedRequest({ ...good, headers: [["a", 1]] })).toBeUndefined();
  expect(checkForwardedRequest({ ...good, body: "x".repeat(MAX_AUTH_BODY + 1) })).toBeUndefined();
  expect(checkForwardedRequest(null)).toBeUndefined();

  const answer = { status: 200, headers: [["set-cookie", "a=1"]], body: "" };
  expect(checkForwardedResponse(answer)).toEqual(answer as never);
  expect(checkForwardedResponse({ ...answer, status: 99 })).toBeUndefined();
  expect(checkForwardedResponse({ ...answer, body: undefined })).toBeUndefined();
  expect(checkForwardedResponse({ ...answer, headers: {} })).toBeUndefined();
});
