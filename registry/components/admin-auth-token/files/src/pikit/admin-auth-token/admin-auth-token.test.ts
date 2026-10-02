/**
 * admin-auth-token's tests. They are copied with the component and keep running in your project.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { SecretStore } from "@pikit/contracts";
import { createAdminAuthConformance } from "@pikit/contracts/testing";
import adminAuthToken, { MIN_TOKEN_LENGTH } from "./index.ts";

const TOKEN = "a".repeat(20) + "-operator-token-0123456789";

/** `secrets` holding `values`. */
function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

// What every admin route can rely on (`admin.auth`).
for (const c of createAdminAuthConformance(() => ({
  components: [secrets({ PIKIT_ADMIN_TOKEN: TOKEN }), adminAuthToken],
  operator: { authorization: `Bearer ${TOKEN}` },
  credential: TOKEN,
  intruders: [
    { authorization: `Bearer ${TOKEN}x` },
    { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
    { authorization: `Basic ${btoa(`operator:${TOKEN}`)}` },
    { authorization: TOKEN },
    { authorization: "Bearer " },
    { "x-admin-token": TOKEN },
  ],
  unconfigured: { components: [secrets({}), adminAuthToken] },
}))) {
  test(`admin-auth-token ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secrets({}), adminAuthToken], logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "admin-auth-token")).toEqual({ name: "admin-auth-token", provides: ["admin.auth"], requires: ["secrets"], optional: [] });
});

test("a token shorter than 32 characters stops the start, naming the secret, never the token", async () => {
  const short = "s".repeat(MIN_TOKEN_LENGTH - 1);
  const app = await defineApp({ components: [secrets({ PIKIT_ADMIN_TOKEN: short }), adminAuthToken], logger: silentLogger }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );

  expect(String(error?.cause)).toContain("PIKIT_ADMIN_TOKEN is shorter than 32 characters");
  expect(String(error?.cause)).not.toContain(short);
});

test("tokenSecret names another secret", async () => {
  const app = await defineApp({
    components: [secrets({ OPS_TOKEN: TOKEN }), adminAuthToken],
    config: { "admin-auth-token": { tokenSecret: "OPS_TOKEN" } },
    logger: silentLogger,
  }).create();

  await app.start();
  await app.stop();
});
