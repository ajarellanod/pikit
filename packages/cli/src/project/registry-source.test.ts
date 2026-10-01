/**
 * Presets: a base lists components and may `choose` one per kind; an alias `extends` a
 * base and answers with `with`, exactly as `--with` does. Built on throwaway registries, plus the
 * repository's own, which must keep resolving.
 */

import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { Manifest } from "../registry/manifest.ts";
import { checkPresets } from "../registry/commands.ts";
import { isProtected, openRegistry } from "./registry-source.ts";

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
  const root = registry({ ...COMPONENTS, "channel-bad": undefined }, { base: BASE });
  const file = join(root, "components", "channel-bad", "component.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), targets: ["mars"] }));
  const r = openRegistry(root);
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

test("registry validate reports a preset that does not compose on its target, and each answer that does not", () => {
  const requires = (capabilities: string[]) => ({ requires: { pikit: "0.0.0", capabilities } });
  const root = registry(
    {
      "secrets-env": { provides: ["secrets"] },
      "secrets-file": { provides: ["secrets"] },
      "channel-a": { title: "A", ...requires(["secrets"]) },
      // Nothing provides storage.sql: an answer that cannot compose.
      "channel-b": { title: "B", ...requires(["storage.sql"]) },
      // Runs only on Cloudflare: not an answer on a server, so not checked there.
      "channel-edge": { title: "Edge", targets: ["cloudflare"], ...requires(["storage.sql"]) },
      "server-bun": undefined,
    },
    {
      base: "components: [secrets-env, channel-a, server-bun]\nchoose:\n  - kind: channel\n",
      twice: "components: [secrets-env, secrets-file, server-bun]\n",
      lonely: "components: [channel-a]\n",
      nowhere: "components: [secrets-env, channel-edge]\n",
    },
  );
  expect(checkPresets(root).sort()).toEqual([
    'presets/base.yaml: with channel-b, on server, channel-b requires "storage.sql", which nothing provides',
    'presets/lonely.yaml: on server, channel-a requires "secrets", which nothing provides',
    "presets/nowhere.yaml: no target runs all its components (not on server: channel-edge; not on cloudflare: secrets-env)",
    'presets/twice.yaml: on server, "secrets" takes one provider, and secrets-env and secrets-file each provide it',
  ]);
});

/** The repository's registry, component.json files only, plus `extra` components: enough to check presets. */
function repositoryWith(extra: Manifest[]): string {
  const root = mkdtempSync(join(tmpdir(), "pikit-registry-test-"));
  dirs.push(root);
  const index = JSON.parse(readFileSync(join(DEFAULT_REGISTRY, "registry.json"), "utf8"));
  for (const name of Object.keys(index.components)) {
    mkdirSync(join(root, "components", name), { recursive: true });
    copyFileSync(join(DEFAULT_REGISTRY, "components", name, "component.json"), join(root, "components", name, "component.json"));
  }
  for (const manifest of extra) {
    mkdirSync(join(root, "components", manifest.name), { recursive: true });
    writeFileSync(join(root, "components", manifest.name, "component.json"), JSON.stringify(manifest));
    index.components[manifest.name] = { version: manifest.version, description: manifest.description, targets: manifest.targets, path: `components/${manifest.name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify(index));
  mkdirSync(join(root, "presets"));
  for (const file of readdirSync(join(DEFAULT_REGISTRY, "presets"))) copyFileSync(join(DEFAULT_REGISTRY, "presets", file), join(root, "presets", file));
  return root;
}

test("a second server provider of storage.sql leaves the repository's presets composing: they name their storage", () => {
  const sqlite = openRegistry(DEFAULT_REGISTRY).manifest("storage-sqlite");
  const root = repositoryWith([{ ...sqlite, name: "storage-postgres", description: "A second server storage.sql." }]);
  expect(checkPresets(root)).toEqual([]);
  // A preset that left its storage to the offer: with two providers nothing is offered, and it says so.
  const http = readFileSync(join(root, "presets", "http.yaml"), "utf8");
  writeFileSync(join(root, "presets", "leaning.yaml"), http.replace(/^\s+- storage-sqlite\n/m, ""));
  expect(checkPresets(root)).toContain('presets/leaning.yaml: on server, submissions-sql requires "storage.sql", which nothing provides');
});

test("a second Cloudflare provider of storage.kv leaves cloudflare-minimal composing: it names its storage", () => {
  const kv = openRegistry(DEFAULT_REGISTRY).manifest("storage-kv-sql");
  const root = repositoryWith([{ ...kv, name: "storage-kv-other", description: "A second storage.kv." }]);
  expect(checkPresets(root)).toEqual([]);
});

test("registry validate reports a preset whose starter model's provider it does not install, unless the preset names its model", () => {
  const root = repositoryWith([]);
  const http = readFileSync(join(root, "presets", "http.yaml"), "utf8");
  const openrouter = http.replace(/^\s+- provider-anthropic\n/m, "  - provider-openrouter\n");
  writeFileSync(join(root, "presets", "other-provider.yaml"), openrouter);
  expect(checkPresets(root)).toContain(
    `presets/other-provider.yaml: on server, the starter agent's model "anthropic/claude-sonnet-4-6" needs the model provider "anthropic", which no component of the preset "other-provider" provides; provider-anthropic provides it: list it in the preset's components, or give the preset a \`model\` whose provider it installs`,
  );
  writeFileSync(join(root, "presets", "other-provider.yaml"), `model: openrouter/z-ai/glm-5.3-flash\n${openrouter}`);
  expect(checkPresets(root)).toEqual([]);
});

test("the repository's presets resolve: telegram is http with channel-telegram", () => {
  expect(checkPresets(DEFAULT_REGISTRY)).toEqual([]);
  const r = openRegistry(DEFAULT_REGISTRY);
  expect(r.preset("telegram")).toEqual(r.preset("http", ["channel-telegram"]));
  expect(r.slots("http")[0]?.options.map((o) => o.name)).toEqual(["channel-http", "channel-telegram", "channel-telegram-webhook"]);
  // A server project is not offered the webhook; Cloudflare has neither the poller nor an HTTP Worker half.
  expect(r.slots("http", ["server"])[0]?.options.map((o) => o.name)).toEqual(["channel-http", "channel-telegram"]);
  expect(r.slots("http", ["cloudflare"])[0]?.options.map((o) => o.name)).toEqual(["channel-telegram-webhook"]);
});

test("the project's own records are protected targets, however they are spelled; a component's files are not", () => {
  for (const target of ["package.json", "./Package.JSON", "pikit.json", "pikit.config.ts", "bun.lock", ".env", ".env.example", ".git", ".git/config", "vendor/x.tgz", "pikit-bases/0a1b", "node_modules/a/index.js", ".pikit/sessions/a.jsonl"]) {
    expect(isProtected(target)).toBe(true);
  }
  for (const target of ["Dockerfile", "compose.yaml", ".dockerignore", ".gitignore", "src/pikit/x/package.json", "src/vendor/x.ts", "vendored.txt", ".env.production"]) {
    expect(isProtected(target)).toBe(false);
  }
});
