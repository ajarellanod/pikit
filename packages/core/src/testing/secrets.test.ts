/**
 * The `secrets` suite run against an in-memory double (S12): proof that the suite asks nothing
 * specific to one store. A real project reads secrets through a component such as `secrets-env`.
 */

import { test } from "bun:test";
import { defineComponent } from "../app.ts";
import { createSecretStoreConformance } from "./secrets.ts";

function memorySecrets(values: Readonly<Record<string, string>>) {
  return defineComponent({
    name: "secrets-memory",
    setup(pikit) {
      pikit.provide("secrets", { get: async (name) => values[name] || undefined });
    },
  });
}

for (const c of createSecretStoreConformance((secrets) => ({ components: [memorySecrets(secrets)] }))) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
