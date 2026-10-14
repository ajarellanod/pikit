/**
 * The signer against AWS's published Signature Version 4 test vectors: the aws-sig-v4-test-suite, as
 * kept in awslabs/aws-c-auth (`tests/aws-signing-test-suite/v4/<case>/`: `context.json` for the
 * credentials, region, service and time, `request.txt` for the request, `header-signature.txt` for
 * the expected signature). https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4
 */

import { expect, test } from "bun:test";
import { signAws4 } from "./sigv4.ts";

/** Every case's `context.json`: these credentials, region `us-east-1`, service `service`, 2015-08-30T12:36:00Z. */
const CONTEXT = {
  region: "us-east-1",
  service: "service",
  date: new Date("2015-08-30T12:36:00Z"),
  credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
};
const SCOPE = "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request";

test("get-vanilla", async () => {
  const headers = await signAws4({ ...CONTEXT, method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" });

  expect(headers["x-amz-date"]).toBe("20150830T123600Z");
  expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`);
});

test("post-vanilla", async () => {
  const headers = await signAws4({ ...CONTEXT, method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "" });

  expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b`);
});

test("post-x-www-form-urlencoded: a body, its hash and headers signed", async () => {
  const headers = await signAws4({
    ...CONTEXT,
    method: "POST",
    url: "https://example.amazonaws.com/",
    // As the case signs them (sign_body: true adds x-amz-content-sha256, the body's SHA-256).
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "13", "x-amz-content-sha256": "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e" },
    body: "Param1=value1",
  });

  expect(headers.authorization).toBe(
    `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b`,
  );
});

test("get-vanilla-with-session-token: the token is sent and signed", async () => {
  const token = "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267";
  const headers = await signAws4({ ...CONTEXT, credentials: { ...CONTEXT.credentials, sessionToken: token }, method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" });

  expect(headers["x-amz-security-token"]).toBe(token);
  expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8`);
});

test("another body, path or time is another signature", async () => {
  const base = { ...CONTEXT, method: "POST", url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails", headers: { "content-type": "application/json" }, body: "{}" };
  const signature = async (overrides: Partial<typeof base>) => (await signAws4({ ...base, ...overrides })).authorization;
  const first = await signature({});

  expect(await signature({ body: "{ }" })).not.toBe(first);
  expect(await signature({ url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-email" })).not.toBe(first);
  expect(await signature({ date: new Date("2015-08-30T12:36:01Z") })).not.toBe(first);
  expect(await signature({})).toBe(first);
});
