/**
 * The `pikit` binary, run as a user runs it: exit codes and refusals that must happen before any
 * file is written. No `bun install`, no network. The full path (new → configure → dev, add/remove)
 * is `e2e.test.ts`.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNFINISHED } from "./commands/new.ts";
import { emptyManifest, hashOf, writeProjectManifest } from "./project/pikit-json.ts";
import { DEFAULT_REGISTRY, PIKIT_ROOT } from "./paths.ts";
import { openRegistry } from "./project/registry-source.ts";
import { kitCommit, kitSpecifier } from "./project/vendor.ts";
import { runCli } from "./testing/cli.ts";

const MAIN = join(import.meta.dir, "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-cli-test-"));
  dirs.push(dir);
  return dir;
};

/** The smallest project `add` accepts: a manifest, a composition root, a package.json. */
function tinyProject(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "tiny", "dependencies": {} }\n');
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  return dir;
}

test("--version, help, unknown commands and commands not built yet", async () => {
  const cwd = temp();
  expect((await runCli(["--version"], cwd)).out).toMatch(/^pikit \d+\.\d+\.\d+/);
  expect((await runCli(["--help"], cwd)).code).toBe(0);
  expect((await runCli(["frobnicate"], cwd)).code).toBe(2);
  expect((await runCli(["add", "--bogus"], cwd)).code).toBe(2);
  const later = await runCli(["diff"], cwd);
  expect(later.code).toBe(1);
  // A path the user can open: the kit's own SPEC.md.
  expect(later.out).toContain(`pikit diff: not built yet (see ${join(PIKIT_ROOT, "SPEC.md")}, P6)`);
  expect((await runCli(["upgrade"], cwd)).err).toContain("is not a pikit project");
});

test("pikit registry validate runs the repository's registry checks", async () => {
  const run = await runCli(["registry", "validate"], temp());
  expect(run.out).toContain("registry validate: ok");
  expect(run.code).toBe(0);
});

test("pikit registry capabilities prints what each capability is and who provides and uses it", async () => {
  const run = await runCli(["registry", "capabilities"], temp());
  expect(run.code).toBe(0);
  expect(run.out).toContain("execution  (single, @pikit/pi-adapter, experimental)");
  expect(run.out).toContain("provided by: execution-do, execution-local");
  expect((await runCli(["registry", "bogus"], temp())).code).toBe(2);
});

test("project commands outside a project, and up with no deployment component, say what to do", async () => {
  const outside = await runCli(["doctor"], temp());
  expect(outside.code).toBe(1);
  expect(outside.err).toContain("is not a pikit project");

  const up = await runCli(["up"], tinyProject());
  expect(up.code).toBe(1);
  expect(up.err).toContain("no deployment-* component is installed");
});

test("new with no directory asks only on a terminal; the presets it offers have titles", async () => {
  const parent = temp();
  const run = await runCli(["new"], parent);
  expect(run.code).toBe(2);
  expect(run.err).toContain("without <dir>, run it in a terminal: it asks");
  expect(readdirSync(parent)).toEqual([]);

  const presets = openRegistry(DEFAULT_REGISTRY).presets();
  expect(presets.map((p) => p.name)).toEqual(["cloudflare-minimal", "http", "telegram", "telegram-cloudflare"]);
  for (const preset of presets) expect(preset.title).not.toBe(preset.name);
});

test("new refuses a non-empty directory and an unknown preset before writing anything", async () => {
  const parent = temp();
  mkdirSync(join(parent, "busy"));
  writeFileSync(join(parent, "busy", "file"), "");
  expect((await runCli(["new", "busy"], parent)).err).toContain("is not empty");

  const unknown = await runCli(["new", "fresh", "--preset", "nope"], parent);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no preset "nope"');
  expect(existsSync(join(parent, "fresh"))).toBe(false);

  const notAsked = await runCli(["new", "fresh", "--preset", "http", "--with", "tool-bash"], parent);
  expect(notAsked.code).toBe(1);
  expect(notAsked.err).toContain("has no choice of tool-* components; add tool-bash after");
  const noPreset = await runCli(["new", "fresh", "--with", "channel-telegram"], parent);
  expect(noPreset.code).toBe(1);
  expect(noPreset.err).toContain("--with answers a preset's questions: it needs --preset");
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("new refuses a preset component that does not run on a new project's target, before writing anything", async () => {
  const registry = temp();
  const manifest = (name: string, targets: string[]) => ({
    name, version: "0.0.0", description: name, targets, requires: { pikit: "0.0.0", capabilities: [] },
    optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }],
  });
  const index: Record<string, unknown> = {};
  for (const [name, targets] of [["secrets-env", ["server"]], ["channel-edge", ["durable"]]] as const) {
    mkdirSync(join(registry, "components", name), { recursive: true });
    writeFileSync(join(registry, "components", name, "component.json"), JSON.stringify(manifest(name, [...targets])));
    index[name] = { version: "0.0.0", description: name, targets, path: `components/${name}` };
  }
  writeFileSync(join(registry, "registry.json"), JSON.stringify({ version: 1, components: index }));
  mkdirSync(join(registry, "presets"));
  writeFileSync(join(registry, "presets", "edge.yaml"), "components: [secrets-env, channel-edge]\n");

  const parent = temp();
  const run = await runCli(["new", "fresh", "--preset", "edge", "--registry", registry], parent);
  expect(run.code).toBe(1);
  expect(run.err).toContain("channel-edge runs on durable, not on this project's server target");
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("new --target: an unknown target, and a preset that does not run on the chosen one, are refused before writing anything", async () => {
  const parent = temp();
  const mars = await runCli(["new", "fresh", "--target", "mars"], parent);
  expect(mars.code).toBe(2);
  expect(mars.err).toContain('--target is one of server, durable, not "mars"');
  // A provider is not a target.
  const provider = await runCli(["new", "fresh", "--target", "cloudflare", "--preset", "cloudflare-minimal"], parent);
  expect(provider.code).toBe(2);
  expect(provider.err).toContain('--target is one of server, durable, not "cloudflare"');

  const server = await runCli(["new", "fresh", "--target", "durable", "--preset", "http"], parent);
  expect(server.code).toBe(1);
  expect(server.err).toContain("runs on server, not on this project's durable target");
  const edge = await runCli(["new", "fresh", "--preset", "cloudflare-minimal"], parent);
  expect(edge.code).toBe(1);
  expect(edge.err).toContain("storage-do runs on durable, not on this project's server target");
  // The target is never guessed from the preset, but the refusal says which one it runs on.
  expect(edge.err).toContain('the preset "cloudflare-minimal" runs on durable: pikit new fresh --target durable --preset cloudflare-minimal');
  const bot = await runCli(["new", "fresh", "--preset", "telegram-cloudflare"], parent);
  expect(bot.code).toBe(1);
  expect(bot.err).toContain("pikit new fresh --target durable --preset telegram-cloudflare");
  // A target that was chosen gets no hint: it was not forgotten.
  expect(server.err).not.toContain("runs on server: pikit new");
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("new --target durable records the target, and writes two Apps, wrangler and the Cloudflare components", async () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after every file is written.
  const run = await runCli(["new", "edge", "--target", "durable", "--preset", "cloudflare-minimal"], parent, { env: { NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" } });
  expect(run.err).toContain("`bun install` failed");
  const project = join(parent, "edge");
  const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
  expect(manifest.targets).toEqual(["durable"]);
  expect(Object.keys(manifest.components).sort()).toEqual(["deployment-cloudflare", "storage-do", "storage-kv-sql"]);
  // The preset names storage-kv-sql (not an offer that a second storage.kv provider would cancel).
  expect(manifest.components["storage-kv-sql"].installedFor).toBeUndefined();
  expect(Object.keys(manifest.components["deployment-cloudflare"].files)).toContain("wrangler.jsonc");

  const config = readFileSync(join(project, "pikit.config.ts"), "utf8");
  expect(config).toContain("export default defineApp({\n  components: [\n    agents,\n    storageDo,\n    storageKvSql,\n  ],");
  expect(config).toContain("export const worker = defineApp({\n  components: [\n  ],\n  config: workerConfig,\n});");
  expect(config).not.toContain("deploymentCloudflare");
  // wrangler is deployment-cloudflare's dev dependency, installed by `add` like any other: not the starter's.
  expect(manifest.components["deployment-cloudflare"].devDependencies).toEqual({ wrangler: "4.143.0" });
  expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).devDependencies).toEqual({
    "@types/bun": expect.any(String),
    typescript: expect.any(String),
    wrangler: "4.143.0",
  });
  // The version this repository checks deployment-cloudflare with (its bundle test, the workerd lane).
  expect(JSON.parse(readFileSync(join(PIKIT_ROOT, "package.json"), "utf8")).devDependencies.wrangler).toBe("4.143.0");
  expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".wrangler/\n");
  expect(existsSync(join(project, "wrangler.jsonc"))).toBe(true);
  // The starter's model is one whose provider runs on Cloudflare: provider-anthropic is server-only.
  expect(readFileSync(join(project, "src", "agents", "assistant", "agent.ts"), "utf8")).toContain('model: "openrouter/z-ai/glm-5.3-flash",');
}, 60_000);

test("new --target durable --preset telegram-cloudflare: a whole bot, each half in its App, its agent naming the installed tools", async () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after every file is written.
  const run = await runCli(["new", "bot", "--target", "durable", "--preset", "telegram-cloudflare"], parent, { env: { NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" } });
  expect(run.err).toContain("`bun install` failed");
  // Every add was accepted: nothing refused, nothing missing in either App along the way.
  expect(run.err).not.toContain("is not provided");
  expect(run.out).toContain("outbound-durable, for channel-telegram-webhook");
  const project = join(parent, "bot");
  const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
  expect(manifest.targets).toEqual(["durable"]);
  expect(Object.keys(manifest.components).sort()).toEqual([
    "secrets-cloudflare",
    "platform-cloudflare",
    "storage-do",
    "storage-kv-sql",
    "conversations-kv",
    "provider-openrouter",
    "runtime-pi",
    "router-basic",
    "outbound-durable",
    "channel-telegram-webhook",
    "execution-do",
    "tool-read",
    "tool-write",
    "tool-edit",
    "tool-bash",
    "tool-fetch",
    "tool-websearch-brave",
    "deployment-cloudflare",
  ].sort());
  expect(manifest.components["outbound-durable"].installedFor).toEqual(["channel-telegram-webhook"]);
  expect(manifest.components["channel-telegram-webhook"].hooks).toEqual({ afterDeploy: "src/pikit/channel-telegram-webhook/deploy.ts" });

  const config = readFileSync(join(project, "pikit.config.ts"), "utf8");
  // The Worker checks and routes: secrets, the mailbox, the channel's ingress half (C1).
  expect(config).toContain(
    "export const worker = defineApp({\n  components: [\n    secretsCloudflare,\n    platformCloudflare,\n    channelTelegramWebhookWorker,\n  ],\n  config: workerConfig,\n});",
  );
  // The object owns the conversation: everything else, and the router sends every message to the agent.
  expect(config).toContain(
    "export default defineApp({\n  components: [\n    agents,\n    secretsCloudflare,\n    platformCloudflare,\n    storageDo,\n    storageKvSql,\n    providerOpenrouter,\n    runtimePi,\n    conversationsKv,\n    routerBasic,\n    outboundDurable,\n    channelTelegramWebhook,\n    executionDo,\n    toolRead,\n    toolWrite,\n    toolEdit,\n    toolBash,\n    toolFetch,\n    toolWebsearchBrave,\n  ],",
  );
  expect(config).toContain('"router-basic": { defaultAgent: "assistant" },');
  expect(config).not.toContain("deploymentCloudflare");

  const agent = readFileSync(join(project, "src", "agents", "assistant", "agent.ts"), "utf8");
  expect(agent).toContain('model: "openrouter/z-ai/glm-5.3-flash",');
  expect(agent).toContain('tools: ["read","write","edit","bash","fetch","websearch"],');
  // The Telegram variables are the channel's; the Brave key is optional, and so are the model's key
  // and the Telegram bot's password (the Deploy to Cloudflare button's way to let the owner in).
  const optional = Object.values(manifest.components as Record<string, { environment: { name: string; required: boolean }[] }>)
    .flatMap((c) => c.environment)
    .filter((v) => !v.required)
    .map((v) => v.name);
  expect(optional.sort()).toEqual(["BRAVE_API_KEY", "OPENROUTER_API_KEY", "TELEGRAM_PASSWORD"]);
}, 60_000);

test("add without a terminal needs --yes, and writes nothing without it", async () => {
  const dir = tinyProject();
  const before = readdirSync(dir).sort();
  const run = await runCli(["add", "log-events"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("pass --yes");
  expect(readdirSync(dir).sort()).toEqual(before);
  expect((await runCli(["add", "no-such-thing", "--yes"], dir)).err).toContain('no component "no-such-thing"');
});

test("new records the builtin registry, not this machine's path to it", async () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after pikit.json is written.
  const run = await runCli(["new", "fresh", "--registry", DEFAULT_REGISTRY], parent, { env: { NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" } });
  expect(run.err).toContain("`bun install` failed");
  // On a server, the starter's model stays Anthropic's.
  expect(readFileSync(join(parent, "fresh", "src", "agents", "assistant", "agent.ts"), "utf8")).toContain('model: "anthropic/claude-sonnet-4-6",');
  const manifest = JSON.parse(readFileSync(join(parent, "fresh", "pikit.json"), "utf8"));
  expect(manifest.version).toBe(1);
  expect(manifest.registries).toEqual({ default: "builtin" });
  // No component of a server project declares wrangler, so it has none.
  expect(Object.keys(JSON.parse(readFileSync(join(parent, "fresh", "package.json"), "utf8")).devDependencies)).toEqual(["@types/bun", "typescript"]);
  // The kit it vendored, by the commit it was packed from.
  expect(manifest.kit).toEqual(kitCommit() === undefined ? undefined : { commit: kitCommit() });
}, 60_000);

test("new that fails after writing leaves the directory marked unfinished, says to delete it, and refuses to go on in it", async () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after every file is written.
  const run = await runCli(["new", "fresh"], parent, { env: { NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" } });
  expect(run.code).toBe(1);
  const project = join(parent, "fresh");
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain(`${project} is left unfinished: delete it, then run \`pikit new\` again`);
  // Kept as it is, with what failed to read in it, and marked.
  expect(existsSync(join(project, "pikit.json"))).toBe(true);
  expect(readFileSync(join(project, UNFINISHED), "utf8")).toContain("delete this directory, then run `pikit new` again");

  const again = await runCli(["new", "fresh"], parent);
  expect(again.code).toBe(1);
  expect(again.err).toContain(`${project} is a \`pikit new\` that did not finish: delete it, then run it again`);
}, 60_000);

test("the guided path does not continue an unfinished new: it offers to delete it and make it again", async () => {
  const parent = temp();
  const project = join(parent, "half");
  mkdirSync(project);
  writeProjectManifest(project, emptyManifest());
  writeFileSync(join(project, UNFINISHED), "");
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, "new"], {
    cwd: parent,
    terminal: { cols: 160, rows: 50, data: (_terminal, data) => void (output += decoder.decode(data)) },
  });
  const waitFor = async (expected: string) => {
    const deadline = Date.now() + 20_000;
    while (!output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").includes(expected)) {
      if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`never printed ${JSON.stringify(expected)}; printed:\n${output}`);
      await Bun.sleep(20);
    }
  };
  await waitFor("Name of your agent");
  proc.terminal?.write("half\r");
  await waitFor("half is a `pikit new` that did not finish. Delete it and make it again?");
  // Not "continuing with half": the default answer deletes it, and the next question is the new project's.
  proc.terminal?.write("\r");
  await waitFor("Where should it run?");
  expect(output).not.toContain("continuing with half");
  expect(existsSync(project)).toBe(false);
  proc.terminal?.write("\u0003");
  expect(await proc.exited).toBe(130);
  expect(existsSync(project)).toBe(false);
}, 30_000);

/**
 * A project made on another machine, cloned here: its `pikit.json` names the builtin registry, and
 * does not record its kit (made by a CLI not in Git). Its kit is this CLI's
 * (the tarball's name is current), and `@pikit/core` and `@pikit/contracts` are linked as `bun install`
 * would, so `add` runs to the end without the network.
 */
function clonedProject(): string {
  const made = temp();
  writeFileSync(
    join(made, "pikit.json"),
    JSON.stringify({ version: 1, targets: ["server"], registries: { default: "builtin" }, components: {} }),
  );
  const contracts = kitSpecifier("@pikit/contracts");
  mkdirSync(join(made, "vendor"));
  writeFileSync(join(made, contracts.slice("file:".length)), "this CLI's kit");
  writeFileSync(join(made, "package.json"), `${JSON.stringify({ name: "cloned", dependencies: { "@pikit/contracts": contracts } }, null, 2)}\n`);
  writeFileSync(join(made, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  mkdirSync(join(made, "node_modules", "@pikit"), { recursive: true });
  for (const kit of ["core", "contracts"]) symlinkSync(join(import.meta.dir, "..", "..", kit), join(made, "node_modules", "@pikit", kit));
  // Another directory, as on another machine: nothing may depend on where it was made.
  const clone = join(temp(), "cloned");
  cpSync(made, clone, { recursive: true, verbatimSymlinks: true });
  rmSync(made, { recursive: true, force: true });
  return clone;
}

test("a project cloned on another machine resolves its builtin registry here, and add works", async () => {
  const dir = clonedProject();
  const run = await runCli(["add", "log-events", "--yes"], dir);
  expect(run.err).not.toContain("is not a registry");
  expect(run.out).toContain("log-events installed; `pikit doctor` is green");
  expect(run.code).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));
  expect(manifest.version).toBe(1);
  expect(manifest.registries).toEqual({ default: "builtin" });
  expect(Object.keys(manifest.components)).toEqual(["log-events"]);
  // The kit it accepts, which a later add checks before it changes the project's kit.
  expect(manifest.components["log-events"].requires).toEqual({ pikit: "0.0.0", contracts: "0.0.0" });
  // Its tarballs are this CLI's: the kit it did not record is this CLI's now.
  expect(manifest.kit).toEqual(kitCommit() === undefined ? undefined : { commit: kitCommit() });
}, 60_000);

test("add keeps each installed file's base, named by its hash; remove deletes the bases no component names", async () => {
  const dir = clonedProject();
  expect((await runCli(["add", "log-events", "--yes"], dir)).code).toBe(0);
  const files: Record<string, { hash: string }> = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8")).components["log-events"].files;
  expect(Object.keys(files).length).toBeGreaterThan(0);
  const base = (hash: string) => join(dir, "pikit-bases", hash.slice("sha256:".length));
  for (const [file, { hash }] of Object.entries(files)) {
    expect(hashOf(readFileSync(base(hash)))).toBe(hash);
    expect(readFileSync(base(hash), "utf8")).toBe(readFileSync(join(dir, file), "utf8"));
  }
  expect(readdirSync(join(dir, "pikit-bases")).length).toBe(Object.keys(files).length);

  // Another component installed a file with the same content: its base stays with it.
  const [shared, { hash: sharedHash }] = Object.entries(files)[0] as [string, { hash: string }];
  const manifest = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));
  manifest.components["log-copy"] = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: { "src/copy.ts": { hash: sharedHash } }, dependencies: {}, environment: [] };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "src", "copy.ts"), readFileSync(join(dir, shared)));

  expect((await runCli(["remove", "log-events"], dir)).code).toBe(0);
  expect(readdirSync(join(dir, "pikit-bases"))).toEqual([sharedHash.slice("sha256:".length)]);
  expect((await runCli(["remove", "log-copy"], dir)).code).toBe(0);
  expect(existsSync(join(dir, "pikit-bases"))).toBe(false);
}, 60_000);

test("add from a registry outside the project says the project is not portable; the builtin one and one inside it do not", async () => {
  const dir = tinyProject();
  expect((await runCli(["add", "log-events", "--registry", DEFAULT_REGISTRY], dir)).err).not.toContain("is a path on this machine");
  // A copy of the builtin registry, elsewhere: a path of this machine.
  const copy = join(temp(), "registry");
  cpSync(DEFAULT_REGISTRY, copy, { recursive: true });
  expect((await runCli(["add", "log-events", "--registry", copy], dir)).err).toContain(`the registry ${copy} is a path on this machine`);
  const inside = join(dir, "vendor-registry");
  cpSync(copy, inside, { recursive: true });
  const run = await runCli(["add", "log-events", "--registry", inside], dir);
  expect(run.err).not.toContain("is a path on this machine");
  expect(run.err).toContain("pass --yes");
}, 60_000);

/**
 * A project whose agent `soporte` names `bash`, provided by an installed `tool-bash`, and a
 * `runtime` that reads the tools as `runtime-pi` does. Stand-ins, not the registry's components:
 * what is checked is the CLI's, and `@pikit/core` is this repository's, linked as `bun install` would.
 */
function agentProject(tools: string[]): string {
  const dir = temp();
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  writeFileSync(join(dir, "package.json"), '{ "name": "agents", "dependencies": {} }\n');
  const files: Record<string, string> = {
    "src/pikit/tool-bash/index.ts":
      'import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "tool-bash",\n  setup(pikit) {\n    pikit.provideKeyed("agent.tool", "bash", { name: "bash" });\n  },\n});\n',
    "src/extensions/runtime.ts":
      'import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "runtime",\n  setup(pikit) {\n    pikit.useKeyed("agent.definition");\n    pikit.useKeyed("agent.tool");\n  },\n});\n',
    "src/extensions/agents.ts": `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "agents",\n  setup(pikit) {\n    pikit.provideKeyed("agent.definition", "soporte", { name: "soporte", model: "test/model", tools: ${JSON.stringify(tools)} });\n  },\n});\n`,
    "pikit.config.ts":
      'import { defineApp } from "@pikit/core";\nimport agents from "./src/extensions/agents.ts";\nimport runtime from "./src/extensions/runtime.ts";\nimport toolBash from "./src/pikit/tool-bash/index.ts";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n    agents,\n    runtime,\n    toolBash,\n  ],\n  config,\n});\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const manifest = emptyManifest();
  const toolFile = "src/pikit/tool-bash/index.ts";
  manifest.components["tool-bash"] = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: { [toolFile]: { hash: hashOf(files[toolFile] ?? "") } }, dependencies: {}, environment: [] };
  writeProjectManifest(dir, manifest);
  return dir;
}

test("doctor fails when an agent names a tool no installed component provides", async () => {
  const green = await runCli(["doctor"], agentProject(["bash"]));
  expect(green.out).toContain("pikit doctor: green");
  expect(green.code).toBe(0);

  const broken = await runCli(["doctor"], agentProject(["bash", "shell"]));
  expect(broken.code).toBe(1);
  expect(broken.err).toContain('agent "soporte" names the tool "shell", which no installed component provides (agent.tool)');
});

test("doctor fails when the project's own code imports Pi: only @pikit/pi-adapter does", async () => {
  const dir = agentProject(["bash"]);
  // Built, so this file does not import Pi itself in the boundaries' eyes.
  const pi = '"@earendil-works/pi-ai"';
  writeFileSync(join(dir, "src/extensions/pi.ts"), `import type { Models } from ${pi};\n\nexport type M = Models;\n`);
  const broken = await runCli(["doctor"], dir);
  expect(broken.code).toBe(1);
  expect(broken.err).toContain('src/extensions/pi.ts imports "@earendil-works/pi-ai": only @pikit/pi-adapter imports Pi');
});

test("remove refuses to take a tool an agent names; with --force it removes it, and doctor reports the name", async () => {
  const dir = agentProject(["bash"]);
  const config = readFileSync(join(dir, "pikit.config.ts"), "utf8");
  const refused = await runCli(["remove", "tool-bash"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain('agent "soporte" names the tool "bash", which only tool-bash provides');
  expect(refused.err).toContain("pass --force");
  expect(existsSync(join(dir, "src/pikit/tool-bash/index.ts"))).toBe(true);
  expect(readFileSync(join(dir, "pikit.config.ts"), "utf8")).toBe(config);

  const forced = await runCli(["remove", "tool-bash", "--force"], dir);
  expect(forced.out).toContain("tool-bash removed");
  expect(existsSync(join(dir, "src/pikit/tool-bash"))).toBe(false);
  expect(forced.code).toBe(1);
  expect(forced.err).toContain('agent "soporte" names the tool "bash", which no installed component provides (agent.tool)');

  const doctor = await runCli(["doctor"], dir);
  expect(doctor.code).toBe(1);
  expect(doctor.err).toContain('agent "soporte" names the tool "bash", which no installed component provides (agent.tool)');
});

test("configure --login-method takes browser or code, and only with --login", async () => {
  const cwd = tinyProject();
  const alone = await runCli(["configure", "--yes", "--login-method", "code"], cwd);
  expect(alone.code).toBe(2);
  expect(alone.err).toContain("--login-method needs --login <provider>");
  const unknown = await runCli(["configure", "--yes", "--login", "anthropic", "--login-method", "copy_code"], cwd);
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("--login-method must be one of: browser, code");
});
