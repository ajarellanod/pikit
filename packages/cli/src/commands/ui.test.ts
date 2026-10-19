/**
 * `pikit ui on | off` and the dashboard's upgrade, run as a user runs them, against a local registry
 * with a small dashboard (`dashboard/files/`) and stand-ins for the components it needs. The project
 * has no kit tarballs and `@pikit/core` linked, so nothing needs the network; the dashboard has no
 * `package.json`, so no `bun install` runs in it.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, hashOf, writeProjectManifest } from "../project/pikit-json.ts";
import { runCli } from "../testing/cli.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-ui-test-"));
  dirs.push(dir);
  return dir;
};

const INDEX = (name: string) => `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "${name}",\n  setup() {},\n});\n`;
const LINES = Array.from({ length: 10 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
const lines = (edits: Record<number, string> = {}) => `${LINES.map((line, i) => edits[i + 1] ?? line).join("\n")}\n`;

/** The view `log-viewer` ships (its manifest's `view`). */
const VIEW = 'export default { id: "log-viewer", title: "Logs", pages: [] };\n';
/** The section of the Settings dialog `log-viewer` ships (its manifest's `settings`). */
const SECTION = 'export default { id: "log-viewer", title: "Logs", component: () => null };\n';

/** admin-api's and settings-store's stand-ins have a Worker half, as the real ones: on Cloudflare `add` puts it in `export const worker`. */
const WORKER_HALF = (name: string) => `export const worker = defineComponent({\n  name: "${name}-worker",\n  setup() {},\n});\n`;
const NOTHING = { provides: [], requires: [], optional: [] };
/** How each stand-in goes in a Cloudflare project's Apps, as the real ones' manifests say. */
const APPS: Record<string, Record<string, unknown>> = {
  "admin-auth-token": { apps: { worker: "default" } },
  "admin-auth-sso": { apps: { worker: "default" } },
  "settings-file": { apps: { worker: "default" } },
  "admin-api": { apps: { worker: "worker" }, halves: { default: NOTHING, worker: NOTHING } },
  "settings-store": { apps: { worker: "worker" }, halves: { default: NOTHING, worker: NOTHING } },
};

/** Other providers of what admin-auth-token and settings-store stand for, in both Apps on Cloudflare: their code provides it. */
const ALTERNATIVES: Record<string, string> = { "admin-auth-sso": "admin.auth", "settings-file": "settings" };
const PROVIDER = (name: string, capability: string) =>
  `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "${name}",\n  setup(pikit) {\n    pikit.provide("${capability}", {});\n  },\n});\n`;

/**
 * A registry with stand-ins for admin-auth-token, admin-api and settings-store (on both targets, each
 * in its Apps on Cloudflare), other providers of admin.auth and settings (`ALTERNATIVES`), `log-viewer`
 * (a component with a view and a Settings section), and a dashboard of `files`.
 */
function registry(files: Record<string, string>): string {
  const root = temp();
  const index: { version: 1; components: Record<string, unknown> } = { version: 1, components: {} };
  const targets = ["server", "durable"];
  for (const name of ["admin-auth-token", "admin-api", "settings-store", "log-viewer", ...Object.keys(ALTERNATIVES)]) {
    const dir = join(root, "components", name);
    mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
    const alternative = ALTERNATIVES[name];
    const code = alternative === undefined ? `${INDEX(name)}${APPS[name]?.halves !== undefined ? `\n${WORKER_HALF(name)}` : ""}` : PROVIDER(name, alternative);
    writeFileSync(join(dir, "files", "src", "pikit", name, "index.ts"), code);
    const view = name === "log-viewer" ? { view: "view", settings: "settings" } : {};
    if (name === "log-viewer") {
      mkdirSync(join(dir, "view"));
      writeFileSync(join(dir, "view", "index.tsx"), VIEW);
      mkdirSync(join(dir, "settings"));
      writeFileSync(join(dir, "settings", "index.tsx"), SECTION);
    }
    writeFileSync(
      join(dir, "component.json"),
      JSON.stringify({
        name, version: "0.1.0", description: name, targets, requires: { pikit: "0.0.1", capabilities: [] },
        optional: { capabilities: [] }, provides: alternative === undefined ? [] : [alternative], ...APPS[name], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...view,
      }),
    );
    index.components[name] = { version: "0.1.0", description: name, targets, path: `components/${name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify(index));
  ship(root, files);
  return root;
}

/** Replaces the registry's dashboard with `files`. */
function ship(root: string, files: Record<string, string>): void {
  rmSync(join(root, "dashboard"), { recursive: true, force: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, "dashboard", "files", file, ".."), { recursive: true });
    writeFileSync(join(root, "dashboard", "files", file), text);
  }
}

/** A project whose default registry is `registryRoot`, on `targets`. */
function project(registryRoot: string, targets = ["server"]): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest(registryRoot, undefined, targets));
  writeFileSync(join(dir, "package.json"), '{ "name": "with-ui", "dependencies": {} }\n');
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  const worker = '\nexport const workerConfig = {};\n\nexport const worker = defineApp({\n  components: [\n  ],\n  config: workerConfig,\n});\n';
  writeFileSync(
    join(dir, "pikit.config.ts"),
    `import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n${targets.includes("durable") ? worker : ""}`,
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

const DASHBOARD = { "README.md": "# the dashboard\n", "src/app.tsx": lines(), "src/views/home/index.tsx": "export const home = 1;\n" };
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const manifest = (dir: string) => JSON.parse(read(dir, "pikit.json"));
const bases = (dir: string) => (existsSync(join(dir, "pikit-bases")) ? readdirSync(join(dir, "pikit-bases")).sort() : []);
const baseOf = (text: string) => hashOf(text).slice("sha256:".length);

/** Every file under `dir` (node_modules aside) → its content. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const relative = `${prefix}${entry}`;
    if (relative === "node_modules") continue;
    if (statSync(join(dir, relative)).isDirectory()) Object.assign(files, snapshot(dir, `${relative}/`));
    else files[relative] = readFileSync(join(dir, relative), "latin1");
  }
  return files;
}

async function withUi(files: Record<string, string> = DASHBOARD): Promise<{ dir: string; root: string }> {
  const root = registry(files);
  const dir = project(root);
  const on = await runCli(["ui", "on", "--yes"], dir);
  expect(on.out).toContain(`src/dashboard/ written: ${Object.keys(files).length} files`);
  expect(on.code).toBe(0);
  return { dir, root };
}

test("ui on: the components it needs, then src/dashboard/ with its bases and its record; run again, it is done", async () => {
  const { dir } = await withUi();

  for (const [file, text] of Object.entries(DASHBOARD)) expect(read(dir, `src/dashboard/${file}`)).toBe(text);
  const project = manifest(dir);
  expect(Object.keys(project.components).sort()).toEqual(["admin-api", "admin-auth-token", "settings-store"]);
  expect(project.dashboard.components).toEqual(["admin-auth-token", "admin-api", "settings-store"]);
  expect(project.dashboard.files).toEqual(Object.fromEntries(Object.entries(DASHBOARD).map(([file, text]) => [`src/dashboard/${file}`, { hash: hashOf(text) }])));
  for (const text of Object.values(DASHBOARD)) expect(bases(dir)).toContain(baseOf(text));
  expect(read(dir, "pikit.config.ts")).toContain('"./src/pikit/admin-api/index.ts"');

  const again = await runCli(["ui", "on", "--yes"], dir);
  expect(again.out).toContain("the project has a UI");
  expect(again.code).toBe(0);
});

test("ui off puts the project back as it was before ui on", async () => {
  const root = registry(DASHBOARD);
  const dir = project(root);
  const before = snapshot(dir);
  expect((await runCli(["ui", "on", "--yes"], dir)).code).toBe(0);

  const off = await runCli(["ui", "off", "--yes"], dir);

  expect(off.out).toContain("src/dashboard/ deleted");
  expect(off.code).toBe(0);
  expect(snapshot(dir)).toEqual(before);
});

test("ui off keeps your edits and your own views unless --force", async () => {
  const { dir } = await withUi();
  writeFileSync(join(dir, "src/dashboard/src/app.tsx"), lines({ 2: "export const line2 = 'mine';" }));
  mkdirSync(join(dir, "src/dashboard/src/views/memory"));
  writeFileSync(join(dir, "src/dashboard/src/views/memory/index.tsx"), "export const memory = 1;\n");
  // What its toolchain makes is not yours: never in the way.
  mkdirSync(join(dir, "src/dashboard/dist"));
  writeFileSync(join(dir, "src/dashboard/dist/index.html"), "<html>");

  const refused = await runCli(["ui", "off", "--yes"], dir);
  expect(refused.err).toContain("src/dashboard/src/app.tsx (modified)");
  expect(refused.err).toContain("src/dashboard/src/views/memory/index.tsx (yours)");
  expect(refused.err).not.toContain("dist");
  expect(refused.code).toBe(1);
  expect(existsSync(join(dir, "src/dashboard/src/views/memory/index.tsx"))).toBe(true);
  expect(manifest(dir).dashboard).toBeDefined();

  const forced = await runCli(["ui", "off", "--yes", "--force"], dir);
  expect(forced.code).toBe(0);
  expect(existsSync(join(dir, "src/dashboard"))).toBe(false);
  expect(manifest(dir).dashboard).toBeUndefined();
  expect(manifest(dir).components).toEqual({});
});

test("ui on refuses a src/dashboard/ that is not pikit's (unless --force)", async () => {
  const root = registry(DASHBOARD);
  const dir = project(root);
  mkdirSync(join(dir, "src/dashboard"), { recursive: true });
  writeFileSync(join(dir, "src/dashboard/notes.md"), "mine\n");

  const refused = await runCli(["ui", "on", "--yes"], dir);
  expect(refused.err).toContain("src/dashboard/ exists and is not pikit's dashboard");
  expect(refused.code).toBe(1);
  expect(manifest(dir).components).toEqual({});
});

test("ui on, on Cloudflare: admin-auth-token in both Apps, admin-api's and settings-store's object halves in the default App and their Worker halves in the Worker's", async () => {
  const dir = project(registry(DASHBOARD), ["durable"]);

  const on = await runCli(["ui", "on", "--yes"], dir);

  expect(on.code).toBe(0);
  expect(manifest(dir).dashboard.components).toEqual(["admin-auth-token", "admin-api", "settings-store"]);
  const config = read(dir, "pikit.config.ts");
  expect(config).toContain('import adminApi, { worker as adminApiWorker } from "./src/pikit/admin-api/index.ts";');
  expect(config).toContain('import settingsStore, { worker as settingsStoreWorker } from "./src/pikit/settings-store/index.ts";');
  expect(config).toContain("export default defineApp({\n  components: [\n    adminAuthToken,\n    adminApi,\n    settingsStore,\n  ],");
  expect(config).toContain("export const worker = defineApp({\n  components: [\n    adminAuthToken,\n    adminApiWorker,\n    settingsStoreWorker,\n  ],");
});

test("pikit upgrade merges the dashboard's new version with your edits, adds new files, deletes those no longer shipped", async () => {
  const { dir, root } = await withUi();
  writeFileSync(join(dir, "src/dashboard/src/app.tsx"), lines({ 2: "export const line2 = 'mine';" }));
  const next = { "README.md": DASHBOARD["README.md"], "src/app.tsx": lines({ 9: "export const line9 = 'theirs';" }), "src/views/inbox/index.tsx": "export const inbox = 1;\n" };
  ship(root, next);

  const run = await runCli(["upgrade", "--yes"], dir);

  expect(run.out).toContain("merged with your edits: src/dashboard/src/app.tsx\n");
  expect(run.out).toContain("added: src/dashboard/src/views/inbox/index.tsx\n");
  expect(run.out).toContain("deleted, no longer shipped: src/dashboard/src/views/home/index.tsx\n");
  expect(run.code).toBe(0);
  expect(read(dir, "src/dashboard/src/app.tsx")).toBe(lines({ 2: "export const line2 = 'mine';", 9: "export const line9 = 'theirs';" }));
  expect(read(dir, "src/dashboard/src/views/inbox/index.tsx")).toBe(next["src/views/inbox/index.tsx"]);
  expect(existsSync(join(dir, "src/dashboard/src/views/home/index.tsx"))).toBe(false);
  // Recorded as the registry ships it now, with its bases; the base only the old version had is gone.
  expect(manifest(dir).dashboard.files).toEqual(Object.fromEntries(Object.entries(next).map(([file, text]) => [`src/dashboard/${file}`, { hash: hashOf(text) }])));
  for (const text of Object.values(next)) expect(bases(dir)).toContain(baseOf(text));
  expect(bases(dir)).not.toContain(baseOf(DASHBOARD["src/views/home/index.tsx"]));

  const again = await runCli(["upgrade", "--yes"], dir);
  expect(again.out).toContain("the dashboard is up to date with its registry");
  expect(again.code).toBe(0);
});

test("pikit upgrade writes a conflict in the dashboard with markers, names it and ends with code 1", async () => {
  const { dir, root } = await withUi();
  writeFileSync(join(dir, "src/dashboard/src/app.tsx"), lines({ 9: "export const line9 = 'mine';" }));
  ship(root, { ...DASHBOARD, "src/app.tsx": lines({ 9: "export const line9 = 'theirs';" }) });

  const run = await runCli(["upgrade", "--yes"], dir);

  expect(run.err).toContain("these files of the dashboard have conflicts");
  expect(run.err).toContain("src/dashboard/src/app.tsx");
  expect(run.code).toBe(1);
  const text = read(dir, "src/dashboard/src/app.tsx");
  expect(text).toContain("<<<<<<< yours\nexport const line9 = 'mine';\n=======\nexport const line9 = 'theirs';\n>>>>>>> dashboard@");
});

test("pikit doctor names the dashboard's edited and deleted files; a lockfile its bun install rewrote is not an edit", async () => {
  const { dir } = await withUi({ ...DASHBOARD, "bun.lock": "{ lock: 1 }\n" });
  writeFileSync(join(dir, "src/dashboard/src/app.tsx"), lines({ 2: "export const line2 = 'mine';" }));
  rmSync(join(dir, "src/dashboard/README.md"));
  writeFileSync(join(dir, "src/dashboard/bun.lock"), "{ lock: 2 }\n");

  const doctor = await runCli(["doctor"], dir);
  expect(doctor.out).toContain("modified: src/dashboard/src/app.tsx (dashboard)");
  expect(doctor.out).toContain("deleted: src/dashboard/README.md (dashboard)");
  expect(doctor.out).not.toContain("src/dashboard/bun.lock");

  // Only the real edit holds up `ui off`.
  const off = await runCli(["ui", "off", "--yes"], dir);
  expect(off.err).toContain("src/dashboard/src/app.tsx (modified)");
  expect(off.err).not.toContain("bun.lock");
});

test("a component's view goes to src/dashboard/src/views/<name>/ and its Settings section to src/dashboard/src/settings/<name>/ when the project has a UI, recorded as its own, and leave with it", async () => {
  const { dir } = await withUi();
  const view = "src/dashboard/src/views/log-viewer/index.tsx";
  const section = "src/dashboard/src/settings/log-viewer/index.tsx";

  const add = await runCli(["add", "log-viewer", "--yes"], dir);
  expect(add.code).toBe(0);
  expect(add.out).not.toContain("It also writes");
  expect(read(dir, view)).toBe(VIEW);
  expect(read(dir, section)).toBe(SECTION);
  expect(manifest(dir).components["log-viewer"].files[view]).toEqual({ hash: hashOf(VIEW) });
  expect(manifest(dir).components["log-viewer"].files[section]).toEqual({ hash: hashOf(SECTION) });

  const remove = await runCli(["remove", "log-viewer"], dir);
  expect(remove.code).toBe(0);
  expect(existsSync(join(dir, view))).toBe(false);
  expect(existsSync(join(dir, "src/dashboard/src/settings/log-viewer"))).toBe(false);
});

test("pikit upgrade merges a component's new Settings section with your edits", async () => {
  const { dir, root } = await withUi();
  const section = "src/dashboard/src/settings/log-viewer/index.tsx";
  expect((await runCli(["add", "log-viewer", "--yes"], dir)).code).toBe(0);
  writeFileSync(join(dir, section), `// mine\n${SECTION}`);
  writeFileSync(join(root, "components/log-viewer/settings/index.tsx"), `${SECTION}// theirs\n`);
  const shipped = JSON.parse(read(root, "components/log-viewer/component.json"));
  writeFileSync(join(root, "components/log-viewer/component.json"), JSON.stringify({ ...shipped, version: "0.2.0" }));
  const index = JSON.parse(read(root, "registry.json"));
  index.components["log-viewer"].version = "0.2.0";
  writeFileSync(join(root, "registry.json"), JSON.stringify(index));

  const run = await runCli(["upgrade", "log-viewer", "--yes"], dir);

  expect(run.code).toBe(0);
  expect(read(dir, section)).toBe(`// mine\n${SECTION}// theirs\n`);
});

test("without a UI a component's view is not installed; ui on adds it, ui off takes it back out", async () => {
  const root = registry(DASHBOARD);
  const dir = project(root);
  const view = "src/dashboard/src/views/log-viewer/index.tsx";
  const section = "src/dashboard/src/settings/log-viewer/index.tsx";
  expect((await runCli(["add", "log-viewer", "--yes"], dir)).code).toBe(0);
  expect(existsSync(join(dir, "src/dashboard"))).toBe(false);
  const before = snapshot(dir);

  expect((await runCli(["ui", "on", "--yes"], dir)).code).toBe(0);
  expect(read(dir, view)).toBe(VIEW);
  expect(read(dir, section)).toBe(SECTION);
  expect(manifest(dir).components["log-viewer"].files[view]).toEqual({ hash: hashOf(VIEW) });
  expect(manifest(dir).components["log-viewer"].files[section]).toEqual({ hash: hashOf(SECTION) });
  // Its view is the component's, not yours: `ui off` is not held up by it.
  const off = await runCli(["ui", "off", "--yes"], dir);
  expect(off.code).toBe(0);
  expect(manifest(dir).components["log-viewer"].files[view]).toBeUndefined();
  expect(manifest(dir).components["log-viewer"].files[section]).toBeUndefined();
  expect(snapshot(dir)).toEqual(before);
});

test("ui on over another provider of admin.auth: admin-api and settings-store only, recorded as the dashboard's; ui off keeps the provider you had", async () => {
  const dir = project(registry(DASHBOARD));
  expect((await runCli(["add", "admin-auth-sso", "--yes"], dir)).code).toBe(0);

  const on = await runCli(["ui", "on", "--yes"], dir);
  expect(on.code).toBe(0);
  expect(Object.keys(manifest(dir).components).sort()).toEqual(["admin-api", "admin-auth-sso", "settings-store"]);
  expect(manifest(dir).dashboard.components).toEqual(["admin-api", "settings-store"]);
  const again = await runCli(["ui", "on", "--yes"], dir);
  expect(again.out).toContain("the project has a UI");
  expect(again.code).toBe(0);

  expect((await runCli(["ui", "off", "--yes"], dir)).code).toBe(0);
  expect(Object.keys(manifest(dir).components)).toEqual(["admin-auth-sso"]);
});

test("ui on, on Cloudflare, over another provider of settings in both Apps: admin-auth-token and admin-api only; ui off keeps it", async () => {
  const dir = project(registry(DASHBOARD), ["durable"]);
  expect((await runCli(["add", "settings-file", "--yes"], dir)).code).toBe(0);

  const on = await runCli(["ui", "on", "--yes"], dir);
  expect(on.code).toBe(0);
  expect(manifest(dir).dashboard.components).toEqual(["admin-auth-token", "admin-api"]);
  expect(manifest(dir).components["settings-store"]).toBeUndefined();

  expect((await runCli(["ui", "off", "--yes"], dir)).code).toBe(0);
  expect(Object.keys(manifest(dir).components)).toEqual(["settings-file"]);
});

/** Lists a component of the project's own in `app` of its pikit.config.ts, providing `capabilities`: composed, not installed. */
function provideOwn(dir: string, app: "default" | "worker", ...capabilities: string[]): void {
  const head = app === "default" ? "export default defineApp({\n  components: [\n" : "export const worker = defineApp({\n  components: [\n";
  const own = `    defineComponent({ name: "mine-${app}", setup(pikit) { ${capabilities.map((c) => `pikit.provide("${c}", {});`).join(" ")} } }),\n`;
  const config = read(dir, "pikit.config.ts").replace('import { defineApp } from "@pikit/core";', 'import { defineApp, defineComponent } from "@pikit/core";');
  writeFileSync(join(dir, "pikit.config.ts"), config.replace(head, `${head}${own}`));
}

test("ui on, on Cloudflare, refuses a capability provided in one App only: the default would be a second provider in the other; nothing is written", async () => {
  for (const [app, capability] of [["worker", "admin.auth"], ["default", "settings"]] as const) {
    const dir = project(registry(DASHBOARD), ["durable"]);
    provideOwn(dir, app, capability);
    const before = snapshot(dir);

    const refused = await runCli(["ui", "on", "--yes"], dir);

    expect(refused.err).toContain(`the dashboard needs ${capability} in every App`);
    expect(refused.err).toContain(app === "worker" ? "but not in the default App" : "but not in the Worker's App");
    expect(refused.code).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  }
});

test("ui on with your own provider of both, in every App: admin-api alone", async () => {
  const dir = project(registry(DASHBOARD), ["durable"]);
  for (const app of ["default", "worker"] as const) provideOwn(dir, app, "admin.auth", "settings");

  const on = await runCli(["ui", "on", "--yes"], dir);
  expect(on.code).toBe(0);
  expect(Object.keys(manifest(dir).components)).toEqual(["admin-api"]);
  expect(manifest(dir).dashboard.components).toEqual(["admin-api"]);
});

test("ui on refuses when pikit.config.ts does not compose: whether admin.auth and settings are provided is unknown, and nothing is guessed", async () => {
  const dir = project(registry(DASHBOARD));
  writeFileSync(join(dir, "pikit.config.ts"), `${read(dir, "pikit.config.ts")}\nthrow new Error("broken on purpose");\n`);
  const before = snapshot(dir);

  const refused = await runCli(["ui", "on", "--yes"], dir);

  expect(refused.err).toContain("pikit.config.ts does not compose");
  expect(refused.err).toContain("broken on purpose");
  expect(refused.err).toContain("pikit add admin-auth-token settings-store");
  expect(refused.code).toBe(1);
  expect(snapshot(dir)).toEqual(before);
});
