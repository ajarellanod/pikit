import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { checkManifest } from "./checks.ts";
import { checkSchemaFiles } from "./commands.ts";
import { COMPONENT_SCHEMA_FILE, ManifestSchema, readManifest, schemaProblems } from "./manifest.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const toolBash = () => readManifest(join(DEFAULT_REGISTRY, "components", "tool-bash")) as Record<string, unknown>;

test("every component.json of the repository conforms to the schema and names it", () => {
  const manifest = toolBash();
  expect(schemaProblems(ManifestSchema, manifest)).toEqual([]);
  expect(manifest.$schema).toBe(`../../${COMPONENT_SCHEMA_FILE}`);
});

test("an unknown field is one problem that names it; a malformed manifest stops at its shape", () => {
  expect(schemaProblems(ManifestSchema, { ...toolBash(), dependancies: {} })).toEqual(["/dependancies: is not a known field"]);
  // The directory does not match either, but on a malformed manifest only the shape is reported.
  const problems = checkManifest({ ...toolBash(), targets: [] }, "/nowhere", "other-name", "0.0.0");
  expect(problems).toEqual(["component.json /targets: must not have fewer than 1 items"]);
});

test("validate knows when the registry's JSON Schemas are missing or stale", () => {
  const root = mkdtempSync(join(tmpdir(), "pikit-schema-test-"));
  dirs.push(root);
  cpSync(join(DEFAULT_REGISTRY, "schema"), join(root, "schema"), { recursive: true });
  expect(checkSchemaFiles(root)).toEqual([]);
  const file = join(root, COMPONENT_SCHEMA_FILE);
  writeFileSync(file, readFileSync(file, "utf8").replace('"pikit component.json"', '"edited by hand"'));
  expect(checkSchemaFiles(root)).toEqual([`${COMPONENT_SCHEMA_FILE} is missing or out of date: run \`bun run registry generate\``]);
  rmSync(join(root, "schema"), { recursive: true });
  expect(checkSchemaFiles(root)).toHaveLength(2);
});
