/**
 * The `http` preset is this sample's composition (ROADMAP M1): every registry component
 * `pikit.config.ts` lists is in `registry/presets/http.yaml`, with `deployment-docker`, which runs it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import definition from "../pikit.config.ts";

/** The preset's `components:` list. It is one name per line, so no YAML parser is needed. */
function preset(): string[] {
  const text = readFileSync(new URL("../../../registry/presets/http.yaml", import.meta.url), "utf8");
  return [...text.matchAll(/^\s+-\s+([a-z0-9-]+)\s*$/gm)].map(([, name]) => name ?? "");
}

/** Components this sample defines itself, which a project keeps in `src/extensions/`. */
const PROJECT_LOCAL = new Set(["agents"]);

test("the http preset lists every registry component of the sample, and deployment-docker", () => {
  const listed = preset();
  const sample = definition.components.map((component) => component.name).filter((name) => !PROJECT_LOCAL.has(name));

  expect(sample.filter((name) => !listed.includes(name))).toEqual([]);
  expect(listed).toContain("deployment-docker");
  expect(new Set(listed).size).toBe(listed.length);
});
