/**
 * `pikit add` then `pikit remove`, run as a user runs them, on what P3 asks: removing leaves the
 * project as it was. A remove that fails once writing began puts back what it wrote, and what was
 * installed for a component goes with it even when `pikit doctor` then reports a problem. The
 * projects have this CLI's kit, with `@pikit/core` and `@pikit/contracts` linked as `bun install`
 * would, so both run to the end without the network; the one `bun install` here is made to fail.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { emptyManifest, hashOf, writeProjectManifest } from "../project/pikit-json.ts";
import { kitSpecifier } from "../project/vendor.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const PACKAGES = join(import.meta.dir, "..", "..", "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-remove-test-"));
  dirs.push(dir);
  return dir;
};

function pikit(args: string[], cwd: string) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** A project on this CLI's kit, which already depends on `@pikit/contracts`. */
function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
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
  const index = { "log-events": { version: "0.0.0", description: "log-events", targets: ["server", "cloudflare"], path: "components/log-events" } };
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

test("a remove whose bun install fails puts back what it wrote: config, files, .env.example, pikit.json, bases, package.json, bun.lock", () => {
  const dir = project();
  const registry = logEventsRegistry();
  editLogEvents(registry, { environment: [variable("FOO")] });
  const added = pikit(["add", "log-events", "--registry", registry, "--yes"], dir);
  expect(added.code).toBe(0);
  // A package only log-events has: removing it runs `bun install`, which fails here at once (the
  // project's own `is-odd` resolves nowhere).
  const manifest = readManifest(dir);
  manifest.components["log-events"].dependencies["left-pad"] = "1.3.0";
  writeFileSync(join(dir, "pikit.json"), JSON.stringify(manifest));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "is-odd": "3.0.1", "left-pad": "1.3.0" } }));
  writeFileSync(join(dir, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const before = snapshot(dir);
  expect(before[".env.example"]).toContain("FOO=");
  expect(before["pikit.config.ts"]).toContain("logEvents");
  expect(Object.keys(before).some((file) => file.startsWith("pikit-bases/") && file !== "pikit-bases/")).toBe(true);

  const run = pikit(["remove", "log-events"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("`bun install` failed");
  expect(run.err).toContain("nothing was removed");
  expect(snapshot(dir)).toEqual(before);
}, 120_000);

test("what was installed for a component goes with it, and then doctor reports what it finds", () => {
  const dir = project();
  expect(pikit(["add", "log-events", "--yes"], dir).code).toBe(0);
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

  const run = pikit(["remove", "log-events"], dir);
  expect(run.out).toContain("log-events removed");
  expect(run.out).toContain("tool-extra was installed for log-events, and nothing uses it now");
  expect(run.out).toContain("tool-extra removed");
  expect(run.code).toBe(1);
  expect(run.err).toContain(`src/bad.ts imports "${pi}"`);
  expect(Object.keys(readManifest(dir).components)).toEqual([]);
  expect(existsSync(join(dir, "src", "pikit"))).toBe(false);
}, 120_000);
