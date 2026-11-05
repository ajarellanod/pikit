/**
 * `pikit configure --login` with an account of provider-failover (`accounts`): another account of an
 * installed provider is a model provider of its own, so the CLI logs in to it by its id, with no
 * change of its own, and the login is stored under that id beside the base account's credential.
 *
 * The project is a server one: provider-failover copied from the registry (as `pikit add` does), a
 * provider whose OAuth login answers at once (no network), a store that keeps the credentials in a
 * file of the project, an agent on the account.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_REGISTRY, PACKAGES_DIR } from "../paths.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const ACCESS = "sub-secret-access-token";
/** The project's adapter, built in two pieces: this test's own imports are checked (scripts/boundaries.ts). */
const ADAPTER = ["@pikit", "pi-adapter"].join("/");

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A server project with provider-failover's account `subscription-2` of the provider `subscription`, whose own credential is an API key. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-configure-accounts-"));
  dirs.push(dir);
  const manifest = emptyManifest(undefined, undefined, ["server"]);
  const record = { registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" }, addedDependencies: [], files: {}, dependencies: {}, environment: [] };
  manifest.components["provider-test"] = { ...record, environment: [{ name: "SUB_API_KEY", secret: true, required: false }] };
  manifest.components["provider-failover"] = record;
  manifest.components["credentials-test"] = record;
  writeProjectManifest(dir, manifest);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "accounts" }, null, 2)}\n`);
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ subscription: { type: "api_key", key: "the-base-account-key" } }));
  cpSync(join(DEFAULT_REGISTRY, "components", "provider-failover", "files", "src", "pikit", "provider-failover"), join(dir, "src", "pikit", "provider-failover"), { recursive: true });
  writeFileSync(
    join(dir, "src", "models.ts"),
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineComponent } from "@pikit/core";
import { createProvider } from "${ADAPTER}/provider";

const never = (): never => {
  throw new Error("the test provider does not stream");
};

/** A subscription provider whose login answers at once. */
export const provider = defineComponent({
  name: "provider-test",
  setup(pikit) {
    pikit.provideKeyed("model.provider", "subscription", createProvider({
      id: "subscription",
      auth: {
        oauth: {
          name: "Test subscription",
          login: async () => ({ type: "oauth", access: ${JSON.stringify(ACCESS)}, refresh: "refresh", expires: Date.now() + 3_600_000 }),
          refresh: async () => never(),
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [{ id: "m1", name: "m1", api: "fake", provider: "subscription", baseUrl: "https://fake.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
      api: { stream: never, streamSimple: never },
    }));
  },
});

/** The credentials, in the project's credentials.json. */
const FILE = join(import.meta.dir, "..", "credentials.json");
const all = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
export const store = defineComponent({
  name: "credentials-test",
  setup(pikit) {
    pikit.provide("model.credentials", {
      read: async (id) => all()[id],
      list: async () => Object.entries(all()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
      async modify(id, fn) {
        const stored = all();
        const next = await fn(stored[id]);
        if (next !== undefined) writeFileSync(FILE, JSON.stringify({ ...stored, [id]: next }));
        return next ?? stored[id];
      },
      async delete(id) {
        const { [id]: _gone, ...rest } = all();
        writeFileSync(FILE, JSON.stringify(rest));
      },
    });
  },
});

export default defineComponent({
  name: "models",
  setup(pikit) {
    pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "subscription-2/m1", instructions: "" });
  },
});
`,
  );
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\nimport models, { provider, store } from "./src/models.ts";\nimport providerFailover from "./src/pikit/provider-failover/index.ts";\n\nexport const config = {\n  "provider-failover": { accounts: { "subscription-2": { provider: "subscription" } } },\n};\n\nexport default defineApp({\n  components: [\n    models,\n    provider,\n    store,\n    providerFailover,\n  ],\n  config,\n});\n',
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  for (const kit of ["core", "contracts", "pi-adapter"]) symlinkSync(join(PACKAGES_DIR, kit), join(dir, "node_modules", "@pikit", kit));
  // provider-failover's own dependency, as `pikit add` installs it.
  symlinkSync(dirname(Bun.resolveSync("typebox/package.json", PACKAGES_DIR)), join(dir, "node_modules", "typebox"));
  return dir;
}

async function pikit(args: string[], dir: string) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], { cwd: dir, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

test("configure --login <account> logs in to provider-failover's account by its id and stores the login under it, beside the base account's credential", async () => {
  const dir = project();
  const stored = () => JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as Record<string, unknown>;

  // Before: the agent's provider is the account, which has nothing stored.
  const before = await pikit(["configure", "--yes"], dir);
  expect(before.code).toBe(1);
  expect(before.err).toContain('the model provider "subscription-2" has no credentials: run `pikit configure --login subscription-2` in a terminal');

  const login = await pikit(["configure", "--yes", "--login", "subscription-2"], dir);
  expect(login.err).toBe("");
  expect(login.code).toBe(0);
  expect(login.out).toContain("logged in to subscription-2 on this machine");
  expect(stored()).toEqual({ subscription: { type: "api_key", key: "the-base-account-key" }, "subscription-2": { type: "oauth", access: ACCESS, refresh: "refresh", expires: expect.any(Number) } });
  expect(login.out + login.err).not.toContain(ACCESS);

  const after = await pikit(["configure", "--yes"], dir);
  expect(after.code).toBe(0);
  expect(after.out).toContain("model provider subscription-2: has credentials");
}, 60_000);
