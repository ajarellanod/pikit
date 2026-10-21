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
      version: "0.0.1",
      description: name,
      targets: ["server"],
      requires: { pikit: "0.0.1", capabilities: [] },
      optional: { capabilities: [] },
      provides: [],
      dependencies: {},
      files: [{ source: "files/src", target: "src" }],
      ...fields,
    };
    writeFileSync(join(root, "components", name, "component.json"), JSON.stringify(manifest));
    index[name] = { version: "0.0.1", description: name, targets: manifest.targets, path: `components/${name}` };
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

test("dashboard defaults are declared by the base and inherited by its aliases", () => {
  const r = openRegistry(registry(COMPONENTS, {
    base: `ui: true\n${BASE}`,
    b: "extends: base\nwith: [channel-b]\n",
    plain: BASE,
    invalid: `ui: yes\n${BASE}`,
  }));
  expect(r.presetUi("base")).toBe(true);
  expect(r.presetUi("b")).toBe(true);
  expect(r.presetUi("plain")).toBe(false);
  expect(() => r.presetUi("invalid")).toThrow("/ui:");
});

test("multiple choices without a default allow none, one or several; aliases and explicit answers work", () => {
  const r = openRegistry(registry(COMPONENTS, {
    base: "components: [secrets-env, server-bun]\nchoose: [{ kind: channel, multiple: true }]\n",
    b: "extends: base\nwith: [channel-b]\n",
  }));
  expect(r.preset("base")).toEqual(["secrets-env", "server-bun"]);
  expect(r.slots("base")[0]).toMatchObject({ multiple: true, defaults: [] });
  expect(r.preset("base", ["channel-b", "channel-b"])).toEqual(["secrets-env", "server-bun", "channel-b"]);
  expect(r.preset("base", ["channel-a", "channel-b"])).toEqual(["secrets-env", "server-bun", "channel-a", "channel-b"]);
  expect(r.preset("b")).toEqual(r.preset("base", ["channel-b"]));
  expect(r.preset("b", ["channel-a"])).toEqual(r.preset("base", ["channel-a"]));
});

/** `features` as YAML: each a group of components, named by its first. */
const features = (...groups: string[][]) => `features: [${groups.map((group) => `{ components: [${group.join(", ")}] }`).join(", ")}]\n`;
const SEVERAL_HEAD = "components: [secrets-env, channel-a, server-bun]\nchoose:\n  - kind: channel\n    multiple: true\n";
const SEVERAL = SEVERAL_HEAD + features(["tool-x"], ["router-y"]);
/** A feature as `features()` returns it, granting nothing and bringing no dashboard. */
const plain = (name: string, title: string, components = [name]) => ({ name, title, components, ui: false, steward: { tools: [], extensions: [] } });
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
  const r = openRegistry(registry(FEATURES, { base: SEVERAL_HEAD + features(["tool-x"], ["router-y"], ["tool-edge"]), b: "extends: base\nwith: [tool-x]\n" }));
  expect(r.features("base")).toEqual([plain("tool-x", "X: a tool"), plain("router-y", "Y: rules"), plain("tool-edge", "Edge")]);
  expect(r.features("base", ["server"]).map((f) => f.name)).toEqual(["tool-x", "router-y"]);
  expect(r.preset("base", ["router-y", "channel-b", "tool-x"])).toEqual(["secrets-env", "channel-b", "server-bun", "router-y", "tool-x"]);
  // An alias that adds one: installed by the preset, so no longer offered.
  expect(r.preset("b")).toEqual(["secrets-env", "channel-a", "server-bun", "tool-x"]);
  expect(r.features("b").map((f) => f.name)).toEqual(["router-y", "tool-edge"]);
});

test("a feature may be a group of components: offered by its first's title, and --with of it adds them all, once", () => {
  const r = openRegistry(registry(FEATURES, { base: SEVERAL_HEAD + features(["router-y"], ["tool-x", "router-y"]) }));
  expect(r.features("base")).toEqual([plain("router-y", "Y: rules"), plain("tool-x", "X: a tool", ["tool-x", "router-y"])]);
  expect(r.preset("base", ["tool-x"])).toEqual(["secrets-env", "channel-a", "server-bun", "tool-x", "router-y"]);
  expect(r.preset("base", ["router-y", "tool-x"])).toEqual(["secrets-env", "channel-a", "server-bun", "router-y", "tool-x"]);
  // A group is named by its first only.
  const grouped = openRegistry(registry(FEATURES, { base: SEVERAL_HEAD + features(["tool-x", "router-y"]) }));
  expect(() => grouped.preset("base", ["router-y"])).toThrow("does not offer router-y");
  // A group's components are checked as a feature's: none installed already.
  const installed = openRegistry(registry(FEATURES, { base: SEVERAL_HEAD + features(["tool-x", "server-bun"]) }));
  expect(() => installed.preset("base")).toThrow("`features` lists server-bun, which `components` installs already");
});

test("a preset's policy: steward grants, config, agent layout and each feature's grants and dashboard, inherited by its aliases", () => {
  const yaml = [
    "components: [secrets-env, channel-a, server-bun]",
    "choose: [{ kind: channel, multiple: true }]",
    "steward: { tools: [read] }",
    "config:\n  channel-b: { greeting: hi, retries: [1, 2] }\n  router-y: { defaultAgent: steward }",
    "agents: { folders: { feature: router-y, command: crew } }",
    "features:\n  - components: [router-y]\n  - components: [tool-x, router-y]\n    ui: true\n    steward: { tools: [shell] }",
  ].join("\n");
  const r = openRegistry(registry(FEATURES, { base: `${yaml}\n`, b: "extends: base\nwith: [tool-x]\n" }));
  const policy = r.presetPolicy("base");
  expect(policy.steward).toEqual({ tools: ["read"], extensions: [] });
  expect(policy.config).toEqual({ "channel-b": { greeting: "hi", retries: [1, 2] }, "router-y": { defaultAgent: "steward" } });
  expect(policy.agents).toEqual({ folders: { feature: "router-y", command: "crew" } });
  expect(policy.features).toEqual([plain("router-y", "Y: rules"), { ...plain("tool-x", "X: a tool", ["tool-x", "router-y"]), ui: true, steward: { tools: ["shell"], extensions: [] } }]);
  // An alias has its base's policy; what it installs (tool-x's group, router-y with it) is no longer offered.
  expect(r.presetPolicy("b")).toEqual(policy);
  expect(r.features("b").map((f) => f.name)).toEqual([]);
  // Config for a component the registry does not have: refused when read.
  const ghost = openRegistry(registry(FEATURES, { base: "components: [secrets-env, channel-a]\nchoose: [{ kind: channel }]\nconfig: { channel-z: { a: 1 } }\n" }));
  expect(() => ghost.presetPolicy("base")).toThrow('no component "channel-z"');
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
    "two defaults in a multiple choice": "components: [channel-a, channel-b]\nchoose: [{ kind: channel, multiple: true }]\n",
    "none of the chosen kind": "components: [secrets-env]\nchoose:\n  - kind: channel\n",
    "a kind chosen twice": "components: [channel-a]\nchoose:\n  - kind: channel\n  - kind: channel\n",
    "an alias with components": "extends: base\nwith: [channel-b]\ncomponents: [secrets-env]\n",
    "an alias that chooses nothing": "extends: base\n",
    "with but no extends": "components: [channel-a]\nwith: [channel-b]\n",
    "a feature installed already": `components: [secrets-env]\n${features(["secrets-env"])}`,
    "a feature of a chosen kind": `components: [channel-a]\nchoose:\n  - kind: channel\n${features(["channel-b"])}`,
    "a feature twice": `components: [secrets-env]\n${features(["tool-x"], ["tool-x", "router-y"])}`,
    "a feature in the old string form": "components: [secrets-env]\nfeatures: [tool-x]\n",
    "a feature in the old group form": "components: [secrets-env]\nfeatures: [[tool-x, router-y]]\n",
    "an unknown grant field": "components: [secrets-env]\nsteward: { tools: [read], hooks: [x] }\n",
    "a folders layout whose feature is none of its features": `components: [secrets-env]\nagents: { folders: { feature: tool-y, command: agents } }\n${features(["tool-x"])}`,
    "config for a component it never installs": "components: [secrets-env]\nconfig: { router-y: { a: 1 } }\n",
    "an alias with its own steward": "extends: base\nwith: [channel-b]\nsteward: { tools: [bash] }\n",
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
  const offered = checkPresets(registry({ ...COMPONENTS, "tool-bare": undefined, "tool-edge": { title: "Edge", targets: ["durable"] } }, { base: `components: [secrets-env]\n${features(["tool-bare"], ["tool-edge"])}` }));
  expect(offered).toEqual(["presets/base.yaml: offers tool-bare, but its component.json has no title to show", "presets/base.yaml: offers tool-edge, which runs on none of its targets"]);
  expect(problems.some((p) => p.startsWith('presets/ghost.yaml: the registry') && p.includes('no component "nope-x"'))).toBe(true);
});

test("registry validate reports a preset that does not compose on its target, and each answer that does not", () => {
  const requires = (capabilities: string[]) => ({ requires: { pikit: "0.0.1", capabilities } });
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
    { several: `components: [channel-a]\nchoose:\n  - kind: channel\n    multiple: true\n${features(["tool-x"])}` },
  );
  // Each answer with each feature, and everything at once.
  expect(checkPresets(root)).toEqual([
    'presets/several.yaml: with channel-b and tool-x, on server, "secrets" takes one provider, and channel-b and tool-x each provide it',
    'presets/several.yaml: with channel-a and channel-b and tool-x, on server, "secrets" takes one provider, and channel-b and tool-x each provide it',
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
  // These copies validate the manifests, not a real UI build; dashboard defaults need a template.
  mkdirSync(join(root, "dashboard", "files"), { recursive: true });
  writeFileSync(join(root, "dashboard", "files", "README.md"), "Dashboard fixture\n");
  copyFileSync(join(DEFAULT_REGISTRY, "dashboard", "dashboard.json"), join(root, "dashboard", "dashboard.json"));
  mkdirSync(join(root, "presets"));
  for (const file of readdirSync(join(DEFAULT_REGISTRY, "presets"))) copyFileSync(join(DEFAULT_REGISTRY, "presets", file), join(root, "presets", file));
  return root;
}

test("registry validation refuses default dashboards without their source template", () => {
  const root = repositoryWith([]);
  rmSync(join(root, "dashboard"), { recursive: true });
  const missing = checkPresets(root).filter((problem) => problem.includes("installs the dashboard, but the registry has no dashboard"));
  expect(missing.map((problem) => problem.split(":")[0])).toEqual([
    "presets/base.yaml", "presets/celld.yaml", "presets/cloudflare.yaml", "presets/telegram.yaml",
  ]);
}, 30_000);

test("registry validation checks the default dashboard's target compatibility too", () => {
  const root = repositoryWith([]);
  const file = join(root, "components", "admin-api", "component.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.targets = ["server"];
  writeFileSync(file, JSON.stringify(manifest));
  const problems = checkPresets(root);
  expect(problems).toContain("presets/cloudflare.yaml: on durable, admin-api runs on server, not on durable");
  expect(problems).toContain("presets/celld.yaml: on durable, admin-api runs on server, not on durable");
}, 30_000);

test("a second server provider of storage.sql leaves the repository's presets composing: they name their storage", () => {
  const sqlite = openRegistry(DEFAULT_REGISTRY).manifest("storage-sqlite");
  // A second provider of all storage-sqlite provides (storage.sql and storage.sqlite).
  const root = repositoryWith([{ ...sqlite, name: "storage-postgres", description: "A second server storage.sql and storage.sqlite." }]);
  expect(checkPresets(root)).toEqual([]);
  // A preset that left its storage to the offer: with two providers nothing is offered, and it says so,
  // as it is and with each answer and feature it offers (whichever those are), and of nothing else.
  const base = readFileSync(join(root, "presets", "base.yaml"), "utf8");
  writeFileSync(join(root, "presets", "leaning.yaml"), base.replace(/^\s+- storage-sqlite\n/m, ""));
  const problems = checkPresets(root);
  expect(problems).toContain('presets/leaning.yaml: on server, runtime-pi requires "storage.sqlite", which nothing provides');
  expect(problems).toContain('presets/leaning.yaml: on server, storage-kv-sql requires "storage.sql", which nothing provides');
  for (const problem of problems) {
    expect(problem).toMatch(/^presets\/leaning\.yaml: (with [\w -]+, )?on server, [\w-]+ requires "storage\.sql(ite)?", which nothing provides$/);
  }
}, 30_000);

test("a second Cloudflare provider of storage.kv leaves base-cloudflare composing: it names its storage", () => {
  const kv = openRegistry(DEFAULT_REGISTRY).manifest("storage-kv-sql");
  // Cloudflare's only: on a server storage-kv-sql stays the one provider, which a chat channel's required storage.kv brings.
  const root = repositoryWith([{ ...kv, name: "storage-kv-other", description: "A second storage.kv.", targets: ["durable"] }]);
  expect(checkPresets(root)).toEqual([]);
}, 30_000);

test("registry validate reports a preset whose starter model's provider it does not install, unless the preset names its model", () => {
  const root = repositoryWith([]);
  const base = readFileSync(join(root, "presets", "base.yaml"), "utf8");
  const openrouter = base.replace(/^\s+- provider-anthropic\n/m, "  - provider-openrouter\n");
  writeFileSync(join(root, "presets", "other-provider.yaml"), openrouter);
  expect(checkPresets(root)).toContain(
    `presets/other-provider.yaml: on server, the starter agent's model "anthropic/claude-sonnet-4-6" needs the model provider "anthropic", which no component of the preset "other-provider" provides; provider-anthropic provides it: list it in the preset's components, or give the preset a \`model\` whose provider it installs`,
  );
  writeFileSync(join(root, "presets", "other-provider.yaml"), `model: openrouter/z-ai/glm-5.3-flash\n${openrouter}`);
  expect(checkPresets(root)).toEqual([]);
}, 30_000);

test("the repository's presets resolve: telegram is base with channel-telegram; durable bases have no default channel", () => {
  expect(checkPresets(DEFAULT_REGISTRY)).toEqual([]);
  const r = openRegistry(DEFAULT_REGISTRY);
  expect(r.preset("telegram")).toEqual(r.preset("base", ["channel-telegram"]));
  expect(r.slots("base")[0]?.options.map((o) => o.name)).toEqual(["channel-google-chat", "channel-http", "channel-telegram", "channel-telegram-webhook", "channel-web"]);
  for (const preset of ["base", "telegram", "cloudflare", "celld"]) expect(r.presetUi(preset)).toBe(true);
  expect(r.presetUi("base-cloudflare")).toBe(false);
  for (const preset of ["cloudflare", "celld"]) {
    expect(r.preset(preset).filter((c) => c.startsWith("channel-"))).toEqual([]);
    expect(r.slots(preset, ["durable"])[0]?.defaults).toEqual([]);
    expect(r.preset(preset, ["channel-telegram-webhook", "channel-http"]).filter((c) => c.startsWith("channel-"))).toEqual(["channel-telegram-webhook", "channel-http"]);
  }
  // A server project is not offered the webhook; Cloudflare has no poller. Google Chat, the HTTP API
  // (channel-http) and the chat page (channel-web) run on both.
  expect(r.slots("base", ["server"])[0]?.options.map((o) => o.name)).toEqual(["channel-google-chat", "channel-http", "channel-telegram", "channel-web"]);
  expect(r.slots("base", ["durable"])[0]?.options.map((o) => o.name)).toEqual(["channel-google-chat", "channel-http", "channel-telegram-webhook", "channel-web"]);
  // Several channels at once; the features each target offers, none installed already.
  expect(r.slots("telegram")[0]).toMatchObject({ multiple: true, defaults: ["channel-telegram"] });
  expect(r.preset("telegram", ["channel-telegram", "channel-http"]).filter((c) => c.startsWith("channel-"))).toEqual(["channel-telegram", "channel-http"]);
  expect(r.features("telegram", ["server"]).map((f) => f.name)).toEqual(["agents-folders", "router-rules", "agents-live", "tool-mcp", "health-registry", "admin-proposals"]);
  expect(r.features("cloudflare", ["durable"]).map((f) => f.name)).toEqual(["agents-folders", "router-rules", "agents-live", "tool-mcp", "health-registry", "admin-proposals"]);
  // Agents from the dashboard is a group: the live agents, the rules that route to them, and the settings they are.
  expect(r.features("cloudflare", ["durable"]).find((f) => f.name === "agents-live")?.components).toEqual(["agents-live", "router-rules", "settings-store"]);
  expect(r.preset("telegram", ["agents-live"]).slice(-3)).toEqual(["agents-live", "router-rules", "settings-store"]);
}, 30_000);

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
