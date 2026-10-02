/**
 * `registry generate` / `validate`: the real registry is green, and every check fails on a small
 * fixture that breaks exactly its rule. Fixtures live in temp directories and import nothing at
 * runtime (type-only imports are erased), so they load without the repository's node_modules.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, validate } from "../packages/cli/src/registry/commands.ts";
import { scanImports } from "../packages/cli/src/registry/imports.ts";
import type { Manifest } from "../packages/cli/src/registry/manifest.ts";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Fixture {
  root: string;
  dir: string;
  name: string;
  own: string;
  manifest(): Manifest;
  writeManifest(manifest: Manifest): void;
  append(file: string, line: string): void;
}

const SETUP = `
    pikit.use("agent.conversations");
    pikit.useOptional("model.credentials");
    pikit.useKeyed("agent.tool");
    pikit.provide("conversations.registry", {});`;

/** A valid one-component registry, generated like a real one; `targets` filled in by hand. */
async function fixture(options: { name?: string; setup?: string; fill?: boolean; index?: string } = {}): Promise<Fixture> {
  const name = options.name ?? "conversations-sample";
  const root = mkdtempSync(join(tmpdir(), "pikit-registry-"));
  roots.push(root);
  const dir = join(root, "components", name);
  const own = join(dir, "files", "src", "pikit", name);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nA fixture component.\n`);
  writeFileSync(
    join(own, "index.ts"),
    options.index ??
      `import type { ComponentDefinition } from "@pikit/core";\n\n` +
        `const component: ComponentDefinition = {\n  name: "${name}",\n  setup(pikit) {${options.setup ?? SETUP}\n  },\n};\nexport default component;\n`,
  );
  writeFileSync(join(own, "sample.test.ts"), "// the fixture's own test\n");

  const f: Fixture = {
    root,
    dir,
    name,
    own,
    manifest: () => JSON.parse(readFileSync(join(dir, "component.json"), "utf8")) as Manifest,
    writeManifest: (m) => writeFileSync(join(dir, "component.json"), `${JSON.stringify(m, null, 2)}\n`),
    append: (file, line) => writeFileSync(join(own, file), `${line}\n${readFileSync(join(own, file), "utf8")}`),
  };
  expect((await generate(root)).problems).toEqual([]);
  if (options.fill ?? true) {
    f.writeManifest({ ...f.manifest(), targets: ["server"] });
    expect((await generate(root)).problems).toEqual([]);
  }
  return f;
}

async function problems(f: Fixture): Promise<string> {
  return (await validate(f.root)).problems.join("\n");
}

test("the real registry validates", async () => {
  expect((await validate(join(REPO, "registry"))).problems).toEqual([]);
}, 60_000);

test("a fixture made like a real component validates", async () => {
  expect((await validate((await fixture()).root)).problems).toEqual([]);
});

test("generate writes what setup declares and keeps every hand-written field, even one validate refuses", async () => {
  const f = await fixture();
  expect(f.manifest()).toMatchObject({
    requires: { capabilities: ["agent.conversations"] },
    optional: { capabilities: ["model.credentials", "agent.tool"] },
    provides: ["conversations.registry"],
  });

  const edited = { ...f.manifest(), license: "MIT", provides: ["stale"], devDependencies: { wrangler: "4.143.0" }, custom: { kept: true } };
  f.writeManifest(edited);
  await generate(f.root);
  expect(f.manifest()).toEqual({ ...edited, provides: ["conversations.registry"] });

  const once = readFileSync(join(f.dir, "component.json"), "utf8");
  await generate(f.root);
  expect(readFileSync(join(f.dir, "component.json"), "utf8")).toBe(once);
  expect(Object.keys(f.manifest())).toEqual([
    "$schema", "name", "version", "description", "license", "targets", "requires", "optional", "provides", "dependencies", "devDependencies", "files", "custom",
  ]);
  // Kept, so nothing written by hand is lost; refused, so a typo is not silence.
  expect(await problems(f)).toContain("component.json /custom: is not a known field");
});

test("a new component's skeleton is rejected until its targets are written by hand", async () => {
  const f = await fixture({ fill: false });
  expect(f.manifest().description).toBe("A fixture component.");
  expect(await problems(f)).toContain("component.json /targets: must not have fewer than 1 items");
});

test("drift: generated fields that differ from setup", async () => {
  const f = await fixture();
  f.writeManifest({ ...f.manifest(), provides: [], optional: { capabilities: ["agent.tool"] } });
  const found = await problems(f);
  expect(found).toContain("provides drifted from setup");
  expect(found).toContain("optional.capabilities drifted from setup");
});

test("drift: a manifest not in generated form", async () => {
  const f = await fixture();
  const { name, ...rest } = f.manifest();
  writeFileSync(join(f.dir, "component.json"), JSON.stringify({ ...rest, name }));
  expect(await problems(f)).toContain("not in generated form");
});

test("drift: registry.json out of date", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "registry.json"), "{}\n");
  expect(await problems(f)).toContain("registry.json does not match");
});

test("naming: name equal to its directory, with a known kind prefix", async () => {
  const f = await fixture();
  f.writeManifest({ ...f.manifest(), name: "conversations-other" });
  expect(await problems(f)).toContain(`name "conversations-other" does not match its directory "conversations-sample"`);

  expect(await problems(await fixture({ name: "widget-sample" }))).toContain(`name "widget-sample" has no known kind prefix`);
});

test("layout: tests ship in src/pikit/<name>/, a README exists, no install scripts", async () => {
  const noTest = await fixture();
  rmSync(join(noTest.own, "sample.test.ts"));
  expect(await problems(noTest)).toContain("files/src/pikit/conversations-sample/ has no *.test.ts");

  const noReadme = await fixture();
  rmSync(join(noReadme.dir, "README.md"));
  expect(await problems(noReadme)).toContain("README.md is missing");

  const scripts = await fixture();
  writeFileSync(join(scripts.dir, "files", "package.json"), JSON.stringify({ scripts: { postinstall: "curl … | sh" } }));
  expect(await problems(scripts)).toContain("files/package.json has scripts");
});

test("imports: no sibling component's files (SPEC P4)", async () => {
  const f = await fixture();
  f.append("index.ts", `import type { X } from "../router-basic/index.ts";`);
  expect(await problems(f)).toContain(`imports "../router-basic/index.ts", a file of the component "router-basic"`);
});

test("imports: only the adapter imports Pi", async () => {
  const f = await fixture();
  // Spelled apart so the repository's own import scan (`scripts/boundaries.ts`) does not flag this test.
  const pi = ["@earendil-works", "pi-ai"].join("/");
  f.append("index.ts", `import type { Model } from "${pi}";`);
  expect(await problems(f)).toContain(`imports "@earendil-works/pi-ai": only @pikit/pi-adapter imports Pi`);
});

test("imports: node:* only when targets are exactly [\"server\"]; tests are exempt (SPEC §4)", async () => {
  const f = await fixture();
  f.append("index.ts", `import "node:path";`);
  f.append("sample.test.ts", `import "node:fs";`);
  expect((await validate(f.root)).problems).toEqual([]);

  f.writeManifest({ ...f.manifest(), targets: ["server", "durable"] });
  await generate(f.root);
  const found = await problems(f);
  expect(found).toContain(`index.ts imports "node:path", but targets are ["server","durable"]`);
  expect(found).not.toContain("node:fs");
});

test("imports: a server-only kit export (@pikit/pi-adapter/node) needs targets [\"server\"], as node:* does; tests are exempt (SPEC §4)", async () => {
  const f = await fixture();
  f.append("index.ts", `import type { LocalExecutionOptions } from "@pikit/pi-adapter/node";`);
  f.append("sample.test.ts", `import "@pikit/pi-adapter/testing";`);
  f.writeManifest({ ...f.manifest(), requires: { ...f.manifest().requires, adapter: "0.0.0" }, dependencies: { "@pikit/pi-adapter": "0.0.0" } });
  await generate(f.root);
  expect((await validate(f.root)).problems).toEqual([]);

  f.writeManifest({ ...f.manifest(), targets: ["server", "durable"] });
  await generate(f.root);
  const found = await problems(f);
  expect(found).toContain(`index.ts imports "@pikit/pi-adapter/node", but targets are ["server","durable"]: a server-only kit export needs targets ["server"]`);
  expect(found).not.toContain("@pikit/pi-adapter/testing");
});

/** A deployment component's `index.ts` exporting these functions (the CLI calls them, SPEC §4). */
const deploymentIndex = (...names: string[]) => names.map((name) => `export async function ${name}(): Promise<void> {}\n`).join("");
const DEPLOYMENT_INDEX = deploymentIndex("up", "down", "logs", "status");

test("imports: a deployment component's commands.ts runs on the deploying machine, so it may import node:* on any target (SPEC §4)", async () => {
  const f = await fixture({ name: "deployment-sample", index: DEPLOYMENT_INDEX });
  f.writeManifest({ ...f.manifest(), targets: ["durable"] });
  writeFileSync(join(f.own, "commands.ts"), `import "node:child_process";\n`);
  await generate(f.root);
  expect((await validate(f.root)).problems).toEqual([]);

  // Only that file, and only in a deployment component: its entrypoint still runs on the target.
  f.append("index.ts", `import "node:path";`);
  expect(await problems(f)).toContain(`index.ts imports "node:path", but targets are ["durable"]`);
  const other = await fixture();
  other.writeManifest({ ...other.manifest(), targets: ["server", "durable"] });
  writeFileSync(join(other.own, "commands.ts"), `import "node:child_process";\n`);
  await generate(other.root);
  expect(await problems(other)).toContain(`commands.ts imports "node:child_process"`);
});

test("imports: test support (*.test-support.ts) is held like tests, and only tests may import it (SPEC §4)", async () => {
  const f = await fixture();
  f.writeManifest({ ...f.manifest(), targets: ["server", "durable"] });
  writeFileSync(join(f.own, "storage.test-support.ts"), `import "node:sqlite";\n`);
  f.append("sample.test.ts", `import "./storage.test-support.ts";`);
  await generate(f.root);
  expect((await validate(f.root)).problems).toEqual([]);

  f.append("index.ts", `import "./storage.test-support.ts";`);
  expect(await problems(f)).toContain(`index.ts imports "./storage.test-support.ts", which is test support: only tests may import it`);
});

test("dependencies: exactly the npm packages the files import", async () => {
  const f = await fixture();
  f.append("index.ts", `import type { Hono } from "hono";`);
  f.writeManifest({ ...f.manifest(), dependencies: { "left-pad": "1.3.0" } });
  await generate(f.root);
  const found = await problems(f);
  expect(found).toContain(`files import "hono", which dependencies does not list`);
  expect(found).toContain(`dependencies lists "left-pad", which no file imports`);
});

test("devDependencies: exact versions, none of its dependencies, never the kit; what the files import is a dependency", async () => {
  const f = await fixture();
  f.writeManifest({ ...f.manifest(), devDependencies: { wrangler: "4.143.0" } });
  await generate(f.root);
  expect(await problems(f)).toBe("");

  f.writeManifest({ ...f.manifest(), devDependencies: { wrangler: "^4.143.0" } });
  expect(await problems(f)).toContain("component.json /devDependencies/wrangler: must match pattern");

  f.append("index.ts", `import type { Hono } from "hono";`);
  f.writeManifest({ ...f.manifest(), dependencies: { hono: "4.13.9" }, devDependencies: { hono: "4.13.9", "@pikit/contracts": "0.0.0" } });
  await generate(f.root);
  const found = await problems(f);
  expect(found).toContain(`"hono" is in both dependencies and devDependencies: a package its files import is a dependency`);
  expect(found).toContain(`devDependencies lists the kit package "@pikit/contracts"`);
  // Imported only as a dev dependency: it is still one of its dependencies.
  f.writeManifest({ ...f.manifest(), dependencies: {}, devDependencies: { hono: "4.13.9" } });
  await generate(f.root);
  expect(await problems(f)).toContain(`files import "hono", which dependencies does not list`);
});

test("deployment-cloudflare declares wrangler, the version this repository checks it with", () => {
  const manifest = JSON.parse(readFileSync(join(REPO, "registry", "components", "deployment-cloudflare", "component.json"), "utf8")) as Manifest;
  const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
  expect(manifest.devDependencies).toEqual({ wrangler: root.devDependencies.wrangler as string });
});

test("manifest: no requires.components", async () => {
  const f = await fixture();
  f.writeManifest({ ...f.manifest(), requires: { ...f.manifest().requires, components: ["router-basic"] } as Manifest["requires"] });
  expect(await problems(f)).toContain("component.json /requires/components: is not a known field: components depend on capabilities only");
});

test("files: only files/src maps as a directory; a file outside src is listed on its own", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "files", "Dockerfile"), "FROM scratch\n");

  f.writeManifest({ ...f.manifest(), files: [{ source: "files", target: "." }] });
  expect(await problems(f)).toContain('files maps the directory "files" onto "."');

  f.writeManifest({ ...f.manifest(), files: [{ source: "files/src", target: "src" }, { source: "files/Dockerfile", target: "Dockerfile" }] });
  expect(await problems(f)).toBe("");
});

test("a component with no default export is not an app component: it provides and uses nothing", async () => {
  // Module imports are cached per path, so the file is written before the first generate.
  const f = await fixture({ name: "deployment-sample", index: DEPLOYMENT_INDEX });

  expect(f.manifest()).toMatchObject({ provides: [], requires: { capabilities: [] }, optional: { capabilities: [] } });
  expect(await problems(f)).toBe("");
});

/** A component's half: the export `name`, the component `component`. */
const half = (name: string, component: string, body: string) => `export const ${name}: ComponentDefinition = { name: "${component}", setup(pikit) {${body}} };\n`;

test("apps: a half for the Worker's App is a named export, and the generated fields cover both halves, and say what each declares (C1)", async () => {
  const index =
    `import type { ComponentDefinition } from "@pikit/core";\n` +
    half("objectHalf", "channel-halves", `pikit.use("agent.runtime"); pikit.useOptional("storage.kv"); pikit.provideKeyed("actor.inbox", "sample.message", {});`) +
    half("workerHalf", "channel-halves-worker", `pikit.use("actor.mailbox"); pikit.use("storage.kv"); pikit.provideKeyed("http.route", "POST /sample", {});`) +
    "export default objectHalf;\n";
  const f = await fixture({ name: "channel-halves", index });
  expect(f.manifest()).toMatchObject({ provides: ["actor.inbox"], requires: { capabilities: ["agent.runtime"] } });
  expect(f.manifest().halves).toBeUndefined();

  f.writeManifest({ ...f.manifest(), apps: { worker: "workerHalf" } });
  expect((await generate(f.root)).problems).toEqual([]);
  expect(f.manifest()).toMatchObject({
    provides: ["actor.inbox", "http.route"],
    // Required by one half and optional in the other: required.
    requires: { capabilities: ["agent.runtime", "actor.mailbox", "storage.kv"] },
    optional: { capabilities: [] },
    apps: { worker: "workerHalf" },
  });
  // Each half in its own App: what `pikit add` checks and offers by.
  expect(f.manifest().halves).toEqual({
    default: { provides: ["actor.inbox"], requires: ["agent.runtime"], optional: ["storage.kv"] },
    worker: { provides: ["http.route"], requires: ["actor.mailbox", "storage.kv"], optional: [] },
  });
  expect(await problems(f)).toBe("");

  const generated = f.manifest().halves as NonNullable<Manifest["halves"]>;
  f.writeManifest({ ...f.manifest(), halves: { ...generated, worker: { provides: [], requires: [], optional: [] } } });
  expect(await problems(f)).toContain("halves drifted from setup");
  f.writeManifest({ ...f.manifest(), apps: { worker: "missingHalf" } });
  expect(await problems(f)).toContain('has no export "missingHalf" made with defineComponent');
  f.writeManifest({ ...f.manifest(), apps: { worker: "objectHalf", edge: "x" } as never });
  expect(await problems(f)).toContain("component.json /apps/edge: is not a known field");
  // The default export, as the Worker's half: it would be the same component twice.
  f.writeManifest({ ...f.manifest(), apps: { worker: "objectHalf" } });
  expect(await problems(f)).toContain('the Worker\'s half of channel-halves is named "channel-halves-worker"');
});

test('apps: a Worker half is named "<name>-worker", its config key; "default" puts the component itself in both Apps', async () => {
  // A module is imported once per path: each case is a component of its own.
  const index = `import type { ComponentDefinition } from "@pikit/core";\n${half("main", "channel-misnamed", "")}${half("edge", "edge", `pikit.use("actor.mailbox");`)}export default main;\n`;
  const misnamed = await fixture({ name: "channel-misnamed", index });
  misnamed.writeManifest({ ...misnamed.manifest(), apps: { worker: "edge" } });
  expect((await generate(misnamed.root)).problems).toEqual([
    'channel-misnamed: the export "edge" (apps.worker) is the component "edge": the Worker\'s half of channel-misnamed is named "channel-misnamed-worker", its config key in workerConfig',
  ]);

  const both = await fixture({ name: "secrets-both", setup: `\n    pikit.provide("secrets", {});` });
  both.writeManifest({ ...both.manifest(), apps: { worker: "default" } });
  expect((await generate(both.root)).problems).toEqual([]);
  expect(both.manifest()).toMatchObject({ provides: ["secrets"], apps: { worker: "default" } });
  expect(both.manifest().halves).toBeUndefined();
  expect(await problems(both)).toBe("");
});

test("hooks: afterDeploy names a file of the component that exports it", async () => {
  const f = await fixture({ name: "channel-hooked" });
  writeFileSync(join(f.own, "deploy.ts"), "export async function afterDeploy(): Promise<string[]> {\n  return [];\n}\n");
  writeFileSync(join(f.own, "other.ts"), "export const somethingElse = 1;\n");
  f.writeManifest({ ...f.manifest(), hooks: { afterDeploy: "deploy.ts" } });
  expect((await generate(f.root)).problems).toEqual([]);
  expect(f.manifest().hooks).toEqual({ afterDeploy: "deploy.ts" });
  expect(await problems(f)).toBe("");

  f.writeManifest({ ...f.manifest(), hooks: { afterDeploy: "missing.ts" } });
  expect(await problems(f)).toContain('hooks.afterDeploy "missing.ts" is not a file of files/src/pikit/channel-hooked/');
  f.writeManifest({ ...f.manifest(), hooks: { afterDeploy: "other.ts" } });
  expect(await problems(f)).toContain('hooks.afterDeploy "other.ts" does not export a function afterDeploy');
  f.writeManifest({ ...f.manifest(), hooks: { afterDeploy: "sample.test.ts" } });
  expect(await problems(f)).toContain('hooks.afterDeploy "sample.test.ts" is a test file');
  f.writeManifest({ ...f.manifest(), hooks: { afterDeploy: "../escape.ts" } });
  expect(await problems(f)).toContain("component.json /hooks/afterDeploy:");
});

test("hooks: doctor and beforeDeploy, each a file exporting a function of the hook's name", async () => {
  const f = await fixture({ name: "tool-hooked" });
  writeFileSync(join(f.own, "doctor.ts"), "export async function doctor(): Promise<string[]> {\n  return [];\n}\n");
  writeFileSync(join(f.own, "deploy.ts"), "export async function beforeDeploy(): Promise<string[]> {\n  return [];\n}\n");
  f.writeManifest({ ...f.manifest(), hooks: { doctor: "doctor.ts", beforeDeploy: "deploy.ts" } });
  expect((await generate(f.root)).problems).toEqual([]);
  expect(await problems(f)).toBe("");

  f.writeManifest({ ...f.manifest(), hooks: { doctor: "deploy.ts", beforeDeploy: "doctor.ts" } });
  const found = await problems(f);
  expect(found).toContain('hooks.doctor "deploy.ts" does not export a function doctor');
  expect(found).toContain('hooks.beforeDeploy "doctor.ts" does not export a function beforeDeploy');
  f.writeManifest({ ...f.manifest(), hooks: { onStart: "doctor.ts" } as never });
  expect(await problems(f)).toContain("component.json /hooks/onStart:");
});

test("deployment: index.ts exports up, down, logs and status as functions, restart, dev and exec when it has them, and no near miss", async () => {
  const plain = await fixture({ name: "deployment-sample", index: DEPLOYMENT_INDEX });
  expect(await problems(plain)).toBe("");
  const full = await fixture({ name: "deployment-sample", index: deploymentIndex("up", "down", "restart", "logs", "status", "dev", "exec", "login") });
  expect(await problems(full)).toBe("");

  const missing = await fixture({ name: "deployment-sample", index: deploymentIndex("up", "down", "logs") });
  expect(await problems(missing)).toContain("index.ts does not export status(), which the CLI calls on every deployment component");
  const misspelled = await fixture({
    name: "deployment-sample",
    index: `${deploymentIndex("up", "down", "logs", "status", "restar", "Dev")}export const exec = 1;\n`,
  });
  const found = await problems(misspelled);
  expect(found).toContain("index.ts exports restar: the CLI calls restart, never restar");
  expect(found).toContain("index.ts exports Dev: the CLI calls dev, never Dev");
  expect(found).toContain("index.ts exports exec, but not as a function");
  expect(found).not.toContain("does not export");

  // Only a deployment component: any other kind exports what it likes.
  expect(await problems(await fixture({ name: "tool-sample", index: deploymentIndex("up") }))).toBe("");
});

test("generated: files of the component's own directory that a hook rewrites; not a missing file nor a test file", async () => {
  const f = await fixture({ name: "tool-seeded" });
  writeFileSync(join(f.own, "seed.ts"), "export const seed = {};\n");
  f.writeManifest({ ...f.manifest(), generated: ["seed.ts"] });
  expect((await generate(f.root)).problems).toEqual([]);
  expect(await problems(f)).toBe("");

  f.writeManifest({ ...f.manifest(), generated: ["gone.ts"] });
  expect(await problems(f)).toContain('generated "gone.ts" is not a file of files/src/pikit/tool-seeded/');
  writeFileSync(join(f.own, "seed.test.ts"), "export {};\n");
  f.writeManifest({ ...f.manifest(), generated: ["seed.test.ts"] });
  expect(await problems(f)).toContain('generated "seed.test.ts" is a test file');
  f.writeManifest({ ...f.manifest(), generated: ["../index.ts"] });
  expect(await problems(f)).toContain("component.json /generated/0:");
});

test("tools: replay is generated, and a tool without one fails", async () => {
  const safe = await fixture({ name: "tool-safe", setup: `\n    pikit.provideKeyed("agent.tool", "look", { replay: "safe" });` });
  expect(safe.manifest().replay).toEqual({ tools: { look: "safe" } });
  expect((await validate(safe.root)).problems).toEqual([]);

  const missing = await fixture({ name: "tool-vague", setup: `\n    pikit.provideKeyed("agent.tool", "poke", {});` });
  expect(await problems(missing)).toContain(`the agent.tool "poke" has replay "undefined"`);
});

test("config examples: what setup provides only when configured is generated; an invalid example is a problem naming the component", async () => {
  // A plain JSON Schema: the fixture imports nothing at runtime. Its tools are named in config.
  const index = (examples: string) =>
    `import type { ComponentDefinition } from "@pikit/core";\n\n` +
    `const component: ComponentDefinition = {\n  name: "tool-configured",\n` +
    `  config: { type: "object", properties: { tools: { type: "array", items: { type: "string", minLength: 1 } } }, examples: ${examples} },\n` +
    `  setup(pikit, config) {\n    for (const tool of (config as { tools?: string[] } | undefined)?.tools ?? []) pikit.provideKeyed("agent.tool", tool, { replay: "safe" });\n  },\n};\nexport default component;\n`;
  const f = await fixture({ name: "tool-configured", index: index(`[{ tools: ["look"] }]`) });
  // Provided with the example's config; not a tool the project has, so not in replay.tools.
  expect(f.manifest()).toMatchObject({ provides: ["agent.tool"] });
  expect(f.manifest().replay).toBeUndefined();
  expect(await problems(f)).toBe("");

  // An invalid example, in a registry of its own (a module is imported once per path).
  const root = mkdtempSync(join(tmpdir(), "pikit-registry-"));
  roots.push(root);
  const dir = join(root, "components", "tool-configured");
  cpSync(f.dir, dir, { recursive: true });
  writeFileSync(join(dir, "files", "src", "pikit", "tool-configured", "index.ts"), index(`[{ tools: ["look"] }, { tools: [""] }]`));
  const refused = "tool-configured: examples[1] of tool-configured's config schema is not a valid config: /tools/0:";
  expect((await generate(root)).problems.join("\n")).toContain(refused);
  expect((await validate(root)).problems.join("\n")).toContain("tool-configured: setup could not be described: examples[1] of tool-configured's config schema is not a valid config: /tools/0:");
});

test("the CLI exits 1 and names the problem, 0 when valid", async () => {
  const f = await fixture();
  const run = (root: string) =>
    Bun.spawnSync(["bun", join(REPO, "scripts", "registry.ts"), "validate", root], { cwd: REPO, stderr: "pipe", stdout: "pipe" });
  expect(run(f.root).exitCode).toBe(0);

  rmSync(join(f.dir, "README.md"));
  const failed = run(f.root);
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr.toString()).toContain("conversations-sample: README.md is missing");
});

test("scanImports: type-only, re-exports, side effects and dynamic imports; comments and strings ignored", () => {
  const source = [
    `// import a from "in-a-line-comment";`,
    `/* import b from "in-a-block-comment"; */`,
    `import type { C } from "type-only";`,
    `import { type D, e } from "mixed";`,
    `export * from "re-export";`,
    `import "side-effect";`,
    `const url = "https://example.com // not a comment";`,
    `const re = /"from "regex"/;`,
    `const lazy = await import("dynamic");`,
    `const legacy = require("common-js");`,
    `const store = capabilities.require("agent.conversations");`,
  ].join("\n");
  // A method named require (the capability registry's) is not an import.
  expect(scanImports(source)).toEqual(["type-only", "mixed", "re-export", "side-effect", "dynamic", "common-js"]);
});
