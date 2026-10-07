/**
 * `pikit dev` checks the model credentials on this machine before it starts, as `up` does where the
 * app runs: an agent whose model has none here is refused with what to do, one that needs none
 * (provider-faux) starts. Doctor stays green either way: a login for `pikit up` is not kept here.
 *
 * The project's components are its own (an agent, the providers, a store), with this repository's
 * `@pikit/core` and `@pikit/pi-adapter` linked as `bun install` would; its deployment's `dev` only
 * says it ran. The provider's key is taken out of the environment, so the shell's never counts.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES_DIR } from "../paths.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const KEY = "OPENROUTER_API_KEY";
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The project's adapter, built in two pieces: this test's own imports are checked (scripts/boundaries.ts). */
const ADAPTER = ["@pikit", "pi-adapter"].join("/");

/** A store that holds nothing: a login has somewhere to go. */
const STORE = `\n    pikit.provide("model.credentials", { read: async () => undefined, list: async () => [], modify: async () => undefined });`;

/**
 * A project whose one agent is on `model`, with faux and the model's provider (openrouter, with an OAuth
 * login, or groq, keys only) installed by a component whose manifest declares the provider's key, and a
 * store when `store`; with `providers: false`, no provider and no adapter (a new project before its
 * runtime).
 */
function project(model: string, store: boolean, providers = true): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-dev-test-"));
  dirs.push(dir);
  const manifest = emptyManifest(undefined, undefined, ["server"]);
  manifest.components["deployment-fake"] = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: {}, dependencies: {}, environment: [] };
  const groq = model.startsWith("groq/");
  const key = groq ? "GROQ_API_KEY" : KEY;
  if (providers) {
    manifest.components["provider-test"] = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: {}, dependencies: {}, environment: [{ name: key, secret: true, required: false }] };
  }
  writeProjectManifest(dir, manifest);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dev" }, null, 2)}\n`);
  mkdirSync(join(dir, "src", "pikit", "deployment-fake"), { recursive: true });
  writeFileSync(join(dir, "src", "pikit", "deployment-fake", "index.ts"), 'export async function dev(): Promise<number> {\n  await Bun.write("dev-ran", "yes");\n  return 0;\n}\n');
  writeFileSync(
    join(dir, "src", "models.ts"),
    providers
      ? `import { defineComponent } from "@pikit/core";
import { fauxProvider } from "${ADAPTER}/providers/faux";
import { ${groq ? "groqProvider as keyed" : "openrouterProvider as keyed"} } from "${ADAPTER}/providers/${groq ? "groq" : "openrouter"}";

export default defineComponent({
  name: "models",
  setup(pikit) {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
    pikit.provideKeyed("model.provider", faux.provider.id, faux.provider);${store ? STORE : ""}
    pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: ${JSON.stringify(model)}, instructions: "" });
  },
});

/** The model's provider, from its own component, as a registry's provider-* would be. */
export const provider = defineComponent({
  name: "provider-test",
  setup(pikit) {
    const provider = keyed();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
`
      : `import { defineComponent } from "@pikit/core";

export default defineComponent({
  name: "models",
  setup(pikit) {
    pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: ${JSON.stringify(model)}, instructions: "" });
  },
});
`,
  );
  const listed = providers ? "    models,\n    provider,\n" : "    models,\n";
  const imported = providers ? "import models, { provider } from \"./src/models.ts\";" : "import models from \"./src/models.ts\";";
  writeFileSync(join(dir, "pikit.config.ts"), `import { defineApp } from "@pikit/core";\n${imported}\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n${listed}  ],\n  config,\n});\n`);
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  for (const kit of providers ? ["core", "contracts", "pi-adapter"] : ["core", "contracts"]) symlinkSync(join(PACKAGES_DIR, kit), join(dir, "node_modules", "@pikit", kit));
  return dir;
}

/** `pikit <args>` in `dir`, without the providers' keys in its environment. */
async function pikit(args: string[], dir: string) {
  const env = { ...process.env };
  delete env[KEY];
  delete env.GROQ_API_KEY;
  const child = Bun.spawn([process.execPath, MAIN, ...args], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

test("dev refuses an agent whose model has no credentials here, with the login and the key to set; doctor stays green", async () => {
  const dir = project("openrouter/z-ai/glm-5.3-flash", true);
  expect((await pikit(["doctor"], dir)).code).toBe(0);

  const refused = await pikit(["dev"], dir);
  expect(refused.err).toContain(`the model provider "openrouter" has no credentials on this machine, for \`pikit dev\`: run \`pikit configure --login openrouter --local\`, or set ${KEY} in .env`);
  expect(refused.err).toContain("the app would start without model credentials");
  expect(refused.code).toBe(1);
  expect(existsSync(join(dir, "dev-ran"))).toBe(false);

  // The key in .env is credentials here: dev starts.
  writeFileSync(join(dir, ".env"), `${KEY}=sk-or-test-not-a-key\n`);
  const started = await pikit(["dev"], dir);
  expect(started.err).not.toContain("no credentials");
  expect(started.code).toBe(0);
  expect(existsSync(join(dir, "dev-ran"))).toBe(true);
}, 60_000);

test("without a store for a login (on Cloudflare), dev asks for the API key only", async () => {
  const dir = project("openrouter/z-ai/glm-5.3-flash", false);
  const refused = await pikit(["dev"], dir);
  expect(refused.err).toContain(`the model provider "openrouter" has no credentials on this machine, for \`pikit dev\`: set ${KEY} in .env`);
  expect(refused.code).toBe(1);
}, 60_000);

test("a provider with no OAuth login (groq) is offered no login, only the key its component declares", async () => {
  const dir = project("groq/llama-3.1-8b-instant", true);
  const refused = await pikit(["dev"], dir);
  expect(refused.err).toContain('the model provider "groq" has no credentials on this machine, for `pikit dev`: set GROQ_API_KEY in .env');
  expect(refused.code).toBe(1);
}, 60_000);

test("with no model provider installed yet (no adapter either), there is nothing to check: dev starts", async () => {
  const dir = project("openrouter/z-ai/glm-5.3-flash", false, false);
  const started = await pikit(["dev"], dir);
  expect(started.err).not.toContain("credentials");
  expect(started.code).toBe(0);
  expect(existsSync(join(dir, "dev-ran"))).toBe(true);
}, 60_000);

test("an agent on a model that needs no credentials (provider-faux) starts; an installed provider no agent uses is not checked", async () => {
  const dir = project("faux/echo", true);
  const started = await pikit(["dev"], dir);
  expect(started.err).not.toContain("no credentials");
  expect(started.code).toBe(0);
  expect(existsSync(join(dir, "dev-ran"))).toBe(true);
}, 60_000);
