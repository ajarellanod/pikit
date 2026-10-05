import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { checkManifest, kitRangeProblems } from "./checks.ts";
import { checkSchemaFiles, generateCommand } from "./commands.ts";
import { COMPONENT_SCHEMA_FILE, ManifestSchema, readManifest, schemaProblems } from "./manifest.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const toolBash = () => readManifest(join(DEFAULT_REGISTRY, "components", "tool-bash")) as Record<string, unknown>;
/** A component whose shipped files import both the contracts and the adapter. */
const toolMcp = () => readManifest(join(DEFAULT_REGISTRY, "components", "tool-mcp")) as { requires: Record<string, unknown>; dependencies: Record<string, string> };

test("every component.json of the repository conforms to the schema and names it", () => {
  const manifest = toolBash();
  expect(schemaProblems(ManifestSchema, manifest)).toEqual([]);
  expect(manifest.$schema).toBe(`../../${COMPONENT_SCHEMA_FILE}`);
});

test("an unknown field is one problem that names it; a malformed manifest stops at its shape", () => {
  expect(schemaProblems(ManifestSchema, { ...toolBash(), dependancies: {} })).toEqual(["/dependancies: is not a known field"]);
  // The directory does not match either, but on a malformed manifest only the shape is reported.
  const problems = checkManifest({ ...toolBash(), targets: [] }, "/nowhere", "other-name", "0.0.0", "0.0.0", "0.0.0");
  expect(problems).toEqual(["component.json /targets: must not have fewer than 1 items"]);
});

test("validate knows when the registry's JSON Schemas are missing or stale", () => {
  const root = mkdtempSync(join(tmpdir(), "pikit-schema-test-"));
  dirs.push(root);
  cpSync(join(DEFAULT_REGISTRY, "schema"), join(root, "schema"), { recursive: true });
  expect(checkSchemaFiles(root)).toEqual([]);
  const file = join(root, COMPONENT_SCHEMA_FILE);
  writeFileSync(file, readFileSync(file, "utf8").replace('"pikit component.json"', '"edited by hand"'));
  // Not this repository's registry: the command is the CLI's, with the registry's path.
  expect(checkSchemaFiles(root)).toEqual([`${COMPONENT_SCHEMA_FILE} is missing or out of date: run \`pikit registry generate ${relative(process.cwd(), root)}\``]);
  rmSync(join(root, "schema"), { recursive: true });
  expect(checkSchemaFiles(root)).toHaveLength(2);
});

test("what validate says to run: this repository's script for its registry, the CLI with the path for a project's", () => {
  expect(generateCommand(DEFAULT_REGISTRY)).toBe("bun run registry generate");
  expect(generateCommand(join(process.cwd(), "registry", "..", "my-project", "registry"))).toBe(`pikit registry generate ${join("my-project", "registry")}`);
  expect(generateCommand(process.cwd())).toBe("pikit registry generate .");
});

test("requires.contracts must accept this repository's @pikit/contracts, and a component that depends on them says which", () => {
  const manifest = toolMcp();
  const dir = join(DEFAULT_REGISTRY, "components", "tool-mcp");
  expect(manifest.dependencies["@pikit/contracts"]).toBeDefined();
  expect(checkManifest(manifest, dir, "tool-mcp", "0.0.0", "0.0.0", "0.0.0")).toEqual([]);
  expect(checkManifest(manifest, dir, "tool-mcp", "0.0.0", "0.1.0", "0.0.0")).toEqual([
    `requires.contracts "${String(manifest.requires.contracts)}" does not accept this repository's @pikit/contracts 0.1.0`,
  ]);
  const { contracts: _, ...requires } = manifest.requires;
  expect(checkManifest({ ...manifest, requires }, dir, "tool-mcp", "0.0.0", "0.0.0", "0.0.0")).toEqual([
    "dependencies lists @pikit/contracts, but requires.contracts does not say which versions it works with (a semver range, as requires.pikit)",
  ]);
  // Only its tests import it (devDependencies): no range is needed; one stated is still checked.
  const { "@pikit/contracts": contracts, ...dependencies } = manifest.dependencies;
  const forTests = { ...manifest, requires, dependencies, devDependencies: { "@pikit/contracts": contracts } };
  expect(checkManifest(forTests, dir, "tool-mcp", "0.0.0", "0.0.0", "0.0.0")).toEqual([]);
  expect(checkManifest({ ...forTests, requires: { ...requires, contracts: "0.0.0" } }, dir, "tool-mcp", "0.0.0", "0.1.0", "0.0.0")).toEqual([
    `requires.contracts "0.0.0" does not accept this repository's @pikit/contracts 0.1.0`,
  ]);
});

test("requires.adapter must accept this repository's @pikit/pi-adapter, and a component that depends on it states a meaningful range", () => {
  const manifest = toolMcp();
  const dir = join(DEFAULT_REGISTRY, "components", "tool-mcp");
  expect(manifest.dependencies["@pikit/pi-adapter"]).toBeDefined();
  expect(checkManifest(manifest, dir, "tool-mcp", "0.0.0", "0.0.0", "0.1.0")).toEqual([
    `requires.adapter "${String(manifest.requires.adapter)}" does not accept this repository's @pikit/pi-adapter 0.1.0`,
  ]);
  const { adapter: _, ...requires } = manifest.requires;
  expect(checkManifest({ ...manifest, requires }, dir, "tool-mcp", "0.0.0", "0.0.0", "0.0.0")).toEqual([
    "dependencies lists @pikit/pi-adapter, but requires.adapter does not say which versions it works with (a semver range, as requires.pikit)",
  ]);
  // A wildcard says nothing either.
  expect(checkManifest({ ...manifest, requires: { ...requires, adapter: "*" } }, dir, "tool-mcp", "0.0.0", "0.0.0", "0.0.0")).toEqual([
    'dependencies lists @pikit/pi-adapter, but requires.adapter ("*") does not say which versions it works with (a semver range, as requires.pikit)',
  ]);
});

test("every component of the repository that depends on the contracts or the adapter states their range", () => {
  for (const name of readdirSync(join(DEFAULT_REGISTRY, "components"))) {
    const manifest = readManifest(join(DEFAULT_REGISTRY, "components", name));
    if (manifest === undefined) continue;
    expect([name, kitRangeProblems(manifest, { "@pikit/core": "0.0.0", "@pikit/contracts": "0.0.0", "@pikit/pi-adapter": "0.0.0" }).missing]).toEqual([name, []]);
  }
});

test("a files target that leaves the project, or is one of its own records, is a problem", () => {
  const manifest = toolBash();
  const files = [...(manifest.files as unknown[]), { source: "README.md", target: "package.json" }, { source: "README.md", target: "../outside" }];
  const problems = checkManifest({ ...manifest, files }, join(DEFAULT_REGISTRY, "components", "tool-bash"), "tool-bash", "0.0.0", "0.0.0", "0.0.0");
  expect(problems).toEqual([
    'files target "package.json" is one of the project\'s own files; no component writes it',
    'files target "../outside" leaves the project',
  ]);
});
