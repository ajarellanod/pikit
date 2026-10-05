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

/** admin-api's stand-in has a Worker half, as the real one: on Cloudflare `add` puts it in `export const worker`. */
const WORKER_HALF = 'export const worker = defineComponent({\n  name: "admin-api-worker",\n  setup() {},\n});\n';
const NOTHING = { provides: [], requires: [], optional: [] };
/** How each stand-in goes in a Cloudflare project's Apps, as the real ones' manifests say. */
const APPS: Record<string, Record<string, unknown>> = {
  "admin-auth-token": { apps: { worker: "default" } },
  "admin-api": { apps: { worker: "worker" }, halves: { default: NOTHING, worker: NOTHING } },
};

/**
 * A registry with stand-ins for admin-auth-token and admin-api (on both targets, each in its Apps on
 * Cloudflare), `log-viewer` (a component with a view), and a dashboard of `files`.
 */
function registry(files: Record<string, string>): string {
  const root = temp();
  const index: { version: 1; components: Record<string, unknown> } = { version: 1, components: {} };
  const targets = ["server", "durable"];
  for (const name of ["admin-auth-token", "admin-api", "log-viewer"]) {
    const dir = join(root, "components", name);
    mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
    writeFileSync(join(dir, "files", "src", "pikit", name, "index.ts"), `${INDEX(name)}${name === "admin-api" ? `\n${WORKER_HALF}` : ""}`);
    const view = name === "log-viewer" ? { view: "view" } : {};
    if (name === "log-viewer") {
      mkdirSync(join(dir, "view"));
      writeFileSync(join(dir, "view", "index.tsx"), VIEW);
    }
    writeFileSync(
      join(dir, "component.json"),
      JSON.stringify({
        name, version: "0.1.0", description: name, targets, requires: { pikit: "0.0.0", capabilities: [] },
        optional: { capabilities: [] }, provides: [], ...APPS[name], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...view,
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
  expect(Object.keys(project.components).sort()).toEqual(["admin-api", "admin-auth-token"]);
  expect(project.dashboard.components).toEqual(["admin-auth-token", "admin-api"]);
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

test("ui on, on Cloudflare: admin-auth-token in both Apps, admin-api's object half in the default App and its Worker half in the Worker's", async () => {
  const dir = project(registry(DASHBOARD), ["durable"]);

  const on = await runCli(["ui", "on", "--yes"], dir);

  expect(on.code).toBe(0);
  expect(manifest(dir).dashboard.components).toEqual(["admin-auth-token", "admin-api"]);
  const config = read(dir, "pikit.config.ts");
  expect(config).toContain('import adminApi, { worker as adminApiWorker } from "./src/pikit/admin-api/index.ts";');
  expect(config).toContain("export default defineApp({\n  components: [\n    adminAuthToken,\n    adminApi,\n  ],");
  expect(config).toContain("export const worker = defineApp({\n  components: [\n    adminAuthToken,\n    adminApiWorker,\n  ],");
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

test("a component's view goes to src/dashboard/src/views/<name>/ when the project has a UI, recorded as its own, and leaves with it", async () => {
  const { dir } = await withUi();
  const view = "src/dashboard/src/views/log-viewer/index.tsx";

  const add = await runCli(["add", "log-viewer", "--yes"], dir);
  expect(add.code).toBe(0);
  expect(add.out).not.toContain("It also writes");
  expect(read(dir, view)).toBe(VIEW);
  expect(manifest(dir).components["log-viewer"].files[view]).toEqual({ hash: hashOf(VIEW) });

  const remove = await runCli(["remove", "log-viewer"], dir);
  expect(remove.code).toBe(0);
  expect(existsSync(join(dir, view))).toBe(false);
});

test("without a UI a component's view is not installed; ui on adds it, ui off takes it back out", async () => {
  const root = registry(DASHBOARD);
  const dir = project(root);
  const view = "src/dashboard/src/views/log-viewer/index.tsx";
  expect((await runCli(["add", "log-viewer", "--yes"], dir)).code).toBe(0);
  expect(existsSync(join(dir, "src/dashboard"))).toBe(false);
  const before = snapshot(dir);

  expect((await runCli(["ui", "on", "--yes"], dir)).code).toBe(0);
  expect(read(dir, view)).toBe(VIEW);
  expect(manifest(dir).components["log-viewer"].files[view]).toEqual({ hash: hashOf(VIEW) });
  // Its view is the component's, not yours: `ui off` is not held up by it.
  const off = await runCli(["ui", "off", "--yes"], dir);
  expect(off.code).toBe(0);
  expect(manifest(dir).components["log-viewer"].files[view]).toBeUndefined();
  expect(snapshot(dir)).toEqual(before);
});
