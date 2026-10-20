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
  manifest.components["deployment-fake"] = { registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" }, addedDependencies: [], files: {}, dependencies: {}, environment: [] };
  const groq = model.startsWith("groq/");
  const key = groq ? "GROQ_API_KEY" : KEY;
  if (providers) {
    manifest.components["provider-test"] = { registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" }, addedDependencies: [], files: {}, dependencies: {}, environment: [{ name: key, secret: true, required: false }] };
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

test("on a server (the entrypoint under bun --watch), dev builds each UI project at start: a fresh project serves its page with no edit", async () => {
  const dir = project("faux/echo", true);
  const own = join(dir, "src", "pikit", "deployment-fake");
  rmSync(join(own, "index.ts"));
  // The app: waits for the page's module the build writes, then exits (2 if it never comes).
  writeFileSync(
    join(own, "main.ts"),
    'for (let i = 0; i < 300; i++) {\n  if ((await Bun.file("src/pikit/channel-web/chat-files.ts").text()).includes("built")) process.exit(0);\n  await Bun.sleep(50);\n}\nprocess.exit(2);\n',
  );
  mkdirSync(join(dir, "src", "pikit", "channel-web"), { recursive: true });
  writeFileSync(join(dir, "src", "pikit", "channel-web", "chat-files.ts"), "export const CHAT_FILES = {};\n");
  mkdirSync(join(dir, "src", "chat"), { recursive: true });
  writeFileSync(join(dir, "src", "chat", "package.json"), JSON.stringify({ name: "chat", private: true, scripts: { build: "bun build.ts" } }));
  writeFileSync(join(dir, "src", "chat", "build.ts"), 'await Bun.write("../pikit/channel-web/chat-files.ts", "export const CHAT_FILES = {}; // built\\n");\n');

  const started = await pikit(["dev"], dir);
  expect(started.out).toContain("src/chat: bun run build");
  expect(started.code).toBe(0);
}, 60_000);

test("an agent on a model that needs no credentials (provider-faux) starts; an installed provider no agent uses is not checked", async () => {
  const dir = project("faux/echo", true);
  const started = await pikit(["dev"], dir);
  expect(started.err).not.toContain("no credentials");
  expect(started.code).toBe(0);
  expect(existsSync(join(dir, "dev-ran"))).toBe(true);
}, 60_000);

/** The pids of the fake deployment's children still alive when a test ends (a failed one). */
const children: number[] = [];
afterAll(() => children.forEach((pid) => (alive(pid) ? process.kill(pid, "SIGKILL") : undefined)));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a SIGTERM to pikit dev reaches the deployment's own dev: its command stops, it cleans up, pikit exits with its code", async () => {
  const dir = project("faux/echo", true);
  // As deployment-celld's: writes a secrets file, runs a command until `signal` aborts, deletes the file.
  writeFileSync(
    join(dir, "src", "pikit", "deployment-fake", "index.ts"),
    `import { rmSync, writeFileSync } from "node:fs";
export async function dev({ signal }: { signal: AbortSignal }): Promise<number> {
  writeFileSync(".dev.vars", "SECRET=1\\n");
  const child = Bun.spawn([process.execPath, "-e", 'await Bun.write("child.pid", String(process.pid)); process.on("SIGTERM", () => process.exit(7)); setInterval(() => {}, 1000);'], { stdio: ["ignore", "inherit", "inherit"] });
  signal.addEventListener("abort", () => child.kill("SIGTERM"));
  try {
    return await child.exited;
  } finally {
    rmSync(".dev.vars", { force: true });
  }
}
`,
  );
  const env = { ...process.env };
  delete env[KEY];
  const cli = Bun.spawn([process.execPath, MAIN, "dev"], { cwd: dir, env, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  const pidFile = join(dir, "child.pid");
  for (let i = 0; i < 300 && !existsSync(pidFile); i++) await Bun.sleep(50);
  const pid = Number(await Bun.file(pidFile).text());
  children.push(pid);
  expect(existsSync(join(dir, ".dev.vars"))).toBe(true);

  cli.kill("SIGTERM");
  expect(await cli.exited).toBe(7);
  expect(existsSync(join(dir, ".dev.vars"))).toBe(false);
  expect(alive(pid)).toBe(false);
}, 60_000);
