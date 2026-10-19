/**
 * `pikit new`'s starter model: the preset's `model`, or the starter's for the target, and in both cases
 * its provider installed by the preset, checked before anything is written. A registry of stand-ins:
 * a runtime that reads `model.provider`, and providers of the keys `alpha` and `anthropic`. The one
 * `bun install` here is made to fail at once: no network.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import type { Manifest } from "../registry/manifest.ts";
import { runCli } from "../testing/cli.ts";
import { checkStarterModel, uiComponentsFor } from "./new.ts";
import { starterModel } from "./starter.ts";
import { UI_COMPONENTS } from "./ui.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-new-test-"));
  dirs.push(dir);
  return dir;
};

/** A registry of stand-ins, with the given presets (`presets/<name>.yaml` → its text). */
function registry(presets: Record<string, string>): string {
  const root = temp();
  const components: Record<string, { optional?: string[]; provides?: string[]; modelProviders?: string[] }> = {
    "runtime-fake": { optional: ["model.provider"], provides: ["agent.runtime"] },
    "provider-alpha": { provides: ["model.provider"], modelProviders: ["alpha"] },
    "provider-anthropic": { provides: ["model.provider"], modelProviders: ["anthropic"] },
    "provider-unknown": { provides: ["model.provider"] },
  };
  const index: Record<string, unknown> = {};
  for (const [name, { optional = [], provides = [], modelProviders }] of Object.entries(components)) {
    const dir = join(root, "components", name);
    mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
    writeFileSync(
      join(dir, "files", "src", "pikit", name, "index.ts"),
      `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({ name: "${name}", setup() {} });\n`,
    );
    const manifest = {
      name, version: "0.0.1", description: name, targets: ["server"], requires: { pikit: "0.0.1", capabilities: [] },
      optional: { capabilities: optional }, provides, ...(modelProviders !== undefined && { modelProviders }),
      dependencies: {}, files: [{ source: "files/src", target: "src" }],
    };
    writeFileSync(join(dir, "component.json"), JSON.stringify(manifest));
    index[name] = { version: "0.0.1", description: name, targets: ["server"], path: `components/${name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
  mkdirSync(join(root, "presets"));
  for (const [name, text] of Object.entries(presets)) writeFileSync(join(root, "presets", `${name}.yaml`), text);
  return root;
}

test("a preset's model is read from its base; an alias has the base's; none leaves it to the starter", () => {
  const root = registry({
    own: "components: [provider-alpha, runtime-fake]\nchoose: [{ kind: runtime }]\nmodel: alpha/model-1\n",
    alias: "extends: own\nwith: [runtime-fake]\n",
    plain: "components: [provider-anthropic, runtime-fake]\n",
    slashless: "components: [runtime-fake]\nmodel: gpt\n",
  });
  const fake = openRegistry(root);
  expect(fake.presetModel("own")).toBe("alpha/model-1");
  expect(fake.presetModel("plain")).toBeUndefined();
  // A model is `<provider>/<modelId>`: the key the check reads.
  expect(() => fake.presetModel("slashless")).toThrow("presets/slashless.yaml (a base preset): /model:");
  expect(fake.presetModel("alias")).toBe("alpha/model-1");
});

test("the starter model's provider must be one the preset installs, whether the preset or the target chose it", () => {
  const fake = openRegistry(registry({}));
  const check = (components: string[], model: string) => () => checkStarterModel(fake, components, "server", model, "p");
  // The preset's model, its provider installed.
  expect(check(["provider-alpha", "runtime-fake"], "alpha/model-1")).not.toThrow();
  // The target's default, its provider installed: what every builtin server preset does.
  expect(check(["provider-anthropic", "runtime-fake"], starterModel("server"))).not.toThrow();
  // The target's default, another provider installed: named, with the component that provides it.
  expect(check(["provider-alpha", "runtime-fake"], starterModel("server"))).toThrow(
    `the starter agent's model "${starterModel("server")}" needs the model provider "anthropic", which no component of the preset "p" provides; provider-anthropic provides it: list it in the preset's components, or give the preset a \`model\` whose provider it installs`,
  );
  // The preset's model, whose provider no component of the registry has.
  expect(check(["provider-alpha", "runtime-fake"], "beta/model-2")).toThrow('needs the model provider "beta", which no component of the preset "p" provides; no component of the registry');
  // Nothing reads the model (no runtime), or a provider whose keys are not recorded: doctor says it later.
  expect(check(["provider-alpha"], "beta/model-2")).not.toThrow();
  expect(check(["provider-unknown", "runtime-fake"], "beta/model-2")).not.toThrow();
});

test("every builtin preset installs its starter model's provider on the target it runs on", () => {
  const builtin = openRegistry(DEFAULT_REGISTRY);
  for (const { name } of builtin.presets()) {
    const components = builtin.preset(name);
    for (const target of ["server", "durable"]) {
      if (!components.every((c) => builtin.manifest(c).targets.includes(target))) continue;
      expect(() => checkStarterModel(builtin, components, target, builtin.presetModel(name) ?? starterModel(target), name)).not.toThrow();
    }
  }
});

test("new refuses a preset whose starter model's provider it does not install, before writing; a preset's model is the agent's", async () => {
  const root = registry({
    mismatched: "components: [provider-alpha, runtime-fake]\n",
    own: "components: [provider-alpha, runtime-fake]\nmodel: alpha/model-1\n",
  });
  const parent = temp();
  const run = (preset: string) => runCli(["new", preset, "--preset", preset, "--registry", root], parent, { env: { NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/" } });
  const refused = await run("mismatched");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain('needs the model provider "anthropic", which no component of the preset "mismatched" provides; provider-anthropic provides it');
  expect(existsSync(join(parent, "mismatched"))).toBe(false);

  // Accepted: every file is written, then `bun install` fails at once.
  expect((await run("own")).err).toContain("`bun install` failed");
  expect(readFileSync(join(parent, "own", "src", "agents", "assistant", "agent.ts"), "utf8")).toContain('model: "alpha/model-1",');
}, 60_000);

test("--ui brings admin-api, and the defaults for admin.auth and settings that the chosen components do not provide; a default the preset chose is the preset's", () => {
  const builtin = openRegistry(DEFAULT_REGISTRY);
  expect(uiComponentsFor(builtin, builtin.preset("http"), ["server"])).toEqual([...UI_COMPONENTS]);
  expect(uiComponentsFor(builtin, builtin.preset("telegram-cloudflare"), ["durable"])).toEqual([...UI_COMPONENTS]);
  // agents-live's group installs settings-store: the preset's, never recorded as the dashboard's.
  const live = builtin.preset("http", ["agents-live"]);
  expect(live).toContain("settings-store");
  expect(uiComponentsFor(builtin, live, ["server"])).toEqual(["admin-auth-token", "admin-api"]);
});

test("--ui with other providers of admin.auth and settings: decided by what their manifests declare in each App of the target", () => {
  const nothing = { provides: [], requires: [], optional: [] };
  const fake = (manifests: Partial<Manifest>[]): Registry => {
    const full = manifests.map((m) => ({ version: "0.0.1", description: m.name, targets: ["server", "durable"], requires: { pikit: "0.0.1", capabilities: [] }, optional: { capabilities: [] }, provides: [], dependencies: {}, files: [], ...m }) as Manifest);
    return { names: () => full.map((m) => m.name), manifest: (name: string) => full.find((m) => m.name === name) as Manifest } as unknown as Registry;
  };
  const registry = fake([
    { name: "admin-auth-sso", provides: ["admin.auth"], apps: { worker: "default" } },
    { name: "settings-file", provides: ["settings"] },
    { name: "admin-auth-edge", provides: ["admin.auth"], apps: { worker: "worker" }, halves: { default: nothing, worker: { ...nothing, provides: ["admin.auth"] } } },
    { name: "settings-both", provides: ["settings"], apps: { worker: "default" } },
  ]);
  expect(uiComponentsFor(registry, ["admin-auth-sso", "settings-file"], ["server"])).toEqual(["admin-api"]);
  expect(uiComponentsFor(registry, ["admin-auth-sso"], ["server"])).toEqual(["admin-api", "settings-store"]);
  expect(uiComponentsFor(registry, ["settings-file"], ["server"])).toEqual(["admin-auth-token", "admin-api"]);
  // On Cloudflare, each in both Apps: nothing of theirs comes.
  expect(uiComponentsFor(registry, ["admin-auth-sso", "settings-both"], ["durable"])).toEqual(["admin-api"]);
  // In one App only: refused before anything is written; the default would be a second provider in the other.
  expect(() => uiComponentsFor(registry, ["admin-auth-edge"], ["durable"])).toThrow("the dashboard needs admin.auth in every App, and it is provided in the Worker's App (export const worker) but not in the default App");
  expect(() => uiComponentsFor(registry, ["settings-file"], ["durable"])).toThrow("the dashboard needs settings in every App, and it is provided in the default App but not in the Worker's App (export const worker)");
  // On a server only the default App counts: the Worker's half alone does not provide it there.
  expect(uiComponentsFor(registry, ["admin-auth-edge"], ["server"])).toEqual([...UI_COMPONENTS]);
});
