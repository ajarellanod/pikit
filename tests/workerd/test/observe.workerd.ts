/**
 * What the dashboard reads, on Cloudflare (SPEC §5): `agent.observe` on runtime-pi over storage-do in a
 * real SQLite-backed object (the object sees its own conversations: the root first, then those a reset
 * makes), and `admin.auth` on admin-auth-token with Web Crypto in workerd.
 */

import { defineComponent } from "@pikit/core";
import type { SecretStore } from "@pikit/contracts";
import { createAdminAuthConformance, createAgentObserveConformance, withWorkersHost } from "@pikit/contracts/testing";
import { testComponents } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, it } from "vitest";
import adminAuthToken from "../../../registry/components/admin-auth-token/files/src/pikit/admin-auth-token/index.ts";
import { createRuntimePi } from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { inObject, objectHost, resetObjects } from "./host.ts";

afterEach(() => resetObjects());

for (const c of createAgentObserveConformance(() => {
  const { agents, provider } = testComponents();
  return { components: [...withWorkersHost(objectHost(), [storageDo]), agents, provider, createRuntimePi()], agent: "scripted" };
})) {
  it(`runtime-pi on storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

const TOKEN = "workerd-operator-token-0123456789abcdef";
const secrets = (values: Record<string, string>) =>
  defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => values[name] } satisfies SecretStore) });

for (const c of createAdminAuthConformance(() => ({
  components: [secrets({ PIKIT_ADMIN_TOKEN: TOKEN }), adminAuthToken],
  operator: { authorization: `Bearer ${TOKEN}` },
  credential: TOKEN,
  intruders: [{ authorization: `Bearer ${TOKEN}x` }, { authorization: "Bearer " }, { "x-admin-token": TOKEN }],
  unconfigured: { components: [secrets({}), adminAuthToken] },
}))) {
  it(`admin-auth-token ${c.group}: ${c.name}`, () => c.run());
}
