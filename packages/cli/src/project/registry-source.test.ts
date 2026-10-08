/**
 * Presets: a base lists components, may `choose` one per kind (or several, `multiple`) and offer
 * `features`; an alias `extends` a base and answers with `with`, exactly as `--with` does. Built on throwaway registries, plus the
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
  expect(r.slots("base")).toEqual([{ kind: "channel", question: "Where?", multiple: false, defaults: ["channel-a"], options }]);
  expect(r.slots("b")[0]?.defaults).toEqual(["channel-b"]);
});

const SEVERAL = "components: [secrets-env, channel-a, server-bun]\nchoose:\n  - kind: channel\n    multiple: true\nfeatures: [tool-x, router-y]\n";
const FEATURES = { ...COMPONENTS, "tool-x": "X: a tool", "router-y": "Y: rules", "tool-edge": { title: "Edge", targets: ["durable" as const] } };

test("a multiple question takes several answers, all of them in place of the preset's own", () => {
  const r = openRegistry(registry(COMPONENTS, { base: SEVERAL, b: "extends: base\nwith: [channel-a, channel-b]\n" }));
  expect(r.preset("base", ["channel-b", "channel-a"])).toEqual(["secrets-env", "channel-b", "channel-a", "server-bun"]);
  // One answer replaces the preset's own, as with a single question: --with channel-b is not "also B".
  expect(r.preset("base", ["channel-b"])).toEqual(["secrets-env", "channel-b", "server-bun"]);
  expect(r.preset("base", ["channel-b", "channel-b"])).toEqual(["secrets-env", "channel-b", "server-bun"]);
  // An alias answers with several; the command line answers again, all of them.
  expect(r.slots("b")[0]).toMatchObject({ multiple: true, defaults: ["channel-a", "channel-b"] });
  expect(r.preset("b", ["channel-b"])).toEqual(["secrets-env", "channel-b", "server-bun"]);
});

test("a preset's features are offered by title, and --with adds them after its components", () => {
  const r = openRegistry(registry(FEATURES, { base: SEVERAL.replace("[tool-x, router-y]", "[tool-x, router-y, tool-edge]"), b: "extends: base\nwith: [tool-x]\n" }));
  expect(r.features("base")).toEqual([{ name: "tool-x", title: "X: a tool" }, { name: "router-y", title: "Y: rules" }, { name: "tool-edge", title: "Edge" }]);
  expect(r.features("base", ["server"]).map((f) => f.name)).toEqual(["tool-x", "router-y"]);
  expect(r.preset("base", ["router-y", "channel-b", "tool-x"])).toEqual(["secrets-env", "channel-b", "server-bun", "router-y", "tool-x"]);
  // An alias that adds one: installed by the preset, so no longer offered.
  expect(r.preset("b")).toEqual(["secrets-env", "channel-a", "server-bun", "tool-x"]);
  expect(r.features("b").map((f) => f.name)).toEqual(["router-y", "tool-edge"]);
});

test("choices the preset does not ask for or offer are refused, with what to do instead", () => {
  const r = openRegistry(registry(COMPONENTS, { base: BASE }));
  expect(() => r.preset("base", ["server-bun"])).toThrow('the preset "base" has no choice of server-* components and does not offer server-bun; add it after, with `pikit add server-bun`');
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
    "a feature installed already": "components: [secrets-env]\nfeatures: [secrets-env]\n",
    "a feature of a chosen kind": "components: [channel-a]\nchoose:\n  - kind: channel\nfeatures: [channel-b]\n",
    "a feature twice": "components: [secrets-env]\nfeatures: [tool-x, tool-x]\n",
  };
  for (const [what, yaml] of Object.entries(cases)) {
    const r = openRegistry(registry(FEATURES, { base: BASE, bad: yaml }));
    expect(() => r.preset("bad"), what).toThrow();
  }
  const chained = openRegistry(registry(COMPONENTS, { base: BASE, b: "extends: base\nwith: [channel-b]\n", c: "extends: b\nwith: [channel-a]\n" }));
  expect(() => chained.preset("c")).toThrow("which is an alias itself");
});

test("slots with targets offer only the components that run on them", () => {
  const r = openRegistry(registry({ ...COMPONENTS, "channel-edge": { title: "Edge: on Workers", targets: ["durable"] } }, { base: BASE }));
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
  const offered = checkPresets(registry({ ...COMPONENTS, "tool-bare": undefined, "tool-edge": { title: "Edge", targets: ["durable"] } }, { base: "components: [secrets-env]\nfeatures: [tool-bare, tool-edge]\n" }));
  expect(offered).toEqual(["presets/base.yaml: offers tool-bare, but its component.json has no title to show", "presets/base.yaml: offers tool-edge, which runs on none of its targets"]);
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
      "channel-edge": { title: "Edge", targets: ["durable"], ...requires(["storage.sql"]) },
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
    "presets/nowhere.yaml: no target runs all its components (not on server: channel-edge; not on durable: secrets-env)",
    'presets/twice.yaml: on server, "secrets" takes one provider, and secrets-env and secrets-file each provide it',
  ]);
});

test("registry validate reports a preset whose answers and features compose alone but not all at once", () => {
  const root = registry(
    {
      "secrets-env": { provides: ["secrets"] },
      "channel-a": "A",
      // Each provides `secrets` too: alone it replaces nothing that does; with the other, two do.
      "channel-b": { title: "B", provides: ["secrets"] },
      "tool-x": { title: "X", provides: ["secrets"] },
    },
    { several: "components: [channel-a]\nchoose:\n  - kind: channel\n    multiple: true\nfeatures: [tool-x]\n" },
  );
  expect(checkPresets(root)).toEqual(['presets/several.yaml: with channel-a and channel-b and tool-x, on server, "secrets" takes one provider, and channel-b and tool-x each provide it']);
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
  expect(checkPresets(root)).toContain('presets/leaning.yaml: on server, runtime-pi requires "storage.sql", which nothing provides');
});

test("a second Cloudflare provider of storage.kv leaves cloudflare-minimal composing: it names its storage", () => {
  const kv = openRegistry(DEFAULT_REGISTRY).manifest("storage-kv-sql");
  // Cloudflare's only: on a server storage-kv-sql stays the one provider, which a chat channel's required storage.kv brings.
  const root = repositoryWith([{ ...kv, name: "storage-kv-other", description: "A second storage.kv.", targets: ["durable"] }]);
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
  expect(r.slots("http", ["durable"])[0]?.options.map((o) => o.name)).toEqual(["channel-telegram-webhook"]);
  // Several channels at once; the features each target offers, none installed already.
  expect(r.slots("telegram")[0]).toMatchObject({ multiple: true, defaults: ["channel-telegram"] });
  expect(r.preset("telegram", ["channel-telegram", "channel-http"]).filter((c) => c.startsWith("channel-"))).toEqual(["channel-telegram", "channel-http"]);
  expect(r.features("telegram", ["server"]).map((f) => f.name)).toEqual(["router-rules", "tool-mcp", "tool-fetch", "tool-websearch-brave", "health-registry"]);
  expect(r.features("telegram-cloudflare", ["durable"]).map((f) => f.name)).toEqual(["router-rules", "tool-mcp", "health-registry"]);
});

test("the project's own records are protected targets, however they are spelled; a component's files are not", () => {
  for (const target of ["package.json", "./Package.JSON", "pikit.json", "pikit.config.ts", "bun.lock", ".env", ".env.example", ".git", ".git/config", "vendor/x.tgz", "pikit-bases/0a1b", "node_modules/a/index.js", ".pikit/sessions/a.jsonl", "tsconfig.json", "bunfig.toml", "README.md", "readme.md", "src/agents", "src/agents/assistant/agent.ts", "src/extensions", "src/extensions/permission-gate.ts"]) {
    expect(isProtected(target)).toBe(true);
  }
  for (const target of ["Dockerfile", "compose.yaml", ".dockerignore", ".gitignore", "src/pikit/x/package.json", "src/vendor/x.ts", "vendored.txt", ".env.production", "src/agents.ts", "src/agents-old/x.ts", "docs/README.md"]) {
    expect(isProtected(target)).toBe(false);
  }
});

test("a component installs its README beside its code, as src/pikit/<name>/README.md", () => {
  const files = openRegistry(DEFAULT_REGISTRY).files("tool-read");
  expect(files.get("src/pikit/tool-read/README.md")).toBe(join(DEFAULT_REGISTRY, "components", "tool-read", "README.md"));
  expect(files.get("src/pikit/tool-read/index.ts")).toBeDefined();
  // A component without a README installs none.
  const root = registry({ "tool-bare": undefined }, {});
  const own = join(root, "components", "tool-bare", "files", "src", "pikit", "tool-bare");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "index.ts"), "export default {};\n");
  expect([...openRegistry(root).files("tool-bare").keys()]).toEqual(["src/pikit/tool-bare/index.ts"]);
});
