/**
 * The `model.credentials` suite run against pi-ai's own `InMemoryCredentialStore` (S12): the double
 * proves the suite asks only what pi-ai's contract says. It keeps nothing across a restart, so the
 * persistence case is skipped for it; a real store (`credentials-file`) runs it.
 */

import { test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createCredentialStoreConformance } from "./credentials.ts";

for (const c of createCredentialStoreConformance(() => ({ store: new InMemoryCredentialStore() }))) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
