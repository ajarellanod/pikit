/**
 * The `http` preset is this sample's composition (ROADMAP M1): exactly the registry components
 * `pikit.config.ts` lists, plus `deployment-docker`, which runs it and is not in `pikit.config.ts`.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import definition from "../pikit.config.ts";

/** The preset's `components:` list. It is one name per line, so no YAML parser is needed. */
function preset(): string[] {
  const text = readFileSync(new URL("../../../registry/presets/http.yaml", import.meta.url), "utf8");
  return [...text.matchAll(/^\s+-\s+([a-z0-9-]+)\s*$/gm)].map(([, name]) => name ?? "");
}

/** Components this sample defines itself, which a project keeps in `src/extensions/`. */
const PROJECT_LOCAL = new Set(["agents"]);

test("the http preset lists exactly the sample's registry components, and deployment-docker", () => {
  const listed = preset();
  const sample = definition.components.map((component) => component.name).filter((name) => !PROJECT_LOCAL.has(name));

  expect([...listed].sort()).toEqual([...sample, "deployment-docker"].sort());
  expect(new Set(listed).size).toBe(listed.length);
});

test("every component of the preset is in the registry", () => {
  const missing = preset().filter((name) => !existsSync(new URL(`../../../registry/components/${name}/component.json`, import.meta.url)));

  expect(missing).toEqual([]);
});
