/**
 * `registry generate` / `validate`: the real registry is green, and every check fails on a small
 * fixture that breaks exactly its rule. Fixtures live in temp directories and import nothing at
 * runtime (type-only imports are erased), so they load without the repository's node_modules.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    pikit.use("sessions.store");
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
    requires: { capabilities: ["sessions.store"] },
    optional: { capabilities: ["model.credentials", "agent.tool"] },
    provides: ["conversations.registry"],
  });

  const edited = { ...f.manifest(), license: "MIT", provides: ["stale"], custom: { kept: true } };
  f.writeManifest(edited);
  await generate(f.root);
  expect(f.manifest()).toEqual({ ...edited, provides: ["conversations.registry"] });

  const once = readFileSync(join(f.dir, "component.json"), "utf8");
  await generate(f.root);
  expect(readFileSync(join(f.dir, "component.json"), "utf8")).toBe(once);
  expect(Object.keys(f.manifest())).toEqual([
    "$schema", "name", "version", "description", "license", "targets", "requires", "optional", "provides", "dependencies", "files", "custom",
  ]);
  // Kept, so nothing written by hand is lost; refused, so a typo is not silence.
  expect(await problems(f)).toContain("component.json /custom: is not a known field");
});

test("a new component's skeleton is rejected until its targets are written by hand", async () => {
  const f = await fixture({ fill: false });
  expect(f.manifest().description).toBe("A fixture component.");
  expect(await problems(f)).toContain("component.json /targets: must not have fewer than 1 items");
});

test("drift: generated fields that differ from setup (S14)", async () => {
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

test("layout: tests ship in src/pikit/<name>/, a README exists, no install scripts (S13)", async () => {
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

test("imports: no sibling component's files (S4)", async () => {
  const f = await fixture();
  f.append("index.ts", `import type { X } from "../router-basic/index.ts";`);
  expect(await problems(f)).toContain(`imports "../router-basic/index.ts", a file of the component "router-basic"`);
});

test("imports: only the adapter imports Pi (S1)", async () => {
  const f = await fixture();
  // Spelled apart so the repository's own import scan (AGENTS.md) does not flag this test.
  const pi = ["@earendil-works", "pi-ai"].join("/");
  f.append("index.ts", `import type { Model } from "${pi}";`);
  expect(await problems(f)).toContain(`imports "@earendil-works/pi-ai": only @pikit/pi-adapter imports Pi (S1)`);
});

test("imports: node:* only when targets are exactly [\"server\"]; tests are exempt (S5)", async () => {
  const f = await fixture();
  f.append("index.ts", `import "node:path";`);
  f.append("sample.test.ts", `import "node:fs";`);
  expect((await validate(f.root)).problems).toEqual([]);

  f.writeManifest({ ...f.manifest(), targets: ["server", "cloudflare"] });
  await generate(f.root);
  const found = await problems(f);
  expect(found).toContain(`index.ts imports "node:path", but targets are ["server","cloudflare"]`);
  expect(found).not.toContain("node:fs");
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

test("manifest: no requires.components (SPEC §10.2)", async () => {
  const f = await fixture();
  f.writeManifest({ ...f.manifest(), requires: { ...f.manifest().requires, components: ["router-basic"] } as Manifest["requires"] });
  expect(await problems(f)).toContain("component.json /requires/components: is not a known field: components depend on capabilities only");
});

test("files: only files/src maps as a directory; a file outside src is listed on its own (SPEC §10.2)", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "files", "Dockerfile"), "FROM scratch\n");

  f.writeManifest({ ...f.manifest(), files: [{ source: "files", target: "." }] });
  expect(await problems(f)).toContain('files maps the directory "files" onto "."');

  f.writeManifest({ ...f.manifest(), files: [{ source: "files/src", target: "src" }, { source: "files/Dockerfile", target: "Dockerfile" }] });
  expect(await problems(f)).toBe("");
});

test("a component with no default export is not an app component: it provides and uses nothing", async () => {
  // Module imports are cached per path, so the file is written before the first generate.
  const f = await fixture({ name: "deployment-sample", index: 'export const run = () => "runs the app instead of running inside it";\n' });

  expect(f.manifest()).toMatchObject({ provides: [], requires: { capabilities: [] }, optional: { capabilities: [] } });
  expect(await problems(f)).toBe("");
});

test("tools: replay is generated, and a tool without one fails (S10)", async () => {
  const safe = await fixture({ name: "tool-safe", setup: `\n    pikit.provideKeyed("agent.tool", "look", { replay: "safe" });` });
  expect(safe.manifest().replay).toEqual({ tools: { look: "safe" } });
  expect((await validate(safe.root)).problems).toEqual([]);

  const missing = await fixture({ name: "tool-vague", setup: `\n    pikit.provideKeyed("agent.tool", "poke", {});` });
  expect(await problems(missing)).toContain(`the agent.tool "poke" has replay "undefined"`);
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
    `const store = capabilities.require("sessions.store");`,
  ].join("\n");
  // A method named require (the capability registry's) is not an import.
  expect(scanImports(source)).toEqual(["type-only", "mixed", "re-export", "side-effect", "dynamic", "common-js"]);
});
