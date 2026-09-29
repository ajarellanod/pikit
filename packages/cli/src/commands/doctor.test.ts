/**
 * The components' own checks of `pikit doctor` (`hooks.doctor`, `component-doctor.ts`):
 * their problems fail doctor, and so `pikit up` refuses before deploying. The `pikit` binary, run as a
 * user runs it, on a small project with a fake component and a fake deployment. No network.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, hashOf, modifiedFiles, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function pikit(args: string[], cwd: string) {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/**
 * A project with `checked` (a component whose `doctor.ts` reports the variable CHECKED_PROBLEM, when
 * set, and its config's `fail`) and `deployment-fake` (whose `up` writes `deployed`). `pikit.json`
 * records the check as `pikit add` does, unless `declared` is false.
 */
function project(check: string | undefined, declared = check !== undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-doctor-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "..", "..", "core"), join(dir, "node_modules", "@pikit", "core"));
  const files: Record<string, string> = {
    "package.json": '{ "name": "checked", "dependencies": {} }\n',
    "src/pikit/checked/index.ts": 'import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "checked",\n  config: { type: "object", properties: { fail: { type: "string" } } } as never,\n  setup() {},\n});\n',
    "src/pikit/deployment-fake/index.ts":
      'import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n\nexport async function up(args: { cwd: string }) {\n  writeFileSync(join(args.cwd, "deployed"), "");\n}\n',
    "pikit.config.ts":
      'import { defineApp } from "@pikit/core";\nimport checked from "./src/pikit/checked/index.ts";\n\nexport default defineApp({ components: [checked], config: { checked: { fail: "the config says so" } } });\n',
  };
  if (check !== undefined) files["src/pikit/checked/doctor.ts"] = check;
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const manifest = emptyManifest();
  for (const name of ["checked", "deployment-fake"]) {
    manifest.components[name] = { registry: "default", version: "0.0.0", files: {}, dependencies: {}, environment: [] };
  }
  if (declared) manifest.components.checked = { registry: "default", version: "0.0.0", files: {}, dependencies: {}, environment: [], hooks: { doctor: "src/pikit/checked/doctor.ts" } };
  writeProjectManifest(dir, manifest);
  return dir;
}

const REPORTS =
  'export async function doctor(io: { config: Record<string, unknown>; get(name: string): string | undefined }) {\n  return [io.get("CHECKED_PROBLEM"), io.config.fail].filter((p) => p !== undefined);\n}\n';

test("a component's own check: its problems fail doctor, named after it, with its config and the project's environment", () => {
  const dir = project(REPORTS);
  writeFileSync(join(dir, ".env"), "CHECKED_PROBLEM=the server is down\n");
  const run = pikit(["doctor"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("checked: the server is down");
  expect(run.err).toContain("checked: the config says so");
});

test("pikit up refuses to deploy when a component's check reports a problem, and deploys once it reports none", () => {
  const dir = project(REPORTS);
  const refused = pikit(["up"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("checked: the config says so");
  expect(refused.err).toContain("fix what `pikit doctor` reports first");
  expect(existsSync(join(dir, "deployed"))).toBe(false);

  writeFileSync(join(dir, "src/pikit/checked/doctor.ts"), "export async function doctor() {\n  return [];\n}\n");
  const deployed = pikit(["up"], dir);
  expect(deployed.err).toBe("");
  expect(deployed.code).toBe(0);
  expect(existsSync(join(dir, "deployed"))).toBe(true);
});

test("a check that throws, or exports no doctor, is a problem; a component without one is not checked", () => {
  expect(pikit(["doctor"], project('export async function doctor() {\n  throw new Error("boom");\n}\n')).err).toContain("checked: its doctor check failed: boom");
  expect(pikit(["doctor"], project("export const nothing = 1;\n")).err).toContain("checked: src/pikit/checked/doctor.ts does not export doctor");
  const plain = pikit(["doctor"], project(undefined));
  expect(plain.out).toContain("pikit doctor: green");
  expect(plain.code).toBe(0);
});

test("only a declared check runs: a doctor.ts pikit.json does not name is not called, a declared one that is gone is a problem", () => {
  const undeclared = pikit(["doctor"], project(REPORTS, false));
  expect(undeclared.out).toContain("pikit doctor: green");
  expect(undeclared.code).toBe(0);
  const gone = project(undefined, true);
  const run = pikit(["doctor"], gone);
  expect(run.code).toBe(1);
  expect(run.err).toContain("checked: its doctor check failed:");
});

test("a check may also give notes: they are printed and fail nothing", () => {
  const dir = project('export async function doctor() {\n  return { problems: [], notes: ["the seed is out of date"] };\n}\n');
  const run = pikit(["doctor"], dir);
  expect(run.code).toBe(0);
  expect(run.out).toContain("checked: the seed is out of date");
  expect(run.out).toContain("pikit doctor: green");
  const bad = pikit(["doctor"], project('export async function doctor() {\n  return { notes: [] };\n}\n'));
  expect(bad.err).toContain("checked: its doctor check failed: doctor did not resolve with a list of problems, nor with { problems, notes }");
});

test("pikit up leaves a component with a beforeDeploy hook to that hook (one check per deploy); pikit doctor still runs its check", () => {
  const dir = project(REPORTS);
  const manifest = readProjectManifest(dir);
  (manifest.components.checked as { hooks?: Record<string, string> }).hooks = { doctor: "src/pikit/checked/doctor.ts", beforeDeploy: "src/pikit/checked/deploy.ts" };
  writeProjectManifest(dir, manifest);
  expect(pikit(["doctor"], dir).err).toContain("checked: the config says so");
  const deployed = pikit(["up"], dir);
  expect(deployed.err).toBe("");
  expect(deployed.code).toBe(0);
  expect(existsSync(join(dir, "deployed"))).toBe(true);
});

test("a generated file (the manifest's `generated`) is never reported modified; any other edited file is", () => {
  const dir = project(undefined);
  const seed = "src/pikit/checked/seed.ts";
  const edited = "src/pikit/checked/index.ts";
  writeFileSync(join(dir, seed), "export const seed = {};\n");
  const manifest = readProjectManifest(dir);
  const checked = manifest.components.checked as NonNullable<(typeof manifest.components)[string]>;
  checked.files = { [seed]: { hash: hashOf("export const seed = {};\n") }, [edited]: { hash: hashOf("as installed\n") } };
  writeProjectManifest(dir, manifest);
  writeFileSync(join(dir, seed), 'export const seed = { wiki: {} };\n');

  expect(modifiedFiles(dir, checked).sort()).toEqual([edited, seed].sort());
  checked.generated = [seed];
  writeProjectManifest(dir, manifest);
  expect(modifiedFiles(dir, checked)).toEqual([edited]);
  const run = pikit(["doctor"], dir);
  expect(run.out).toContain(`modified: ${edited} (checked)`);
  expect(run.out).not.toContain(`modified: ${seed}`);
});
