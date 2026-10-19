/**
 * The bucket client a rollback writes the previous pointer back with (`bucket.mjs`): its SigV4
 * signatures against AWS's own published examples, the addressing celld uses, and conditional writes
 * against a fake S3.
 */

import { afterAll, expect, test } from "bun:test";
import { bucketStore, parseBucket, signRequest } from "./bucket.mjs";
import { fakeFleet, KEY } from "./fake-fleet.test-support.ts";

const fleet = fakeFleet();
afterAll(() => fleet.stop());

const EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const DAY = new Date("2013-05-24T00:00:00Z");

// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Examples".
test("SigV4: AWS's GET Object example signs as AWS says", () => {
  const headers = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { range: "bytes=0-9" }, region: "us-east-1", credentials: EXAMPLE, date: DAY });
  expect(headers.authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  expect(headers["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect("host" in headers).toBe(false);
});

test("SigV4: AWS's PUT Object example (a body, an encoded key) signs as AWS says; a session token is signed too", () => {
  const put = { method: "PUT", url: "https://examplebucket.s3.amazonaws.com/test$file.text", body: "Welcome to Amazon S3.", region: "us-east-1", date: DAY };
  const headers = signRequest({ ...put, headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, credentials: EXAMPLE });
  expect(headers.authorization).toEndWith("SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  const session = signRequest({ ...put, credentials: { ...EXAMPLE, sessionToken: "token" } });
  expect(session["x-amz-security-token"]).toBe("token");
  expect(session.authorization).toContain("x-amz-security-token");
});

test("a bucket spec splits as celld's: scheme (s3 without one), name, a slash-terminated prefix", () => {
  expect(parseBucket("s3://fleet")).toEqual({ scheme: "s3", name: "fleet", prefix: "" });
  expect(parseBucket(" fleet/a//b/ ")).toEqual({ scheme: "s3", name: "fleet", prefix: "a/b/" });
  expect(parseBucket("GS://fleet/x")).toEqual({ scheme: "gs", name: "fleet", prefix: "x/" });
});

test("pikit writes only an S3-compatible bucket, with keys in the environment: otherwise it says why", () => {
  const keys = { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
  expect(bucketStore({})).toEqual({ unsupported: "CELLD_BUCKET is not set" });
  expect(bucketStore({ CELLD_BUCKET: "gs://fleet", ...keys }).unsupported).toContain("not gs://");
  expect(bucketStore({ CELLD_BUCKET: "az://fleet", ...keys }).unsupported).toContain("not az://");
  expect(bucketStore({ CELLD_BUCKET: "s3://fleet" }).unsupported).toContain("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set here");
  expect(bucketStore({ CELLD_BUCKET: "s3://", ...keys }).unsupported).toContain("names no bucket");
});

test("AWS's own endpoint is virtual-hosted in the bucket's region; another endpoint is path-style, under the bucket's prefix", async () => {
  const urls: string[] = [];
  const record = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const keys = { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
  const aws = bucketStore({ CELLD_BUCKET: "s3://fleet/prod", AWS_REGION: "eu-west-1", ...keys }, record);
  const r2 = bucketStore({ CELLD_BUCKET: "fleet", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", ...keys }, record);
  if (aws.unsupported !== undefined || r2.unsupported !== undefined) throw new Error("unsupported");
  expect(await aws.get("deploy/current.json")).toBeUndefined();
  expect(await r2.get("deploy/current.json")).toBeUndefined();
  expect(urls).toEqual(["https://fleet.s3.eu-west-1.amazonaws.com/prod/deploy/current.json", "https://acct.r2.cloudflarestorage.com/fleet/deploy/current.json"]);
});

test("a write goes only over the ETag it was given: a later write in between wins, and the rollback says so", async () => {
  const store = bucketStore(fleet.env());
  if (store.unsupported !== undefined) throw new Error(store.unsupported);
  expect(await store.get("deploy/current.json")).toBeUndefined();
  fleet.seed("my-bot", "old");
  const read = await store.get("deploy/current.json");
  expect(JSON.parse(read?.body ?? "{}").script_name).toBe("my-bot");
  expect(await store.replace("deploy/current.json", '{"v":1}', read?.etag)).toBe(true);
  expect(await store.replace("deploy/current.json", '{"v":2}', read?.etag)).toBe(false);
  expect(fleet.objects.get("deploy/current.json")?.body).toBe('{"v":1}');
  expect(fleet.requests.at(-1)).toEqual({ method: "PUT", key: "deploy/current.json", ifMatch: read?.etag ?? null });
  // A key the bucket refuses is an error that names S3's code, never a value.
  const denied = bucketStore({ ...fleet.env(), AWS_ACCESS_KEY_ID: "someone-else" });
  if (denied.unsupported !== undefined) throw new Error("unsupported");
  await expect(denied.get("deploy/current.json")).rejects.toThrow("GET deploy/current.json: HTTP 403: AccessDenied");
  expect(KEY.id).not.toBe("someone-else");
});
