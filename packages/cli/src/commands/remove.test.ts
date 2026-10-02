/**
 * `pikit add` then `pikit remove`, run as a user runs them, on what P3 asks: removing leaves the
 * project as it was, after a reinstall (`add --force`) too. A remove that fails once writing began puts back what it wrote, and what was
 * installed for a component goes with it even when `pikit doctor` then reports a problem. The
 * projects have this CLI's kit, with `@pikit/core` and `@pikit/contracts` linked as `bun install`
 * would, so both run to the end without the network; the one `bun install` here is made to fail.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { OPERATION_MARKER } from "../project/operation.ts";
import { emptyManifest, hashOf, writeProjectManifest } from "../project/pikit-json.ts";
import { kitCommit, kitSpecifier } from "../project/vendor.ts";
import { runCli } from "../testing/cli.ts";

const PACKAGES = join(import.meta.dir, "..", "..", "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-remove-test-"));
  dirs.push(dir);
  return dir;
};

/** A project on this CLI's kit (recorded), which already depends on `@pikit/contracts`. */
function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest(undefined, kitCommit()));
  mkdirSync(join(dir, "src"));
  const contracts = kitSpecifier("@pikit/contracts");
  mkdirSync(join(dir, "vendor"));
  writeFileSync(join(dir, contracts.slice("file:".length)), "this CLI's kit");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "project", dependencies: { "@pikit/contracts": contracts } }, null, 2)}\n`);
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  for (const kit of ["core", "contracts"]) symlinkSync(join(PACKAGES, kit), join(dir, "node_modules", "@pikit", kit));
  return dir;
}

/** A registry holding a copy of log-events. */
function logEventsRegistry(): string {
  const root = temp();
  cpSync(join(DEFAULT_REGISTRY, "components", "log-events"), join(root, "components", "log-events"), { recursive: true });
  const index = { "log-events": { version: "0.0.0", description: "log-events", targets: ["server", "durable"], path: "components/log-events" } };
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
  return root;
}

/** Changes the registry's log-events: fields of its manifest, and files of its own directory (undefined deletes one). */
function editLogEvents(root: string, fields: Record<string, unknown>, files: Record<string, string | undefined> = {}): void {
  const dir = join(root, "components", "log-events");
  const manifest = JSON.parse(readFileSync(join(dir, "component.json"), "utf8"));
  writeFileSync(join(dir, "component.json"), JSON.stringify({ ...manifest, ...fields }));
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, "files", "src", "pikit", "log-events", file);
    if (text === undefined) rmSync(path);
    else writeFileSync(path, text);
  }
}

const variable = (name: string) => ({ name, secret: false, required: false, description: `${name}, for the test.` });

/** Every file under `dir` (node_modules aside) → its content: equal snapshots are byte-identical trees. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const relative = `${prefix}${entry}`;
    if (relative === "node_modules") continue;
    if (statSync(join(dir, relative)).isDirectory()) {
      files[`${relative}/`] = "";
      Object.assign(files, snapshot(dir, `${relative}/`));
    } else files[relative] = readFileSync(join(dir, relative), "latin1");
  }
  return files;
}

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));

test("a remove whose bun install fails puts back what it wrote: config, files, .env.example, pikit.json, bases, package.json, bun.lock", async () => {
  const dir = project();
  const registry = logEventsRegistry();
  editLogEvents(registry, { environment: [variable("FOO")] });
  const added = await runCli(["add", "log-events", "--registry", registry, "--yes"], dir);
  expect(added.code).toBe(0);
  // A package only log-events has: removing it runs `bun install`, which fails here at once (the
  // project's own `is-odd` resolves nowhere).
  const manifest = readManifest(dir);
  manifest.components["log-events"].dependencies["left-pad"] = "1.3.0";
  manifest.components["log-events"].addedDependencies = ["left-pad"];
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "is-odd": "3.0.1", "left-pad": "1.3.0" } }));
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const before = snapshot(dir);
  expect(before[".env.example"]).toContain("FOO=");
  expect(before["pikit.config.ts"]).toContain("logEvents");
  expect(Object.keys(before).some((file) => file.startsWith("pikit-bases/") && file !== "pikit-bases/")).toBe(true);

  const run = await runCli(["remove", "log-events"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("nothing was removed");
  expect(run.err).toContain(`node_modules may not be: run \`bun install\`); check the project, then delete ${OPERATION_MARKER}`);
  // The files are back; the marker stays, since `bun install` ran and node_modules is not put back.
  const { [OPERATION_MARKER]: marker, ...after } = snapshot(dir);
  expect(after).toEqual(before);
  expect(JSON.parse(marker as string).command).toBe("pikit remove log-events");

  // Until it is deleted, remove refuses before anything else.
  const refused = await runCli(["remove", "log-events"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("`pikit remove log-events`");
  expect(refused.err).toContain("did not finish");
  expect(refused.err).not.toContain("bun install` failed");
  expect(snapshot(dir)).toEqual({ ...before, [OPERATION_MARKER]: marker as string });
}, 120_000);

test("a remove that fails before bun install puts back what it wrote and leaves no marker", async () => {
  if (process.getuid?.() === 0) return; // root writes in a read-only directory
  const dir = project();
  const registry = logEventsRegistry();
  expect((await runCli(["add", "log-events", "--registry", registry, "--yes"], dir)).code).toBe(0);
  const before = snapshot(dir);
  // Its bases cannot be deleted: the removal fails once the config, the files and pikit.json are written.
  chmodSync(join(dir, "pikit-bases"), 0o555);
  try {
    const run = await runCli(["remove", "log-events"], dir);
    expect(run.code).toBe(1);
    expect(run.err).toContain("nothing was removed: the project's files are back as they were");
    expect(run.err).not.toContain(OPERATION_MARKER);
  } finally {
    chmodSync(join(dir, "pikit-bases"), 0o755);
  }
  expect(snapshot(dir)).toEqual(before);
  expect((await runCli(["remove", "log-events"], dir)).code).toBe(0);
}, 120_000);

test("remove takes out only the packages add put in package.json: one the project had stays, one another component added is shared", async () => {
  const dir = project();
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "is-odd": "3.0.1", "left-pad": "1.3.0" } }, null, 2)}\n`);
  const registry = logEventsRegistry();
  editLogEvents(registry, { dependencies: { "@pikit/contracts": "0.0.0", "is-odd": "3.0.1", "left-pad": "1.3.0" } });
  // Another component put left-pad there; the project had @pikit/contracts and is-odd.
  const manifest = readManifest(dir);
  manifest.components["tool-other"] = {
    registry: "default", version: "0.0.0", files: {}, dependencies: { "left-pad": "1.3.0" }, addedDependencies: ["left-pad"], environment: [],
  };
  // Known already: add records a registry it does not know.
  manifest.registries.local = registry;
  writeProjectManifest(dir, manifest);
  const before = snapshot(dir);

  expect((await runCli(["add", "log-events", "--registry", registry, "--yes"], dir)).code).toBe(0);
  expect(readManifest(dir).components["log-events"].addedDependencies).toEqual(["left-pad"]);
  // Removed, it takes nothing out: tool-other still declares left-pad. The project is as it was.
  const removed = await runCli(["remove", "log-events"], dir);
  expect(removed.code).toBe(0);
  expect(removed.out).not.toContain("the npm packages only it used");
  expect(snapshot(dir)).toEqual(before);
}, 120_000);

test("a reinstall deletes a file the new version no longer ships and replaces its .env.example block; remove then leaves no trace", async () => {
  const dir = project();
  const registry = logEventsRegistry();
  const extra = join(dir, "src", "pikit", "log-events", "extra.ts");
  editLogEvents(registry, { environment: [variable("FOO")] }, { "extra.ts": "export const extra = 1;\n" });
  expect((await runCli(["add", "log-events", "--registry", registry, "--yes"], dir)).code).toBe(0);
  expect(existsSync(extra)).toBe(true);
  expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("FOO=");

  editLogEvents(registry, { environment: [variable("BAR")] }, { "extra.ts": undefined });
  const reinstall = await runCli(["add", "log-events", "--registry", registry, "--yes", "--force"], dir);
  expect(reinstall.code).toBe(0);
  expect(reinstall.out).toContain("deletes, no longer shipped: src/pikit/log-events/extra.ts");
  expect(existsSync(extra)).toBe(false);
  const record = readManifest(dir).components["log-events"];
  expect(Object.keys(record.files)).not.toContain("src/pikit/log-events/extra.ts");
  expect(record.environment.map((v: { name: string }) => v.name)).toEqual(["BAR"]);
  const example = readFileSync(join(dir, ".env.example"), "utf8");
  expect(example).toBe("# log-events\n# BAR, for the test. (optional)\nBAR=\n");
  // The base of the file it no longer ships went with it.
  expect(readdirSync(join(dir, "pikit-bases")).length).toBe(Object.keys(record.files).length);

  expect((await runCli(["remove", "log-events"], dir)).code).toBe(0);
  expect(readdirSync(join(dir, "src"))).toEqual([]);
  expect(existsSync(join(dir, ".env.example"))).toBe(false);
  expect(existsSync(join(dir, "pikit-bases"))).toBe(false);
}, 120_000);

test("a reinstall keeps a file the user modified that the new version no longer ships; remove asks for --force before deleting it", async () => {
  const dir = project();
  const registry = logEventsRegistry();
  const extra = join(dir, "src", "pikit", "log-events", "extra.ts");
  editLogEvents(registry, {}, { "extra.ts": "export const extra = 1;\n" });
  expect((await runCli(["add", "log-events", "--registry", registry, "--yes"], dir)).code).toBe(0);
  writeFileSync(extra, "export const extra = 2; // mine\n");
  const installed = readManifest(dir).components["log-events"].files["src/pikit/log-events/extra.ts"];

  editLogEvents(registry, {}, { "extra.ts": undefined });
  const reinstall = await runCli(["add", "log-events", "--registry", registry, "--yes", "--force"], dir);
  expect(reinstall.code).toBe(0);
  expect(reinstall.err).toContain("log-events 0.0.0 no longer ships src/pikit/log-events/extra.ts, which you modified: it is kept");
  expect(reinstall.out).not.toContain("deletes, no longer shipped");
  expect(readFileSync(extra, "utf8")).toBe("export const extra = 2; // mine\n");
  // Still recorded as installed, with its base: remove and a future upgrade see it as the user's edit.
  expect(readManifest(dir).components["log-events"].files["src/pikit/log-events/extra.ts"]).toEqual(installed);
  expect(existsSync(join(dir, "pikit-bases", installed.hash.slice("sha256:".length)))).toBe(true);

  const refused = await runCli(["remove", "log-events"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("you modified these files of log-events; pass --force to delete them anyway:\n  src/pikit/log-events/extra.ts");
  expect((await runCli(["remove", "log-events", "--force"], dir)).code).toBe(0);
  expect(existsSync(extra)).toBe(false);
}, 120_000);

test("what was installed for a component goes with it, and then doctor reports what it finds", async () => {
  const dir = project();
  expect((await runCli(["add", "log-events", "--yes"], dir)).code).toBe(0);
  // A provider installed for log-events, which nothing uses; and a problem doctor finds after the removal.
  const file = "src/pikit/tool-extra/index.ts";
  mkdirSync(join(dir, "src", "pikit", "tool-extra"), { recursive: true });
  writeFileSync(join(dir, file), "export const extra = 1;\n");
  const manifest = readManifest(dir);
  manifest.components["tool-extra"] = {
    installedFor: ["log-events"], registry: "default", version: "0.0.0", files: { [file]: { hash: hashOf("export const extra = 1;\n") } }, dependencies: {}, environment: [],
  };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  // Built in two pieces: this test's own imports are checked (scripts/boundaries.ts).
  const pi = ["@earendil-works", "pi-ai"].join("/");
  writeFileSync(join(dir, "src", "bad.ts"), `import ${JSON.stringify(pi)};\n`);

  const run = await runCli(["remove", "log-events"], dir);
  expect(run.out).toContain("log-events removed");
  expect(run.out).toContain("tool-extra was installed for log-events, and nothing uses it now");
  expect(run.out).toContain("tool-extra removed");
  expect(run.code).toBe(1);
  expect(run.err).toContain(`src/bad.ts imports "${pi}"`);
  expect(Object.keys(readManifest(dir).components)).toEqual([]);
  expect(existsSync(join(dir, "src", "pikit"))).toBe(false);
  // Doctor's problems are the project's: the removal itself finished.
  expect(existsSync(join(dir, OPERATION_MARKER))).toBe(false);
}, 120_000);

/** log-events added, and `tool-extra` recorded as installed for it, with `content` as installed; `pikit.json` is returned. */
async function withProviderFor(dir: string, content = "export const extra = 1;\n"): Promise<{ file: string; manifest: ReturnType<typeof readManifest> }> {
  expect((await runCli(["add", "log-events", "--yes"], dir)).code).toBe(0);
  const file = "src/pikit/tool-extra/index.ts";
  mkdirSync(join(dir, "src", "pikit", "tool-extra"), { recursive: true });
  writeFileSync(join(dir, file), content);
  const manifest = readManifest(dir);
  manifest.components["tool-extra"] = {
    installedFor: ["log-events"], registry: "default", version: "0.0.0", files: { [file]: { hash: hashOf("export const extra = 1;\n") } }, dependencies: {}, environment: [],
  };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  return { file, manifest };
}

test("--force is for the component named: a provider installed for it whose files you modified stays, on its own", async () => {
  const dir = project();
  const { file } = await withProviderFor(dir, "export const extra = 2; // mine\n");

  const run = await runCli(["remove", "log-events", "--force"], dir);
  expect(run.out).toContain("log-events removed");
  expect(run.out).toContain("tool-extra was installed for log-events, and nothing uses it now");
  expect(run.err).toContain(`tool-extra stays installed, on its own: you modified these files of tool-extra; pass --force to delete them anyway:\n  ${file}`);
  expect(run.out).not.toContain("tool-extra removed");
  expect(run.code).toBe(0);
  expect(readFileSync(join(dir, file), "utf8")).toBe("export const extra = 2; // mine\n");
  const components = readManifest(dir).components;
  expect(Object.keys(components)).toEqual(["tool-extra"]);
  expect(components["tool-extra"].installedFor).toBeUndefined();
  expect(existsSync(join(dir, OPERATION_MARKER))).toBe(false);
}, 120_000);

test("when the app does not compose, what was installed for the component stays, on its own: nothing tells it is unused", async () => {
  const dir = project();
  const { file } = await withProviderFor(dir);
  // The probe cannot load the core: the app does not compose.
  rmSync(join(dir, "node_modules", "@pikit", "core"));

  const run = await runCli(["remove", "log-events", "--force"], dir);
  expect(run.out).toContain("log-events removed");
  expect(run.err).toContain("tool-extra was installed for log-events; the app does not compose, so whether anything uses it is unknown: it stays installed, on its own");
  expect(run.out).not.toContain("tool-extra removed");
  // Doctor reports the composition; the removal finished.
  expect(run.code).toBe(1);
  expect(run.err).toContain("pikit.config.ts does not compose");
  expect(existsSync(join(dir, file))).toBe(true);
  const components = readManifest(dir).components;
  expect(Object.keys(components)).toEqual(["tool-extra"]);
  expect(components["tool-extra"].installedFor).toBeUndefined();
  expect(existsSync(join(dir, OPERATION_MARKER))).toBe(false);
}, 120_000);

test("a failure after the component itself was removed leaves the marker: the provider installed for it is put back, the component stays removed", async () => {
  const dir = project();
  const { file, manifest } = await withProviderFor(dir);
  // Removing tool-extra takes out a package only it added: `bun install` runs, and fails at once.
  manifest.components["tool-extra"].dependencies = { "left-pad": "1.3.0" };
  manifest.components["tool-extra"].addedDependencies = ["left-pad"];
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "is-odd": "3.0.1", "left-pad": "1.3.0" } }));
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');

  const run = await runCli(["remove", "log-events"], dir);
  expect(run.out).toContain("log-events removed");
  expect(run.code).toBe(1);
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("tool-extra was not removed: its files are back as they were (node_modules may not be: run `bun install`)");
  expect(run.err).toContain(`log-events was removed, but not all that was installed for it: check the project, then delete ${OPERATION_MARKER}`);
  expect(JSON.parse(readFileSync(join(dir, OPERATION_MARKER), "utf8")).command).toBe("pikit remove log-events");
  expect(existsSync(join(dir, file))).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["left-pad"]).toBe("1.3.0");
  expect(Object.keys(readManifest(dir).components)).toEqual(["tool-extra"]);
  expect(existsSync(join(dir, "src", "pikit", "log-events"))).toBe(false);
}, 120_000);
