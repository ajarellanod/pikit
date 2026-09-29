/**
 * secrets-cloudflare over a real Worker's `env`: the `secrets` suite (its values added to the env, as
 * `wrangler secret put` would), then what the real env holds: a `vars` value reads back, a Durable
 * Object binding does not.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type SecretStore, WORKERS_HOST } from "@pikit/contracts";
import { createSecretStoreConformance, withWorkersHost } from "@pikit/contracts/testing";
import { expect, it } from "vitest";
import secretsCloudflare from "../../../registry/components/secrets-cloudflare/files/src/pikit/secrets-cloudflare/index.ts";
import { workerEnv } from "./host.ts";

for (const c of createSecretStoreConformance((secrets) => ({ components: withWorkersHost({ env: { ...workerEnv, ...secrets } }, [secretsCloudflare]) }))) {
  it(`secrets-cloudflare ${c.group}: ${c.name}`, () => c.run());
}

it("secrets-cloudflare reads the Worker's env from app.start's context: variables, never bindings", async () => {
  let secrets: SecretStore | undefined;
  const reader = defineComponent({
    name: "secrets-reader",
    setup(pikit) {
      const handle = pikit.use("secrets");
      return { start: () => void (secrets = handle.get()) };
    },
  });
  const app = await defineApp({ components: [secretsCloudflare, reader], logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  expect(await secrets?.get("PIKIT_WORKERD_VAR")).toBe("from wrangler vars");
  expect(workerEnv.OBJECTS).toBeDefined();
  expect(await secrets?.get("OBJECTS")).toBeUndefined();
  await app.stop();
});
