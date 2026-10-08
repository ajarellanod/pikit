/**
 * The `http` preset is this sample's composition: exactly the registry components
 * `pikit.config.ts` lists, plus `deployment-docker`, which runs it and is not in `pikit.config.ts`,
 * less the provider `runtime-pi` brings itself (offered providers), which `pikit new`
 * installs with it. The storage is the preset's own: it names it rather than rely on the registry
 * having one server provider of `storage.sql`. A chat channel chosen instead of `channel-http`
 * brings its durable delivery the same way. One swap: the preset's conversation registry is the
 * neutral one, `conversations-kv` over `storage-kv-sql` (SPEC C5), where this sample keeps
 * `conversations-file`, the registry's other provider, so that both run end to end.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import definition from "../pikit.config.ts";

/**
 * The preset's `components:` list, not its `features:` (opt-in, asked by `pikit new`). One name per
 * line, so no YAML parser is needed.
 */
function preset(): string[] {
  const text = readFileSync(new URL("../../../registry/presets/http.yaml", import.meta.url), "utf8");
  const components = /^components:\n((?:(?:\s+-\s+[a-z0-9-]+|\s*#.*|\s*)\n)*)/m.exec(text)?.[1] ?? "";
  return [...components.matchAll(/^\s+-\s+([a-z0-9-]+)\s*$/gm)].map(([, name]) => name ?? "");
}

/** Components this sample defines itself, which a project keeps in `src/extensions/`. */
const PROJECT_LOCAL = new Set(["agents"]);
/** The sample's conversation registry, and the preset's in its place. */
const SAMPLE_REGISTRY = "conversations-file";
const PRESET_REGISTRY = ["storage-kv-sql", "conversations-kv"];

test("the http preset lists exactly the sample's registry components, and deployment-docker, with the neutral conversation registry", () => {
  const listed = preset();
  const sample = definition.components.map((component) => component.name).filter((name) => !PROJECT_LOCAL.has(name));

  expect(sample).toContain(SAMPLE_REGISTRY);
  expect(listed).not.toContain(SAMPLE_REGISTRY);
  const swapped = [...sample.filter((name) => name !== SAMPLE_REGISTRY), ...PRESET_REGISTRY, "deployment-docker"];
  expect([...listed].sort()).toEqual(swapped.sort());
  expect(new Set(listed).size).toBe(listed.length);
});

test("every component of the preset is in the registry", () => {
  const missing = preset().filter((name) => !existsSync(new URL(`../../../registry/components/${name}/component.json`, import.meta.url)));

  expect(missing).toEqual([]);
});
