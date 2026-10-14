/**
 * Commands an installed component adds to the CLI (`commands` in its component.json,
 * features/component-commands.md): `registry validate` refuses a name of the CLI's own, one not in
 * kebab-case, and a file not the component's own; `pikit add` records them by project path, one owner
 * per name; `pikit upgrade` records the new ones, `pikit remove` drops them; `pikit <name> [args...]`
 * runs the component's `command(io)` in the project. Run as a user runs them, on registries of this
 * test's own (no npm dependencies, so no `bun install`) and `@pikit/core` linked as `bun install` would.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { generate, validate } from "../registry/commands.ts";
import { BUILT_IN_COMMANDS, type Manifest } from "../registry/manifest.ts";
import { runCli } from "../testing/cli.ts";
import { DEPLOYMENT_COMMANDS } from "./deployment.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-component-commands-test-"));
  dirs.push(dir);
  return dir;
};

const INDEX = (name: string) =>
  `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "${name}",\n  config: { type: "object", properties: { greeting: { type: "string" } } } as never,\n  setup() {},\n});\n`;

/** Says what it got; `--fail` reports a problem, `--no-config` never asks for its config. */
const GENERATE = `export async function command(io: {
  args: readonly string[];
  config(): Promise<Readonly<Record<string, unknown>>>;
  get(name: string): string | undefined;
  say(line: string): void;
}): Promise<string[] | void> {
  io.say(\`args: \${JSON.stringify(io.args)}\`);
  if (!io.args.includes("--no-config")) io.say(\`config: \${JSON.stringify(await io.config())}\`);
  io.say(\`env: \${io.get("AGENTS_VAR")}\`);
  if (io.args.includes("--fail")) return ["the agents do not agree"];
}
`;

const AGENTS = { agents: { file: "generate.ts", description: "Write the agents" } };

/** Writes `name` at `version` in the registry at `root`, replacing it: `files` of its own directory, `fields` of its manifest. */
function publish(root: string, name: string, version: string, files: Record<string, string>, fields: Record<string, unknown> = {}): void {
  const dir = join(root, "components", name);
  rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries({ "index.ts": INDEX(name), ...files })) {
    mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
    writeFileSync(join(dir, "files", "src", "pikit", name, file), text);
  }
  const manifest = {
    name, version, description: name, targets: ["server"], requires: { pikit: "0.0.0", capabilities: [] },
    optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...fields,
  };
  writeFileSync(join(dir, "component.json"), JSON.stringify(manifest));
  const index = existsSync(join(root, "registry.json")) ? JSON.parse(readFileSync(join(root, "registry.json"), "utf8")) : { version: 1, components: {} };
  index.components[name] = { version, description: name, targets: ["server"], path: `components/${name}` };
  writeFileSync(join(root, "registry.json"), JSON.stringify(index));
}

/** `tool-agents` (the command `agents`) and `tool-rival` (the same name). */
function registry(): string {
  const root = temp();
  publish(root, "tool-agents", "0.1.0", { "generate.ts": GENERATE }, { commands: AGENTS });
  publish(root, "tool-rival", "0.1.0", { "rival.ts": GENERATE }, { commands: { agents: { file: "rival.ts", description: "Agents, another way" } } });
  return root;
}

function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "commanded", "dependencies": {} }\n');
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n',
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const record = (dir: string, name = "tool-agents") => JSON.parse(read(dir, "pikit.json")).components[name];

/** A project with tool-agents installed, its config's greeting set and AGENTS_VAR in .env. */
async function installed(): Promise<{ dir: string; from: string }> {
  const dir = project();
  const from = registry();
  const add = await runCli(["add", "tool-agents", "--registry", from, "--yes"], dir);
  expect(add.out).toContain("tool-agents installed");
  expect(add.code).toBe(0);
  writeFileSync(join(dir, "pikit.config.ts"), read(dir, "pikit.config.ts").replace("export const config = {};", 'export const config = { "tool-agents": { greeting: "hi" } };'));
  writeFileSync(join(dir, ".env"), "AGENTS_VAR=from .env\n");
  return { dir, from };
}

test("every command of main.ts, of the deployment and kept for later is a built-in no component may take", () => {
  const main = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8");
  const cases = [...main.matchAll(/^\s+case "([a-z-]+)":/gm)].map((match) => match[1] as string);
  const later = /const LATER: Record<string, string> = \{([^}]*)\}/.exec(main)?.[1] ?? "";
  const kept = [...later.matchAll(/^\s+([a-z-]+):/gm)].map((match) => match[1] as string);
  expect(cases.length).toBeGreaterThan(5);
  expect(kept.length).toBeGreaterThan(3);
  expect([...new Set([...cases, ...DEPLOYMENT_COMMANDS, ...kept, "help"])].sort()).toEqual([...BUILT_IN_COMMANDS].sort());
});

test("pikit add records the commands by project path; pikit <name> runs them with their arguments, config and environment", async () => {
  const { dir } = await installed();
  expect(record(dir).commands).toEqual({ agents: { file: "src/pikit/tool-agents/generate.ts", description: "Write the agents" } });

  const run = await runCli(["agents", "a", "--b"], dir);
  expect(run.err).toBe("");
  expect(run.out).toBe('args: ["a","--b"]\nconfig: {"greeting":"hi"}\nenv: from .env\n');
  expect(run.code).toBe(0);

  const failed = await runCli(["agents", "--fail"], dir);
  expect(failed.err).toContain("the agents do not agree");
  expect(failed.code).toBe(1);

  // Its config is imported only when asked: a command runs while pikit.config.ts does not import.
  writeFileSync(join(dir, "pikit.config.ts"), 'import "./nowhere.ts";\n');
  const repairing = await runCli(["agents", "--no-config"], dir);
  expect(repairing.out).toContain("env: from .env");
  expect(repairing.code).toBe(0);
  const asking = await runCli(["agents"], dir);
  expect(asking.err).toContain("tool-agents: pikit agents failed:");
  expect(asking.code).toBe(1);

  // No `command` export, or one that throws: a problem.
  writeFileSync(join(dir, "src/pikit/tool-agents/generate.ts"), "export const nothing = 1;\n");
  const none = await runCli(["agents"], dir);
  expect(none.err).toContain("tool-agents: src/pikit/tool-agents/generate.ts does not export command");
  expect(none.code).toBe(1);
  writeFileSync(join(dir, "src/pikit/tool-agents/generate.ts"), 'export async function command() {\n  throw new Error("boom");\n}\n');
  const thrown = await runCli(["agents"], dir);
  expect(thrown.err).toContain("tool-agents: pikit agents failed: boom");
  expect(thrown.code).toBe(1);
}, 60_000);

test("pikit help lists the project's commands after the CLI's; outside a project, the name is an unknown command", async () => {
  const { dir } = await installed();
  const help = await runCli(["help"], dir);
  expect(help.out).toContain("pikit registry validate");
  expect(help.out).toMatch(/This project's components add:\n {2}pikit agents +Write the agents \(tool-agents\)\n/);
  expect(help.code).toBe(0);
  const bare = await runCli([], dir);
  expect(bare.out).toContain("pikit agents");
  expect(bare.code).toBe(2);

  const outside = await runCli(["agents", "--check"], temp());
  expect(outside.err).toContain('unknown command "agents"');
  expect(outside.code).toBe(2);
  expect((await runCli(["help"], temp())).out).not.toContain("This project's components add");
}, 60_000);

test("pikit add refuses a command another component declares, installed or in the same add, writing nothing", async () => {
  const { dir, from } = await installed();
  const before = read(dir, "pikit.json");
  const rival = await runCli(["add", "tool-rival", "--registry", from, "--yes"], dir);
  expect(rival.err).toContain('tool-rival declares the command "pikit agents", which tool-agents already declares');
  expect(rival.code).toBe(1);
  expect(read(dir, "pikit.json")).toBe(before);
  expect(existsSync(join(dir, "src/pikit/tool-rival"))).toBe(false);

  const fresh = project();
  const pristine = read(fresh, "pikit.json");
  const both = await runCli(["add", "tool-agents", "tool-rival", "--registry", from, "--yes"], fresh);
  expect(both.err).toMatch(/tool-(rival|agents) declares the command "pikit agents", which tool-(agents|rival) already declares/);
  expect(both.code).toBe(1);
  expect(read(fresh, "pikit.json")).toBe(pristine);
  expect(existsSync(join(fresh, "src/pikit"))).toBe(false);
}, 60_000);

test("pikit upgrade records the new version's commands; pikit remove takes them with the component", async () => {
  const { dir, from } = await installed();
  const commands = { ...AGENTS, "agents-check": { file: "generate.ts", description: "Check the agents" } };
  publish(from, "tool-agents", "0.2.0", { "generate.ts": GENERATE }, { commands });
  const upgrade = await runCli(["upgrade", "--yes"], dir);
  expect(upgrade.code).toBe(0);
  expect(record(dir).commands).toEqual({
    agents: { file: "src/pikit/tool-agents/generate.ts", description: "Write the agents" },
    "agents-check": { file: "src/pikit/tool-agents/generate.ts", description: "Check the agents" },
  });
  expect((await runCli(["agents-check", "--no-config"], dir)).out).toContain('args: ["--no-config"]');

  const remove = await runCli(["remove", "tool-agents"], dir);
  expect(remove.code).toBe(0);
  expect(record(dir)).toBeUndefined();
  const gone = await runCli(["agents"], dir);
  expect(gone.err).toContain('unknown command "agents"');
  expect(gone.code).toBe(2);
}, 60_000);

/** A registry validate passes but for `component`: `tool-cmd`, on durable, with `commands` and `files` of its own. */
async function validated(commands: Manifest["commands"], files: Record<string, string>): Promise<string[]> {
  const root = temp();
  const own = join(root, "components", "tool-cmd", "files", "src", "pikit", "tool-cmd");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(root, "components", "tool-cmd", "README.md"), "# tool-cmd\n\nA command.\n");
  const all: Record<string, string> = {
    "index.ts": 'import type { ComponentDefinition } from "@pikit/core";\n\nconst component: ComponentDefinition = { name: "tool-cmd", setup() {} };\nexport default component;\n',
    "tool-cmd.test.ts": "// its own test\n",
    ...files,
  };
  for (const [file, text] of Object.entries(all)) writeFileSync(join(own, file), text);
  expect((await generate(root)).problems).toEqual([]);
  const path = join(root, "components", "tool-cmd", "component.json");
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as Manifest), targets: ["durable"], commands }));
  expect((await generate(root)).problems).toEqual([]);
  return (await validate(root)).problems;
}

const MACHINE = 'import { readdirSync } from "node:fs";\n\nexport async function command(): Promise<string[]> {\n  return readdirSync(".").length > 0 ? [] : ["empty"];\n}\n';

test("registry validate: a command file may import node:* on durable, another file may not", async () => {
  expect(await validated({ "make-it": { file: "make.ts", description: "Make it" } }, { "make.ts": MACHINE })).toEqual([]);
  const other = await validated({ "make-it": { file: "make.ts", description: "Make it" } }, { "make.ts": MACHINE, "other.ts": MACHINE });
  expect(other).toEqual([
    'tool-cmd: files/src/pikit/tool-cmd/other.ts imports "node:fs", but targets are ["durable"]: node:* and bun:* need targets ["server"] (SPEC §4)',
  ]);
});

test("registry validate refuses a command named as a built-in or not in kebab-case, and a file not the component's own", async () => {
  const file = { "make.ts": MACHINE };
  expect(await validated({ add: { file: "make.ts", description: "Add" } }, file)).toEqual([
    'tool-cmd: commands.add: "pikit add" is one of the CLI\'s own commands; a component\'s command takes another name',
  ]);
  expect(await validated({ MakeIt: { file: "make.ts", description: "Make" } }, file)).toEqual([
    "tool-cmd: component.json /commands/MakeIt: a command's name is kebab-case",
  ]);
  expect((await validated({ make: { file: "../tool-other/make.ts", description: "Make" } }, file)).join("\n")).toContain("/commands/make/file");
  expect(await validated({ make: { file: "nowhere.ts", description: "Make" } }, { "make.ts": "export {};\n" })).toEqual([
    'tool-cmd: commands.make.file "nowhere.ts" is not a file of files/src/pikit/tool-cmd/',
  ]);
  expect(await validated({ make: { file: "make.ts", description: "Make" } }, { "make.ts": "export const make = 1;\n" })).toEqual([
    'tool-cmd: commands.make.file "make.ts" does not export a function command',
  ]);
  expect((await validated({ make: { file: "make.ts", description: "two\nlines" } }, file)).join("\n")).toContain("/commands/make/description");
}, 60_000);
