/**
 * A component's Compose file (`compose` in its component.json, features/completed/expose.md): services that run
 * beside the app on a server, which deployment-docker adds after its compose.yaml. `registry validate`
 * refuses one that is not the component's file, or on a component that never runs on a server; `pikit
 * add` records it by project path, `pikit upgrade` the new version's, `pikit remove` drops it. Run as a
 * user runs them, on a registry of this test's own, `@pikit/core` linked as `bun install` would.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { generate, validate } from "../registry/commands.ts";
import type { Manifest } from "../registry/manifest.ts";
import { runCli } from "../testing/cli.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-component-compose-test-"));
  dirs.push(dir);
  return dir;
};

/** Not an app component, as expose-* and deployment-* are: no default export. */
const INDEX = "export const service = \"sidecar\";\n";
const SERVICE = "services:\n  sidecar:\n    image: busybox\n";

/** Writes `expose-side` at `version` in the registry at `root`: its index, its Compose files, `fields` of its manifest. */
function publish(root: string, version: string, files: Record<string, string>, fields: Record<string, unknown>): void {
  const name = "expose-side";
  const dir = join(root, "components", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
  for (const [file, text] of Object.entries({ "index.ts": INDEX, ...files })) writeFileSync(join(dir, "files", "src", "pikit", name, file), text);
  const manifest = {
    name, version, description: name, targets: ["server"], requires: { pikit: "0.0.1", capabilities: [] },
    optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...fields,
  };
  writeFileSync(join(dir, "component.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: { [name]: { version, description: name, targets: ["server"], path: `components/${name}` } } }));
}

function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "composed", "dependencies": {} }\n');
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

const record = (dir: string) => JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8")).components["expose-side"];

/**
 * A project whose deployment runs Compose files (`services.compose`): a Compose file needs one
 * (`project/composition.ts`). Only its install record: nothing here deploys.
 */
function projectWithComposeHost(): string {
  const dir = project();
  const manifest = emptyManifest();
  manifest.components["deployment-host"] = {
    registry: "default", version: "0.1.0", requires: { pikit: "0.0.1" }, files: {}, dependencies: {}, addedDependencies: [], environment: [],
    deployment: { supports: ["services.compose"] },
  };
  writeProjectManifest(dir, manifest);
  return dir;
}

test("pikit add records the Compose file by project path; pikit upgrade takes the new one, pikit remove drops it", async () => {
  const dir = projectWithComposeHost();
  const from = temp();
  publish(from, "0.1.0", { "compose.yaml": SERVICE }, { compose: "compose.yaml" });
  const add = await runCli(["add", "expose-side", "--registry", from, "--yes"], dir);
  expect(add.code).toBe(0);
  expect(record(dir).compose).toBe("src/pikit/expose-side/compose.yaml");
  expect(existsSync(join(dir, "src/pikit/expose-side/compose.yaml"))).toBe(true);
  // Not an app component: nothing listed in pikit.config.ts.
  expect(readFileSync(join(dir, "pikit.config.ts"), "utf8")).not.toContain("expose-side");

  publish(from, "0.2.0", { "sidecar.yml": SERVICE }, { compose: "sidecar.yml" });
  expect((await runCli(["upgrade", "expose-side", "--yes"], dir)).code).toBe(0);
  expect(record(dir).compose).toBe("src/pikit/expose-side/sidecar.yml");

  expect((await runCli(["remove", "expose-side"], dir)).code).toBe(0);
  expect(record(dir)).toBeUndefined();
}, 60_000);

/** What `registry validate` says of `expose-side` with `compose`, its files and its targets. */
async function validated(compose: string, files: Record<string, string>, targets: string[] = ["server"]): Promise<string[]> {
  const root = temp();
  publish(root, "0.1.0", { "expose-side.test.ts": "// its own test\n", ...files }, {});
  writeFileSync(join(root, "components", "expose-side", "README.md"), "# expose-side\n\nA sidecar.\n");
  expect((await generate(root)).problems).toEqual([]);
  const path = join(root, "components", "expose-side", "component.json");
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as Manifest), targets, compose }));
  expect((await generate(root)).problems).toEqual([]);
  return (await validate(root)).problems;
}

test("registry validate: a Compose file of the component's own, on a component that runs on a server", async () => {
  expect(await validated("compose.yaml", { "compose.yaml": SERVICE })).toEqual([]);
  expect(await validated("nowhere.yaml", { "compose.yaml": SERVICE })).toEqual(['expose-side: compose "nowhere.yaml" is not a file of files/src/pikit/expose-side/']);
  expect(await validated("compose.yaml", { "compose.yaml": SERVICE }, ["durable"])).toEqual([
    'expose-side: compose "compose.yaml" runs beside the app on a server (deployment-docker), but the component\'s targets do not include server',
  ]);
  expect((await validated("../other/compose.yaml", { "compose.yaml": SERVICE })).join("\n")).toContain("/compose");
  expect((await validated("compose.json", { "compose.json": "{}" })).join("\n")).toContain("/compose");
}, 60_000);
