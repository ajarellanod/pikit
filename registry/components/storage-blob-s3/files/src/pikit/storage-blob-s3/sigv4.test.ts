/**
 * The signer against the S3 examples AWS publishes for Signature Version 4 with an `Authorization`
 * header (the bucket `examplebucket`, us-east-1, May 24, 2013):
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */

import { expect, test } from "bun:test";
import { sha256Hex, signS3 } from "./sigv4.ts";

const CONTEXT = {
  region: "us-east-1",
  date: new Date("2013-05-24T00:00:00Z"),
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
};
const SCOPE = "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const bytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));

test("the hash of nothing", async () => {
  expect(await sha256Hex(new Uint8Array(0))).toBe(EMPTY);
});

test("GET Object", async () => {
  const headers = await signS3({ ...CONTEXT, method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" }, payloadHash: EMPTY });

  expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  expect(headers["x-amz-content-sha256"]).toBe(EMPTY);
  expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
});

test("PUT Object: a body's hash, an encoded path signed as sent", async () => {
  const payloadHash = await sha256Hex(bytes("Welcome to Amazon S3."));
  expect(payloadHash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const headers = await signS3({
    ...CONTEXT,
    method: "PUT",
    url: "https://examplebucket.s3.amazonaws.com/test%24file.text",
    headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash,
  });

  expect(headers.authorization).toBe(
    `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd`,
  );
});

test("GET Bucket Lifecycle: a parameter with no value", async () => {
  const headers = await signS3({ ...CONTEXT, method: "GET", url: "https://examplebucket.s3.amazonaws.com/?lifecycle", headers: {}, payloadHash: EMPTY });

  expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543`);
});

test("Get Bucket (List Objects): parameters sorted", async () => {
  const headers = await signS3({ ...CONTEXT, method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", headers: {}, payloadHash: EMPTY });

  expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7`);
});

test("a session token is sent and signed", async () => {
  const headers = await signS3({ ...CONTEXT, credentials: { ...CONTEXT.credentials, sessionToken: "token" }, method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: {}, payloadHash: EMPTY });

  expect(headers["x-amz-security-token"]).toBe("token");
  expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,");
});
