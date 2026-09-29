/**
 * The `http` preset is this sample's composition: exactly the registry components
 * `pikit.config.ts` lists, plus `deployment-docker`, which runs it and is not in `pikit.config.ts`,
 * less the providers `runtime-pi` brings itself (offered providers), which `pikit new`
 * installs with it. A chat channel chosen instead of `channel-http` brings its durable delivery the
 * same way.
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
/** What `runtime-pi` brings: `agent.submissions` and the storage it requires. */
const OFFERED = new Set(["storage-sqlite", "submissions-sql"]);

test("the http preset lists exactly the sample's registry components, and deployment-docker", () => {
  const listed = preset();
  const sample = definition.components.map((component) => component.name).filter((name) => !PROJECT_LOCAL.has(name) && !OFFERED.has(name));

  expect([...listed].sort()).toEqual([...sample, "deployment-docker"].sort());
  expect(new Set(listed).size).toBe(listed.length);
});

test("every component of the preset is in the registry", () => {
  const missing = preset().filter((name) => !existsSync(new URL(`../../../registry/components/${name}/component.json`, import.meta.url)));

  expect(missing).toEqual([]);
});
