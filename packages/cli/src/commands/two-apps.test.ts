/**
 * `pikit add` and `pikit remove` on a project with two Apps (a Cloudflare project, SPEC §4.1, C1), run
 * as a user runs them: each half goes in its App, what each half requires is checked in its App, and
 * `remove` undoes both. On a server project nothing of that happens: one App, the default export.
 *
 * The components come from a registry of this test's own (stand-ins with no npm dependencies, so no
 * `bun install`), and `@pikit/core` is this repository's, linked as `bun install` would: `doctor`
 * composes the real Apps.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES_DIR } from "../paths.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { kitSpecifier } from "../project/vendor.ts";
import { runCli } from "../testing/cli.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-two-apps-test-"));
  dirs.push(dir);
  return dir;
};

const ONE_APP = `import { defineApp } from "@pikit/core";

export const config = {};

export default defineApp({
  components: [
  ],
  config,
});
`;

const TWO_APPS = `${ONE_APP}
export const workerConfig = {};

export const worker = defineApp({
  components: [
  ],
  config: workerConfig,
});
`;

/** A project on `target` whose kit is this CLI's, with `@pikit/core` linked: `add` needs no install. */
function project(target: "server" | "durable"): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest(undefined, undefined, [target]));
  const contracts = kitSpecifier("@pikit/contracts");
  mkdirSync(join(dir, "vendor"));
  writeFileSync(join(dir, contracts.slice("file:".length)), "this CLI's kit");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "edge", dependencies: { "@pikit/contracts": contracts } }, null, 2)}\n`);
  writeFileSync(join(dir, "pikit.config.ts"), target === "durable" ? TWO_APPS : ONE_APP);
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  for (const kit of ["core", "contracts"]) symlinkSync(join(PACKAGES_DIR, kit), join(dir, "node_modules", "@pikit", kit));
  return dir;
}

const HALF = (provides: string[], requires: string[]) => ({ provides, requires, optional: [] });

/**
 * - `secrets-fake`: provides `secrets`, in both Apps (`apps.worker: "default"`), as secrets-cloudflare.
 * - `channel-fake`: an object's half that requires `secrets`, and a Worker half, `channel-fake-worker`
 *   (the export `worker`), that requires `secrets` and serves a route; an after-deploy hook.
 */
function registry(): string {
  const root = temp();
  const components: Record<string, { manifest: Record<string, unknown>; files: Record<string, string> }> = {
    "secrets-fake": {
      manifest: { provides: ["secrets"], apps: { worker: "default" } },
      files: {
        "index.ts": `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "secrets-fake",\n  setup(pikit) {\n    pikit.provide("secrets", { get: async () => undefined });\n  },\n});\n`,
      },
    },
    "channel-fake": {
      manifest: {
        requires: { pikit: "0.0.0", capabilities: ["secrets"] },
        provides: ["http.route"],
        apps: { worker: "worker" },
        halves: { default: HALF([], ["secrets"]), worker: HALF(["http.route"], ["secrets"]) },
        hooks: { afterDeploy: "deploy.ts" },
      },
      files: {
        "index.ts": `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "channel-fake",\n  setup(pikit) {\n    pikit.use("secrets");\n  },\n});\n\nexport const worker = defineComponent({\n  name: "channel-fake-worker",\n  config: { type: "object", properties: { path: { type: "string", default: "/fake" } } },\n  setup(pikit) {\n    pikit.use("secrets");\n    pikit.provideKeyed("http.route", "POST /fake", () => new Response(null));\n  },\n});\n`,
        "deploy.ts": "export async function afterDeploy(): Promise<string[]> {\n  return [];\n}\n",
      },
    },
  };
  const index: Record<string, unknown> = {};
  for (const [name, { manifest, files }] of Object.entries(components)) {
    const dir = join(root, "components", name);
    mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, "files", "src", "pikit", name, file), text);
    const full = {
      name, version: "0.0.0", description: name, targets: ["server", "durable"], requires: { pikit: "0.0.0", capabilities: [] },
      optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...manifest,
    };
    writeFileSync(join(dir, "component.json"), JSON.stringify(full));
    index[name] = { version: "0.0.0", description: name, targets: full.targets, path: `components/${name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
  return root;
}

test("on Cloudflare, add puts each half in its App, checks each App, records the hook; remove undoes both", async () => {
  const dir = project("durable");
  const from = registry();
  const configPath = join(dir, "pikit.config.ts");

  // Nothing provides secrets yet, in either App: said per App, and doctor finds the object's App incomplete.
  const alone = await runCli(["add", "channel-fake", "--yes", "--registry", from], dir);
  expect(alone.err).toContain('channel-fake requires "secrets" in the default App, which no installed component provides there yet');
  expect(alone.err).toContain('channel-fake requires "secrets" in the Worker\'s App (export const worker), which no installed component provides there yet');
  expect(alone.code).toBe(1);
  expect(alone.err).toContain("channel-fake is installed, but `pikit doctor` found 1 problem(s)");
  const withChannel = readFileSync(configPath, "utf8");
  expect(withChannel).toContain('import channelFake, { worker as channelFakeWorker } from "./src/pikit/channel-fake/index.ts";\n');
  expect(withChannel).toContain("export default defineApp({\n  components: [\n    channelFake,\n  ],\n  config,\n});");
  expect(withChannel).toContain("export const worker = defineApp({\n  components: [\n    channelFakeWorker,\n  ],\n  config: workerConfig,\n});");
  const installed = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8")).components["channel-fake"];
  expect(installed.hooks).toEqual({ afterDeploy: "src/pikit/channel-fake/deploy.ts" });

  // A component that works in both Apps goes in both, and both Apps compose.
  const secrets = await runCli(["add", "secrets-fake", "--yes", "--registry", from], dir);
  expect(secrets.err).not.toContain("which no installed component provides");
  expect(secrets.out).toContain("secrets-fake installed; `pikit doctor` is green");
  expect(secrets.code).toBe(0);
  const withBoth = readFileSync(configPath, "utf8");
  expect(withBoth).toContain("  components: [\n    channelFake,\n    secretsFake,\n  ],\n  config,\n");
  expect(withBoth).toContain("  components: [\n    channelFakeWorker,\n    secretsFake,\n  ],\n  config: workerConfig,\n");

  // doctor shows the Worker's App too.
  const doctor = await runCli(["doctor"], dir);
  expect(doctor.code).toBe(0);
  expect(doctor.out).toContain("The Worker's App (export const worker):");
  expect(doctor.out).toMatch(/ {4}channel-fake-worker +provides http.route · requires secrets\n/);

  // What requires it in the Worker's App is said as such.
  const refused = await runCli(["remove", "secrets-fake"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("channel-fake requires secrets\n");
  expect(refused.err).toContain("channel-fake-worker requires secrets in the Worker's App");
  expect(readFileSync(configPath, "utf8")).toBe(withBoth);

  // Configured by hand under its Worker half's name, in the Worker's config.
  writeFileSync(configPath, withBoth.replace("export const workerConfig = {};", 'export const workerConfig = {\n  "channel-fake-worker": { path: "/other" },\n};'));
  expect((await runCli(["doctor"], dir)).code).toBe(0);

  // Removing the channel takes both halves out of both lists, its config with them, and leaves the rest.
  const removed = await runCli(["remove", "channel-fake"], dir);
  expect(removed.code).toBe(0);
  expect(readFileSync(configPath, "utf8")).toBe(TWO_APPS.replace("import { defineApp } from \"@pikit/core\";\n", 'import { defineApp } from "@pikit/core";\nimport secretsFake from "./src/pikit/secrets-fake/index.ts";\n').replaceAll("  components: [\n  ],", "  components: [\n    secretsFake,\n  ],"));
  expect((await runCli(["remove", "secrets-fake"], dir)).code).toBe(0);
  expect(readFileSync(configPath, "utf8")).toBe(TWO_APPS);
}, 60_000);

test("on a server, a component with a Worker half is listed once, by its default export: nothing changes", async () => {
  const dir = project("server");
  const from = registry();
  expect((await runCli(["add", "secrets-fake", "--yes", "--registry", from], dir)).code).toBe(0);
  const added = await runCli(["add", "channel-fake", "--yes", "--registry", from], dir);
  expect(added.err).not.toContain("App");
  expect(added.code).toBe(0);
  const config = readFileSync(join(dir, "pikit.config.ts"), "utf8");
  expect(config).toContain('import channelFake from "./src/pikit/channel-fake/index.ts";\n');
  expect(config).toContain("  components: [\n    secretsFake,\n    channelFake,\n  ],");
  expect(config).not.toContain("channelFakeWorker");
  expect((await runCli(["remove", "channel-fake"], dir)).code).toBe(0);
  expect((await runCli(["remove", "secrets-fake"], dir)).code).toBe(0);
  expect(readFileSync(join(dir, "pikit.config.ts"), "utf8")).toBe(ONE_APP);
}, 60_000);
