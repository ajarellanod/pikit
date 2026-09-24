/**
 * secrets-env's tests. They are copied with the component and keep running in your project.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, type SecretStore, silentLogger } from "@pikit/core";
import { createSecretStoreConformance } from "@pikit/core/testing";
import secretsEnv, { createSecretsEnv } from "./index.ts";

// The secrets contract (SPEC §14), over an environment seeded by the suite.
for (const c of createSecretStoreConformance((secrets) => ({ components: [createSecretsEnv({ env: secrets })] }))) {
  test(`secrets-env ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secretsEnv], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "secrets-env", provides: ["secrets"], requires: [], optional: [] }]);
});

test("by default it reads the process environment as it is when a secret is read", async () => {
  const name = "PIKIT_SECRETS_ENV_TEST";
  let secrets: SecretStore | undefined;
  const reader = defineComponent({
    name: "secrets-reader",
    setup(pikit) {
      const handle = pikit.use("secrets");
      return { start: () => void (secrets = handle.get()) };
    },
  });
  const app = await defineApp({ components: [secretsEnv, reader], logger: silentLogger }).create();
  await app.start();
  let whileSet: string | undefined;
  try {
    process.env[name] = "from-the-environment";
    whileSet = await secrets?.get(name);
  } finally {
    delete process.env[name];
  }

  expect(whileSet).toBe("from-the-environment");
  expect(await secrets?.get(name)).toBeUndefined();
  await app.stop();
});
