/**
 * The `pikit` binary, run as a user runs it: exit codes and refusals that must happen before any
 * file is written. No `bun install`, no network. The full path (new → configure → dev, add/remove)
 * is `e2e.test.ts`.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, hashOf, writeProjectManifest } from "./project/pikit-json.ts";
import { DEFAULT_REGISTRY } from "./paths.ts";
import { openRegistry } from "./project/registry-source.ts";
import { kitCommit, kitSpecifier } from "./project/vendor.ts";

const MAIN = join(import.meta.dir, "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-cli-test-"));
  dirs.push(dir);
  return dir;
};

function pikit(args: string[], cwd: string) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** The smallest project `add` accepts: a manifest, a composition root, a package.json. */
function tinyProject(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "tiny", "dependencies": {} }\n');
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  return dir;
}

test("--version, help, unknown commands and commands of later milestones", () => {
  const cwd = temp();
  expect(pikit(["--version"], cwd).out).toMatch(/^pikit \d+\.\d+\.\d+/);
  expect(pikit(["--help"], cwd).code).toBe(0);
  expect(pikit(["frobnicate"], cwd).code).toBe(2);
  expect(pikit(["add", "--bogus"], cwd).code).toBe(2);
  const later = pikit(["upgrade"], cwd);
  expect(later.code).toBe(1);
  expect(later.out).toContain("not yet; it arrives in M3");
});

test("pikit registry validate runs the repository's registry checks", () => {
  const run = pikit(["registry", "validate"], temp());
  expect(run.out).toContain("registry validate: ok");
  expect(run.code).toBe(0);
});

test("pikit registry capabilities prints what each capability is and who provides and uses it", () => {
  const run = pikit(["registry", "capabilities"], temp());
  expect(run.code).toBe(0);
  expect(run.out).toContain("sessions.store  (single, @pikit/pi-adapter, experimental)");
  expect(run.out).toContain("provided by: sessions-jsonl");
  expect(pikit(["registry", "bogus"], temp()).code).toBe(2);
});

test("project commands outside a project, and up with no deployment component, say what to do", () => {
  const outside = pikit(["doctor"], temp());
  expect(outside.code).toBe(1);
  expect(outside.err).toContain("is not a pikit project");

  const up = pikit(["up"], tinyProject());
  expect(up.code).toBe(1);
  expect(up.err).toContain("no deployment-* component is installed");
});

test("new with no directory asks only on a terminal; the presets it offers have titles", () => {
  const parent = temp();
  const run = pikit(["new"], parent);
  expect(run.code).toBe(2);
  expect(run.err).toContain("without <dir>, run it in a terminal: it asks");
  expect(readdirSync(parent)).toEqual([]);

  const presets = openRegistry(DEFAULT_REGISTRY).presets();
  expect(presets.map((p) => p.name)).toEqual(["cloudflare-minimal", "http", "telegram", "telegram-cloudflare"]);
  for (const preset of presets) expect(preset.title).not.toBe(preset.name);
});

test("new refuses a non-empty directory and an unknown preset before writing anything", () => {
  const parent = temp();
  mkdirSync(join(parent, "busy"));
  writeFileSync(join(parent, "busy", "file"), "");
  expect(pikit(["new", "busy"], parent).err).toContain("is not empty");

  const unknown = pikit(["new", "fresh", "--preset", "nope"], parent);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no preset "nope"');
  expect(existsSync(join(parent, "fresh"))).toBe(false);

  const notAsked = pikit(["new", "fresh", "--preset", "http", "--with", "tool-bash"], parent);
  expect(notAsked.code).toBe(1);
  expect(notAsked.err).toContain("has no choice of tool-* components; add tool-bash after");
  const noPreset = pikit(["new", "fresh", "--with", "channel-telegram"], parent);
  expect(noPreset.code).toBe(1);
  expect(noPreset.err).toContain("--with answers a preset's questions: it needs --preset");
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("new refuses a preset component that does not run on a new project's target, before writing anything", () => {
  const registry = temp();
  const manifest = (name: string, targets: string[]) => ({
    name, version: "0.0.0", description: name, targets, requires: { pikit: "0.0.0", capabilities: [] },
    optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }],
  });
  const index: Record<string, unknown> = {};
  for (const [name, targets] of [["secrets-env", ["server"]], ["channel-edge", ["cloudflare"]]] as const) {
    mkdirSync(join(registry, "components", name), { recursive: true });
    writeFileSync(join(registry, "components", name, "component.json"), JSON.stringify(manifest(name, [...targets])));
    index[name] = { version: "0.0.0", description: name, targets, path: `components/${name}` };
  }
  writeFileSync(join(registry, "registry.json"), JSON.stringify({ version: 1, components: index }));
  mkdirSync(join(registry, "presets"));
  writeFileSync(join(registry, "presets", "edge.yaml"), "components: [secrets-env, channel-edge]\n");

  const parent = temp();
  const run = pikit(["new", "fresh", "--preset", "edge", "--registry", registry], parent);
  expect(run.code).toBe(1);
  expect(run.err).toContain("channel-edge runs on cloudflare, not on this project's server target");
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("new --target: an unknown target, and a preset that does not run on the chosen one, are refused before writing anything", () => {
  const parent = temp();
  const mars = pikit(["new", "fresh", "--target", "mars"], parent);
  expect(mars.code).toBe(2);
  expect(mars.err).toContain('--target is one of server, cloudflare, not "mars"');

  const server = pikit(["new", "fresh", "--target", "cloudflare", "--preset", "http"], parent);
  expect(server.code).toBe(1);
  expect(server.err).toContain("runs on server, not on this project's cloudflare target");
  const edge = pikit(["new", "fresh", "--preset", "cloudflare-minimal"], parent);
  expect(edge.code).toBe(1);
  expect(edge.err).toContain("storage-do runs on cloudflare, not on this project's server target");
  // The target is never guessed from the preset, but the refusal says which one it runs on.
  expect(edge.err).toContain('the preset "cloudflare-minimal" runs on cloudflare: pikit new fresh --target cloudflare --preset cloudflare-minimal');
  const bot = pikit(["new", "fresh", "--preset", "telegram-cloudflare"], parent);
  expect(bot.code).toBe(1);
  expect(bot.err).toContain("pikit new fresh --target cloudflare --preset telegram-cloudflare");
  // A target that was chosen gets no hint: it was not forgotten.
  expect(server.err).not.toContain("runs on server: pikit new");
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("new --target cloudflare records the target, and writes two Apps, wrangler and the Cloudflare components", () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after every file is written.
  const run = Bun.spawnSync([process.execPath, MAIN, "new", "edge", "--target", "cloudflare", "--preset", "cloudflare-minimal"], {
    cwd: parent,
    env: { ...process.env, NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toContain("`bun install` failed");
  const project = join(parent, "edge");
  const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
  expect(manifest.targets).toEqual(["cloudflare"]);
  expect(Object.keys(manifest.components).sort()).toEqual(["conversations-kv", "deployment-cloudflare", "sessions-sql", "storage-do", "storage-kv-sql"]);
  // Offered among the providers that run on Cloudflare: storage-kv-sql, never storage-sqlite.
  expect(manifest.components["storage-kv-sql"].installedFor).toEqual(["conversations-kv"]);
  expect(Object.keys(manifest.components["deployment-cloudflare"].files)).toContain("wrangler.jsonc");

  const config = readFileSync(join(project, "pikit.config.ts"), "utf8");
  expect(config).toContain("export default defineApp({\n  components: [\n    agents,\n    storageDo,\n    sessionsSql,\n    storageKvSql,\n    conversationsKv,\n  ],");
  expect(config).toContain("export const worker = defineApp({\n  components: [\n  ],\n  config: workerConfig,\n});");
  expect(config).not.toContain("deploymentCloudflare");
  expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).devDependencies.wrangler).toBe("4.143.0");
  expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".wrangler/\n");
  expect(existsSync(join(project, "wrangler.jsonc"))).toBe(true);
  // The starter's model is one whose provider runs on Cloudflare: provider-anthropic is server-only.
  expect(readFileSync(join(project, "src", "agents", "assistant", "agent.ts"), "utf8")).toContain('model: "openrouter/z-ai/glm-5.3-flash",');
}, 60_000);

test("new --target cloudflare --preset telegram-cloudflare: a whole bot, each half in its App, its agent naming the installed tools", () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after every file is written.
  const run = Bun.spawnSync([process.execPath, MAIN, "new", "bot", "--target", "cloudflare", "--preset", "telegram-cloudflare"], {
    cwd: parent,
    env: { ...process.env, NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toContain("`bun install` failed");
  // Every add was accepted: nothing refused, nothing missing in either App along the way.
  expect(run.stderr.toString()).not.toContain("is not provided");
  expect(run.stdout.toString()).toContain("outbound-durable, for channel-telegram-webhook");
  const project = join(parent, "bot");
  const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
  expect(manifest.targets).toEqual(["cloudflare"]);
  expect(Object.keys(manifest.components).sort()).toEqual([
    "secrets-cloudflare",
    "platform-cloudflare",
    "storage-do",
    "storage-kv-sql",
    "submissions-sql",
    "sessions-sql",
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
    "export default defineApp({\n  components: [\n    agents,\n    secretsCloudflare,\n    platformCloudflare,\n    storageDo,\n    storageKvSql,\n    submissionsSql,\n    sessionsSql,\n    conversationsKv,\n    providerOpenrouter,\n    createRuntimePi({ extensions: [permissionGate] }),\n    routerBasic,\n    outboundDurable,\n    channelTelegramWebhook,\n    executionDo,\n    toolRead,\n    toolWrite,\n    toolEdit,\n    toolBash,\n    toolFetch,\n    toolWebsearchBrave,\n  ],",
  );
  expect(config).toContain('"router-basic": { defaultAgent: "assistant" },');
  expect(config).not.toContain("deploymentCloudflare");

  const agent = readFileSync(join(project, "src", "agents", "assistant", "agent.ts"), "utf8");
  expect(agent).toContain('model: "openrouter/z-ai/glm-5.3-flash",');
  expect(agent).toContain('tools: ["read","write","edit","bash","fetch","websearch"],');
  // The Telegram variables are the channel's; the Brave key is optional, and so is the model's key.
  const optional = Object.values(manifest.components as Record<string, { environment: { name: string; required: boolean }[] }>)
    .flatMap((c) => c.environment)
    .filter((v) => !v.required)
    .map((v) => v.name);
  expect(optional.sort()).toEqual(["BRAVE_API_KEY", "OPENROUTER_API_KEY"]);
}, 60_000);

test("add without a terminal needs --yes, and writes nothing without it", () => {
  const dir = tinyProject();
  const before = readdirSync(dir).sort();
  const run = pikit(["add", "log-events"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("pass --yes");
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(pikit(["add", "no-such-thing", "--yes"], dir).err).toContain('no component "no-such-thing"');
});

test("new records the builtin registry, not this machine's path to it", () => {
  const parent = temp();
  // Nothing resolves: `bun install` fails at once, after pikit.json is written.
  const run = Bun.spawnSync([process.execPath, MAIN, "new", "fresh", "--registry", DEFAULT_REGISTRY], {
    cwd: parent,
    env: { ...process.env, NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toContain("`bun install` failed");
  // On a server, the starter's model stays Anthropic's.
  expect(readFileSync(join(parent, "fresh", "src", "agents", "assistant", "agent.ts"), "utf8")).toContain('model: "anthropic/claude-sonnet-4-6",');
  const manifest = JSON.parse(readFileSync(join(parent, "fresh", "pikit.json"), "utf8"));
  expect(manifest.version).toBe(2);
  expect(manifest.registries).toEqual({ default: "builtin" });
  // The kit it vendored, by the commit it was packed from.
  expect(manifest.kit).toEqual(kitCommit() === undefined ? undefined : { commit: kitCommit() });
}, 60_000);

/**
 * A project made on another machine, cloned here: its `pikit.json` is version 1 and names the
 * registry of that machine's pikit checkout, a path that does not exist here. Its kit is this CLI's
 * (the tarball's name is current), and `@pikit/core` and `@pikit/contracts` are linked as `bun install`
 * would, so `add` runs to the end without the network.
 */
function clonedProject(): string {
  const made = temp();
  writeFileSync(
    join(made, "pikit.json"),
    JSON.stringify({ version: 1, targets: ["server"], registries: { default: "/home/someone/.pikit/pikit/registry" }, components: {} }),
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

test("a project cloned on another machine resolves its registry: a v1 checkout path is builtin, and add works", () => {
  const dir = clonedProject();
  const run = pikit(["add", "log-events", "--yes"], dir);
  expect(run.err).not.toContain("is not a registry");
  expect(run.out).toContain("log-events installed; `pikit doctor` is green");
  expect(run.code).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));
  expect(manifest.version).toBe(2);
  expect(manifest.registries).toEqual({ default: "builtin" });
  expect(Object.keys(manifest.components)).toEqual(["log-events"]);
  // Its tarballs are this CLI's: the kit it did not record is this CLI's now.
  expect(manifest.kit).toEqual(kitCommit() === undefined ? undefined : { commit: kitCommit() });
}, 60_000);

test("add keeps each installed file's base, named by its hash; remove deletes the bases no component names", () => {
  const dir = clonedProject();
  expect(pikit(["add", "log-events", "--yes"], dir).code).toBe(0);
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
  manifest.components["log-copy"] = { registry: "default", version: "0.0.0", files: { "src/copy.ts": { hash: sharedHash } }, dependencies: {}, environment: [] };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "src", "copy.ts"), readFileSync(join(dir, shared)));

  expect(pikit(["remove", "log-events"], dir).code).toBe(0);
  expect(readdirSync(join(dir, "pikit-bases"))).toEqual([sharedHash.slice("sha256:".length)]);
  expect(pikit(["remove", "log-copy"], dir).code).toBe(0);
  expect(existsSync(join(dir, "pikit-bases"))).toBe(false);
}, 60_000);

test("add from a registry outside the project says the project is not portable; the builtin one and one inside it do not", () => {
  const dir = tinyProject();
  expect(pikit(["add", "log-events", "--registry", DEFAULT_REGISTRY], dir).err).not.toContain("is a path on this machine");
  // A copy of the builtin registry, elsewhere: a path of this machine.
  const copy = join(temp(), "registry");
  cpSync(DEFAULT_REGISTRY, copy, { recursive: true });
  expect(pikit(["add", "log-events", "--registry", copy], dir).err).toContain(`the registry ${copy} is a path on this machine`);
  const inside = join(dir, "vendor-registry");
  cpSync(copy, inside, { recursive: true });
  const run = pikit(["add", "log-events", "--registry", inside], dir);
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
  manifest.components["tool-bash"] = { registry: "default", version: "0.0.0", files: { [toolFile]: { hash: hashOf(files[toolFile] ?? "") } }, dependencies: {}, environment: [] };
  writeProjectManifest(dir, manifest);
  return dir;
}

test("doctor fails when an agent names a tool no installed component provides", () => {
  const green = pikit(["doctor"], agentProject(["bash"]));
  expect(green.out).toContain("pikit doctor: green");
  expect(green.code).toBe(0);

  const broken = pikit(["doctor"], agentProject(["bash", "shell"]));
  expect(broken.code).toBe(1);
  expect(broken.err).toContain('agent "soporte" names the tool "shell", which no installed component provides (agent.tool)');
});

test("doctor fails on a Pi extension importing what the shim lacks, and notes what pikit does not provide", () => {
  const dir = agentProject(["bash"]);
  const alias = '"@earendil-works/pi-coding-agent"';
  writeFileSync(
    join(dir, "src/extensions/tui.ts"),
    `import type { ExtensionAPI } from ${alias};\n\nexport default function (pi: ExtensionAPI) {\n  pi.on("input", (_event, ctx) => ctx.ui.custom(() => undefined));\n}\n`,
  );
  const noted = pikit(["doctor"], dir);
  expect(noted.out).toContain('src/extensions/tui.ts uses what pikit does not provide to Pi extensions; it does nothing or fails when called (SPEC §6.2b): pi.on("input"), ctx.ui.custom');
  expect(noted.out).toContain("pikit doctor: green");
  expect(noted.code).toBe(0);

  writeFileSync(join(dir, "src/extensions/header.ts"), `import { VERSION, type ExtensionAPI } from ${alias};\n\nexport default (pi: ExtensionAPI) => void VERSION;\n`);
  const broken = pikit(["doctor"], dir);
  expect(broken.code).toBe(1);
  expect(broken.err).toContain("src/extensions/header.ts imports `VERSION` from @earendil-works/pi-coding-agent, which pikit does not provide (SPEC §6.2b)");
});

test("remove refuses to take a tool an agent names; with --force it removes it, and doctor reports the name", () => {
  const dir = agentProject(["bash"]);
  const config = readFileSync(join(dir, "pikit.config.ts"), "utf8");
  const refused = pikit(["remove", "tool-bash"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain('agent "soporte" names the tool "bash", which only tool-bash provides');
  expect(refused.err).toContain("pass --force");
  expect(existsSync(join(dir, "src/pikit/tool-bash/index.ts"))).toBe(true);
  expect(readFileSync(join(dir, "pikit.config.ts"), "utf8")).toBe(config);

  const forced = pikit(["remove", "tool-bash", "--force"], dir);
  expect(forced.out).toContain("tool-bash removed");
  expect(existsSync(join(dir, "src/pikit/tool-bash"))).toBe(false);
  expect(forced.code).toBe(1);
  expect(forced.err).toContain('agent "soporte" names the tool "bash", which no installed component provides (agent.tool)');

  const doctor = pikit(["doctor"], dir);
  expect(doctor.code).toBe(1);
  expect(doctor.err).toContain('agent "soporte" names the tool "bash", which no installed component provides (agent.tool)');
});
