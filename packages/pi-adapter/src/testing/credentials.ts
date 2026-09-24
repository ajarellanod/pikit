/**
 * `model.credentials` conformance (SPEC §4.5, §14). The contract is pi-ai's `CredentialStore`, so
 * the suite lives with the adapter, and pi-ai's own `InMemoryCredentialStore` is its double.
 * Runner-independent, like the core's suites:
 *
 *   for (const c of createCredentialStoreConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * Besides the store's own rules (serialized `modify`, nothing secret in `list`), it checks what
 * pikit relies on: pi-ai writes a refreshed OAuth token and a login back through the store, so a
 * persistent store keeps them.
 */

import {
  type AuthInteraction,
  type Credential,
  type CredentialStore,
  createProvider,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ConformanceCase } from "@pikit/core/testing";
import { modelsFrom } from "../models.ts";

/** A store over fresh records, built for one case. */
export interface CredentialStoreFixture {
  store: CredentialStore;
  /** A new store over the same records, as after a restart. Absent for a store that keeps nothing. */
  reopen?(): CredentialStore | Promise<CredentialStore>;
  /** Release what the fixture holds (temporary files). */
  dispose?(): Promise<void>;
}

const GROUP = "model.credentials";
const PROVIDER = "conformance-oauth";

export function createCredentialStoreConformance(
  factory: () => CredentialStoreFixture | Promise<CredentialStoreFixture>,
): readonly ConformanceCase[] {
  const credentialCase = (name: string, run: (fixture: CredentialStoreFixture) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture);
      } finally {
        await fixture.dispose?.();
      }
    },
  });

  return [
    credentialCase("a provider with no credential reads undefined, and an empty store lists nothing", async ({ store }) => {
      expect(await store.read("anthropic"), undefined, "read");
      expect(await store.list(), [], "list");
    }),

    credentialCase("modify stores what it returns; read and list see it, and list reveals no secret", async ({ store }) => {
      const key = apiKey("pikit-conformance-key-3e9a");
      const oauth = oauthCredential("pikit-conformance-access-1", 0);

      expect(await store.modify("anthropic", async () => key), key, "modify's result");
      await store.modify(PROVIDER, async () => oauth);

      expect(await store.read("anthropic"), key, "read");
      expect(await store.read(PROVIDER), oauth, "read");
      const listed = [...(await store.list())].sort((a, b) => a.providerId.localeCompare(b.providerId));
      expect(
        listed,
        [
          { providerId: "anthropic", type: "api_key" },
          { providerId: PROVIDER, type: "oauth" },
        ],
        "list",
      );
      const shown = JSON.stringify(listed);
      check(!shown.includes("pikit-conformance-key-3e9a") && !shown.includes("pikit-conformance-access-1"), "list not to reveal a secret");
    }),

    credentialCase("modify sees the stored credential, and returning undefined leaves it", async ({ store }) => {
      const key = apiKey("pikit-conformance-before");
      await store.modify("anthropic", async () => key);
      let seen: Credential | undefined;

      const result = await store.modify("anthropic", async (current) => {
        seen = current;
        return undefined;
      });

      expect(seen, key, "what modify saw");
      expect(result, key, "modify's result");
      expect(await store.read("anthropic"), key, "read");
    }),

    credentialCase("modifies of one provider run one at a time, each seeing the one before", async ({ store }) => {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          store.modify("anthropic", async (current) => {
            const count = Number(current?.type === "api_key" ? current.key : "0");
            await new Promise((resolve) => setTimeout(resolve, 1));
            return apiKey(String(count + 1));
          }),
        ),
      );

      expect(await store.read("anthropic"), apiKey("10"), "the counter after 10 concurrent modifies");
    }),

    credentialCase("a modify that rejects changes nothing and rejects with its error", async ({ store }) => {
      const key = apiKey("pikit-conformance-kept");
      await store.modify("anthropic", async () => key);
      const failure = new Error("pikit-conformance: refresh failed");

      const rejected = await store.modify("anthropic", async () => Promise.reject(failure)).then(
        () => undefined,
        (error: unknown) => error,
      );

      check(rejected === failure, "modify to reject with the error of its function");
      expect(await store.read("anthropic"), key, "read after the failed modify");
    }),

    credentialCase("delete removes one provider's credential and no other", async ({ store }) => {
      await store.modify("anthropic", async () => apiKey("pikit-conformance-a"));
      await store.modify(PROVIDER, async () => oauthCredential("pikit-conformance-b", 0));

      await store.delete("anthropic");

      expect(await store.read("anthropic"), undefined, "read after delete");
      expect(await store.list(), [{ providerId: PROVIDER, type: "oauth" }], "list after delete");
    }),

    credentialCase("credentials survive a new store over the same records", async ({ store, reopen }) => {
      if (reopen === undefined) return;
      const key = apiKey("pikit-conformance-persisted");
      await store.modify("anthropic", async () => key);
      await store.modify(PROVIDER, async () => oauthCredential("pikit-conformance-gone", 0));
      await store.delete(PROVIDER);

      const reopened = await reopen();

      expect(await reopened.read("anthropic"), key, "read after reopening");
      expect(await reopened.read(PROVIDER), undefined, "a deleted credential after reopening");
    }),

    credentialCase("an OAuth token refreshed by pi-ai is written back through the store", async ({ store, reopen }) => {
      await store.modify(PROVIDER, async () => oauthCredential("pikit-conformance-expired", 0));
      const models = modelsFrom([oauthProvider()], { credentials: store });

      const resolved = await models.getAuth(PROVIDER);

      expect(resolved?.auth.apiKey, "pikit-conformance-refreshed", "the request auth");
      const stored = await store.read(PROVIDER);
      expect(stored?.type === "oauth" ? [stored.access, stored.refresh] : stored, ["pikit-conformance-refreshed", "refresh-2"], "stored");
      if (reopen !== undefined) {
        const again = await (await reopen()).read(PROVIDER);
        expect(again?.type === "oauth" ? again.access : again, "pikit-conformance-refreshed", "the refreshed token after reopening");
      }
    }),

    credentialCase("a login through pi-ai is written through the store", async ({ store }) => {
      const models = modelsFrom([oauthProvider()], { credentials: store });

      await models.login(PROVIDER, "oauth", silentInteraction());

      const stored = await store.read(PROVIDER);
      expect(stored?.type === "oauth" ? stored.access : stored, "pikit-conformance-logged-in", "stored after login");
    }),
  ];
}

function apiKey(key: string): Credential {
  return { type: "api_key", key };
}

function oauthCredential(access: string, expires: number): OAuthCredential {
  return { type: "oauth", access, refresh: "refresh-1", expires };
}

/** A provider with OAuth only, whose refresh and login are local: no network, no model calls. */
function oauthProvider(): Provider {
  const never = (): never => {
    throw new Error(`${GROUP}: the conformance provider does not stream`);
  };
  return createProvider({
    id: PROVIDER,
    auth: {
      oauth: {
        name: "Conformance OAuth",
        login: async () => ({ type: "oauth", access: "pikit-conformance-logged-in", refresh: "refresh-1", expires: Date.now() + 3_600_000 }),
        refresh: async (credential) => ({
          ...credential,
          access: "pikit-conformance-refreshed",
          refresh: "refresh-2",
          expires: Date.now() + 3_600_000,
        }),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: [],
    api: { stream: never, streamSimple: never },
  });
}

function silentInteraction(): AuthInteraction {
  return {
    prompt: async () => {
      throw new Error(`${GROUP}: the conformance login asks nothing`);
    },
    notify: () => {},
  };
}

/** JSON with sorted keys: equality that ignores the order a store writes fields in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function expect(actual: unknown, expected: unknown, what: string): void {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${GROUP}: expected ${what}`);
}
