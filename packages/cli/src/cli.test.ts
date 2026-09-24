/**
 * The `pikit` binary, run as a user runs it: exit codes and refusals that must happen before any
 * file is written. No `bun install`, no network. The full path (new → configure → dev, add/remove)
 * is `e2e.test.ts`.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, writeProjectManifest } from "./project/pikit-json.ts";
import { DEFAULT_REGISTRY } from "./paths.ts";
import { openRegistry } from "./project/registry-source.ts";

const MAIN = join(import.meta.dir, "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-cli-test-"));
  dirs.push(dir);
  return dir;
};

function pikit(args: string[], cwd: string) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** The smallest project `add` accepts: a manifest, a composition root, a package.json. */
function tinyProject(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest(DEFAULT_REGISTRY));
  writeFileSync(join(dir, "package.json"), '{ "name": "tiny", "dependencies": {} }\n');
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  return dir;
}

test("--version, help, unknown commands and commands of later milestones", () => {
  const cwd = temp();
  expect(pikit(["--version"], cwd).out).toMatch(/^pikit \d+\.\d+\.\d+/);
  expect(pikit(["--help"], cwd).code).toBe(0);
  expect(pikit(["frobnicate"], cwd).code).toBe(2);
  expect(pikit(["add", "--bogus"], cwd).code).toBe(2);
  const later = pikit(["upgrade"], cwd);
  expect(later.code).toBe(1);
  expect(later.out).toContain("not yet; it arrives in M3");
});

test("pikit registry validate runs the repository's registry checks", () => {
  const run = pikit(["registry", "validate"], temp());
  expect(run.out).toContain("registry validate: ok");
  expect(run.code).toBe(0);
});

test("project commands outside a project, and up with no deployment component, say what to do", () => {
  const outside = pikit(["doctor"], temp());
  expect(outside.code).toBe(1);
  expect(outside.err).toContain("is not a pikit project");

  const up = pikit(["up"], tinyProject());
  expect(up.code).toBe(1);
  expect(up.err).toContain("no deployment-* component is installed");
});

test("new with no directory asks only on a terminal; the presets it offers have titles", () => {
  const parent = temp();
  const run = pikit(["new"], parent);
  expect(run.code).toBe(2);
  expect(run.err).toContain("without <dir>, run it in a terminal: it asks");
  expect(readdirSync(parent)).toEqual([]);

  const presets = openRegistry(DEFAULT_REGISTRY).presets();
  expect(presets.map((p) => p.name)).toEqual(["http", "telegram"]);
  for (const preset of presets) expect(preset.title).not.toBe(preset.name);
});

test("new refuses a non-empty directory and an unknown preset before writing anything", () => {
  const parent = temp();
  mkdirSync(join(parent, "busy"));
  writeFileSync(join(parent, "busy", "file"), "");
  expect(pikit(["new", "busy"], parent).err).toContain("is not empty");

  const unknown = pikit(["new", "fresh", "--preset", "nope"], parent);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no preset "nope"');
  expect(existsSync(join(parent, "fresh"))).toBe(false);
});

test("add without a terminal needs --yes, and writes nothing without it", () => {
  const dir = tinyProject();
  const before = readdirSync(dir).sort();
  const run = pikit(["add", "log-events"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("pass --yes");
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(pikit(["add", "no-such-thing", "--yes"], dir).err).toContain('no component "no-such-thing"');
});
