/**
 * Presets (SPEC §11): a base lists components and may `choose` one per kind; an alias `extends` a
 * base and answers with `with`, exactly as `--with` does. Built on throwaway registries, plus the
 * repository's own, which must keep resolving.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { Manifest } from "../registry/manifest.ts";
import { checkPresets } from "../registry/commands.ts";
import { openRegistry } from "./registry-source.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A registry with these components (name → title, or no title; or name → fields that differ from a
 * valid server component) and these presets (name → YAML).
 */
function registry(components: Record<string, string | Partial<Manifest> | undefined>, presets: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pikit-registry-test-"));
  dirs.push(root);
  const index: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(components)) {
    mkdirSync(join(root, "components", name), { recursive: true });
    const fields = typeof spec === "string" ? { title: spec } : (spec ?? {});
    const manifest: Manifest = {
      name,
      version: "0.0.0",
      description: name,
      targets: ["server"],
      requires: { pikit: "0.0.0", capabilities: [] },
      optional: { capabilities: [] },
      provides: [],
      dependencies: {},
      files: [{ source: "files/src", target: "src" }],
      ...fields,
    };
    writeFileSync(join(root, "components", name, "component.json"), JSON.stringify(manifest));
    index[name] = { version: "0.0.0", description: name, targets: manifest.targets, path: `components/${name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
  mkdirSync(join(root, "presets"));
  for (const [name, yaml] of Object.entries(presets)) writeFileSync(join(root, "presets", `${name}.yaml`), yaml);
  return root;
}

const COMPONENTS = { "secrets-env": undefined, "channel-a": "A: the first", "channel-b": "B: the second", "server-bun": undefined };
const BASE = "components: [secrets-env, channel-a, server-bun]\nchoose:\n  - kind: channel\n    question: Where?\n";

test("a choice replaces the preset's component of its kind, in place; an alias is the same choice", () => {
  const r = openRegistry(registry(COMPONENTS, { base: BASE, b: "title: B\nextends: base\nwith: [channel-b]\n" }));
  expect(r.preset("base")).toEqual(["secrets-env", "channel-a", "server-bun"]);
  expect(r.preset("base", ["channel-b"])).toEqual(["secrets-env", "channel-b", "server-bun"]);
  expect(r.preset("b")).toEqual(r.preset("base", ["channel-b"]));
  // --with on an alias answers again: the command line wins over the alias.
  expect(r.preset("b", ["channel-a"])).toEqual(r.preset("base"));
  expect(r.presets()).toEqual([{ name: "b", title: "B", extends: "base" }, { name: "base", title: "base" }]);
});

test("slots offer every component of the kind, by title, with the preset's own answer as default", () => {
  const r = openRegistry(registry(COMPONENTS, { base: BASE, b: "extends: base\nwith: [channel-b]\n" }));
  const options = [{ name: "channel-a", title: "A: the first" }, { name: "channel-b", title: "B: the second" }];
  expect(r.slots("base")).toEqual([{ kind: "channel", question: "Where?", default: "channel-a", options }]);
  expect(r.slots("b")[0]?.default).toBe("channel-b");
});

test("choices the preset does not ask for are refused, with what to do instead", () => {
  const r = openRegistry(registry(COMPONENTS, { base: BASE }));
  expect(() => r.preset("base", ["server-bun"])).toThrow('the preset "base" has no choice of server-* components; add server-bun after');
  expect(() => r.preset("base", ["channel-z"])).toThrow('has no component "channel-z"');
  expect(() => r.preset("base", ["channel-a", "channel-b"])).toThrow("--with names two channel-* components");
});

test("malformed presets are refused when read", () => {
  const cases: Record<string, string> = {
    "two components of the chosen kind": "components: [channel-a, channel-b]\nchoose:\n  - kind: channel\n",
    "none of the chosen kind": "components: [secrets-env]\nchoose:\n  - kind: channel\n",
    "a kind chosen twice": "components: [channel-a]\nchoose:\n  - kind: channel\n  - kind: channel\n",
    "an alias with components": "extends: base\nwith: [channel-b]\ncomponents: [secrets-env]\n",
    "an alias that chooses nothing": "extends: base\n",
    "with but no extends": "components: [channel-a]\nwith: [channel-b]\n",
  };
  for (const [what, yaml] of Object.entries(cases)) {
    const r = openRegistry(registry(COMPONENTS, { base: BASE, bad: yaml }));
    expect(() => r.preset("bad"), what).toThrow();
  }
  const chained = openRegistry(registry(COMPONENTS, { base: BASE, b: "extends: base\nwith: [channel-b]\n", c: "extends: b\nwith: [channel-a]\n" }));
  expect(() => chained.preset("c")).toThrow("which is an alias itself");
});

test("slots with targets offer only the components that run on them", () => {
  const r = openRegistry(registry({ ...COMPONENTS, "channel-edge": { title: "Edge: on Workers", targets: ["cloudflare"] } }, { base: BASE }));
  expect(r.slots("base")[0]?.options.map((o) => o.name)).toEqual(["channel-a", "channel-b", "channel-edge"]);
  expect(r.slots("base", ["server"])[0]?.options.map((o) => o.name)).toEqual(["channel-a", "channel-b"]);
});

test("a preset's shape is its schema: an unknown key is an error, not silence", () => {
  const r = openRegistry(registry(COMPONENTS, { base: BASE, typo: "components: [channel-a]\nchose:\n  - kind: channel\n" }));
  expect(() => r.preset("typo")).toThrow("presets/typo.yaml (a base preset): /chose: is not a known field");
  const alias = openRegistry(registry(COMPONENTS, { base: BASE, a: "extends: base\nwith: []\n" }));
  expect(() => alias.preset("a")).toThrow("presets/a.yaml (an alias preset): /with: must not have fewer than 1 items");
});

test("a component whose component.json breaks the schema is refused before anything is installed", () => {
  const r = openRegistry(registry({ ...COMPONENTS, "channel-bad": { targets: ["mars"] } }, { base: BASE }));
  expect(() => r.manifest("channel-bad")).toThrow('the registry\'s component "channel-bad" has an invalid component.json: /targets/0:');
});

test("registry validate reports unknown components, duplicates and answers with no title", () => {
  const root = registry(
    { ...COMPONENTS, "channel-c": undefined },
    { base: BASE, twice: "components: [secrets-env, secrets-env]\n", ghost: "components: [nope-x]\n" },
  );
  const problems = checkPresets(root);
  expect(problems).toContain('presets/base.yaml: channel-c answers "Where?" but its component.json has no title to show');
  expect(problems).toContain("presets/twice.yaml: lists a component twice");
  expect(problems.some((p) => p.startsWith('presets/ghost.yaml: the registry') && p.includes('no component "nope-x"'))).toBe(true);
});

test("the repository's presets resolve: telegram is http with channel-telegram", () => {
  expect(checkPresets(DEFAULT_REGISTRY)).toEqual([]);
  const r = openRegistry(DEFAULT_REGISTRY);
  expect(r.preset("telegram")).toEqual(r.preset("http", ["channel-telegram"]));
  expect(r.slots("http")[0]?.options.map((o) => o.name)).toEqual(["channel-http", "channel-telegram"]);
});
