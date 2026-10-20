import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { checkManifest, kitRangeProblems } from "./checks.ts";
import { checkSchemaFiles, generateCommand } from "./commands.ts";
import { COMPONENT_SCHEMA_FILE, deploymentProblems, type Manifest, ManifestSchema, readManifest, schemaProblems, withGenerated } from "./manifest.ts";

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
  const problems = checkManifest({ ...toolBash(), targets: [] }, "/nowhere", "other-name", "0.0.1", "0.0.1", "0.0.1");
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
  expect(checkManifest(manifest, dir, "tool-mcp", "0.0.1", "0.0.1", "0.0.1")).toEqual([]);
  expect(checkManifest(manifest, dir, "tool-mcp", "0.0.1", "0.1.0", "0.0.1")).toEqual([
    `requires.contracts "${String(manifest.requires.contracts)}" does not accept this repository's @pikit/contracts 0.1.0`,
  ]);
  const { contracts: _, ...requires } = manifest.requires;
  expect(checkManifest({ ...manifest, requires }, dir, "tool-mcp", "0.0.1", "0.0.1", "0.0.1")).toEqual([
    "dependencies lists @pikit/contracts, but requires.contracts does not say which versions it works with (a semver range, as requires.pikit)",
  ]);
  // Only its tests import it (devDependencies): no range is needed; one stated is still checked.
  const { "@pikit/contracts": contracts, ...dependencies } = manifest.dependencies;
  const forTests = { ...manifest, requires, dependencies, devDependencies: { "@pikit/contracts": contracts } };
  expect(checkManifest(forTests, dir, "tool-mcp", "0.0.1", "0.0.1", "0.0.1")).toEqual([]);
  expect(checkManifest({ ...forTests, requires: { ...requires, contracts: "0.0.1" } }, dir, "tool-mcp", "0.0.1", "0.1.0", "0.0.1")).toEqual([
    `requires.contracts "0.0.1" does not accept this repository's @pikit/contracts 0.1.0`,
  ]);
});

test("requires.adapter must accept this repository's @pikit/pi-adapter, and a component that depends on it states a meaningful range", () => {
  const manifest = toolMcp();
  const dir = join(DEFAULT_REGISTRY, "components", "tool-mcp");
  expect(manifest.dependencies["@pikit/pi-adapter"]).toBeDefined();
  expect(checkManifest(manifest, dir, "tool-mcp", "0.0.1", "0.0.1", "0.1.0")).toEqual([
    `requires.adapter "${String(manifest.requires.adapter)}" does not accept this repository's @pikit/pi-adapter 0.1.0`,
  ]);
  const { adapter: _, ...requires } = manifest.requires;
  expect(checkManifest({ ...manifest, requires }, dir, "tool-mcp", "0.0.1", "0.0.1", "0.0.1")).toEqual([
    "dependencies lists @pikit/pi-adapter, but requires.adapter does not say which versions it works with (a semver range, as requires.pikit)",
  ]);
  // A wildcard says nothing either.
  expect(checkManifest({ ...manifest, requires: { ...requires, adapter: "*" } }, dir, "tool-mcp", "0.0.1", "0.0.1", "0.0.1")).toEqual([
    'dependencies lists @pikit/pi-adapter, but requires.adapter ("*") does not say which versions it works with (a semver range, as requires.pikit)',
  ]);
});

test("every component of the repository that depends on the contracts or the adapter states their range", () => {
  for (const name of readdirSync(join(DEFAULT_REGISTRY, "components"))) {
    const manifest = readManifest(join(DEFAULT_REGISTRY, "components", name));
    if (manifest === undefined) continue;
    expect([name, kitRangeProblems(manifest, { "@pikit/core": "0.0.1", "@pikit/contracts": "0.0.1", "@pikit/pi-adapter": "0.0.1" }).missing]).toEqual([name, []]);
  }
});

/** The deployment fields of a component named `name`, as `deploymentProblems` reads them. */
const facts = (name: string, fields: Partial<Pick<Manifest, "deployment" | "compose">> & { needs?: string[] } = {}) => {
  const { needs, ...rest } = fields;
  return { name, requires: { pikit: "0.0.1", capabilities: [], ...(needs !== undefined && { deployment: needs }) }, ...rest };
};

test("deploymentProblems: only a deployment says what it supports, and needs nothing of one; services.compose is implied, never written", () => {
  // Clean: a deployment that supports, a consumer that needs, a compose file, a component with none of it.
  expect(deploymentProblems(facts("deployment-acme", { deployment: { supports: ["services.compose", "acme.review-host"] } }))).toEqual([]);
  expect(deploymentProblems(facts("deployment-bare", { deployment: { supports: [] } }))).toEqual([]);
  expect(deploymentProblems(facts("deployment-bare"))).toEqual([]);
  expect(deploymentProblems(facts("proposals-acme", { needs: ["proposals.deployer"], compose: "compose.yaml" }))).toEqual([]);
  expect(deploymentProblems(facts("tool-bash"))).toEqual([]);

  expect(deploymentProblems(facts("proposals-acme", { deployment: { supports: ["proposals.deployer"] } }))).toEqual([
    '"deployment" says what a deployment supports: only a deployment-* component has it',
  ]);
  // By kind, not by name: a name that merely contains "deployment" is not one.
  expect(deploymentProblems(facts("tool-deployment", { deployment: { supports: [] } }))).toHaveLength(1);
  expect(deploymentProblems(facts("deployment-acme", { needs: ["acme.review-host"] }))).toEqual([
    '"requires.deployment" is what a component needs of its deployment: a deployment-* component needs nothing of one',
  ]);
  expect(deploymentProblems(facts("deployment-acme", { compose: "compose.yaml" }))).toEqual([
    '"compose" is a service beside the app that its deployment runs: a deployment-* component ships its own instead',
  ]);
  expect(deploymentProblems(facts("expose-acme", { needs: ["services.compose"], compose: "compose.yaml" }))).toEqual([
    '"requires.deployment" lists "services.compose", which a "compose" file implies: name the Compose file in "compose" instead',
  ]);
  // Every problem at once.
  expect(deploymentProblems(facts("deployment-acme", { needs: ["services.compose"], compose: "c.yaml", deployment: { supports: [] } }))).toHaveLength(3);
});

test("the schema checks the deployment fields' shape: requirement names, no duplicates, no unknown field; extensions is a field", () => {
  const base = toolBash();
  const requires = base.requires as Record<string, unknown>;
  expect(schemaProblems(ManifestSchema, { ...base, requires: { ...requires, deployment: ["proposals.deployer", "acme.review-host"] } })).toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, deployment: { supports: ["services.compose", "acme.review-host"] } })).toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, deployment: { supports: [] } })).toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, extensions: ["pikit-self"] })).toEqual([]);

  for (const bad of ["Proposals.Deployer", "proposals..deployer", "proposals.", ".deployer", "1st.thing", "proposals deployer", "deployment-docker/x", ""]) {
    expect([bad, schemaProblems(ManifestSchema, { ...base, requires: { ...requires, deployment: [bad] } }).length > 0]).toEqual([bad, true]);
    expect([bad, schemaProblems(ManifestSchema, { ...base, deployment: { supports: [bad] } }).length > 0]).toEqual([bad, true]);
  }
  expect(schemaProblems(ManifestSchema, { ...base, requires: { ...requires, deployment: [] } })).not.toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, requires: { ...requires, deployment: ["a.b", "a.b"] } })).not.toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, deployment: { supports: ["a.b", "a.b"] } })).not.toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, deployment: { supports: ["a.b"], provides: ["x"] } })).toEqual(["/deployment/provides: is not a known field"]);
  expect(schemaProblems(ManifestSchema, { ...base, deployment: {} })).not.toEqual([]);
  expect(schemaProblems(ManifestSchema, { ...base, extensions: [1] })).not.toEqual([]);
});

test("generate writes extensions as it writes modelProviders, and takes it out when setup provides none", () => {
  const manifest = toolBash() as unknown as Manifest;
  const generated = { provides: manifest.provides, requires: manifest.requires.capabilities, optional: manifest.optional.capabilities };
  expect(withGenerated(manifest, { ...generated, extensions: ["pikit-self"] }).extensions).toEqual(["pikit-self"]);
  expect("extensions" in withGenerated({ ...manifest, extensions: ["stale"] }, generated)).toBe(false);
});

test("a files target that leaves the project, or is one of its own records, is a problem", () => {
  const manifest = toolBash();
  const files = [...(manifest.files as unknown[]), { source: "README.md", target: "package.json" }, { source: "README.md", target: "../outside" }];
  const problems = checkManifest({ ...manifest, files }, join(DEFAULT_REGISTRY, "components", "tool-bash"), "tool-bash", "0.0.1", "0.0.1", "0.0.1");
  expect(problems).toEqual([
    'files target "package.json" is one of the project\'s own files; no component writes it',
    'files target "../outside" leaves the project',
  ]);
});
