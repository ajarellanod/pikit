/**
 * The components' own checks of `pikit doctor` (`hooks.doctor`, `component-doctor.ts`):
 * their problems fail doctor, and so `pikit up` refuses before deploying. The `pikit` binary, run as a
 * user runs it, on a small project with a fake component and a fake deployment. No network.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATION_MARKER } from "../project/operation.ts";
import { emptyManifest, hashOf, modifiedFiles, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { runCli } from "../testing/cli.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

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
    manifest.components[name] = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: {}, dependencies: {}, environment: [] };
  }
  if (declared) manifest.components.checked = { registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, addedDependencies: [], files: {}, dependencies: {}, environment: [], hooks: { doctor: "src/pikit/checked/doctor.ts" } };
  writeProjectManifest(dir, manifest);
  return dir;
}

const REPORTS =
  'export async function doctor(io: { config: Record<string, unknown>; get(name: string): string | undefined }) {\n  return [io.get("CHECKED_PROBLEM"), io.config.fail].filter((p) => p !== undefined);\n}\n';

test("a component's own check: its problems fail doctor, named after it, with its config and the project's environment", async () => {
  const dir = project(REPORTS);
  writeFileSync(join(dir, ".env"), "CHECKED_PROBLEM=the server is down\n");
  const run = await runCli(["doctor"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("checked: the server is down");
  expect(run.err).toContain("checked: the config says so");
});

test("pikit up refuses to deploy when a component's check reports a problem, and deploys once it reports none", async () => {
  const dir = project(REPORTS);
  const refused = await runCli(["up"], dir);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("checked: the config says so");
  expect(refused.err).toContain("fix what `pikit doctor` reports first");
  expect(existsSync(join(dir, "deployed"))).toBe(false);

  writeFileSync(join(dir, "src/pikit/checked/doctor.ts"), "export async function doctor() {\n  return [];\n}\n");
  const deployed = await runCli(["up"], dir);
  expect(deployed.err).toBe("");
  expect(deployed.code).toBe(0);
  expect(existsSync(join(dir, "deployed"))).toBe(true);
});

test("a check that throws, or exports no doctor, is a problem; a component without one is not checked", async () => {
  expect((await runCli(["doctor"], project('export async function doctor() {\n  throw new Error("boom");\n}\n'))).err).toContain("checked: its doctor check failed: boom");
  expect((await runCli(["doctor"], project("export const nothing = 1;\n"))).err).toContain("checked: src/pikit/checked/doctor.ts does not export doctor");
  const plain = await runCli(["doctor"], project(undefined));
  expect(plain.out).toContain("pikit doctor: green");
  expect(plain.code).toBe(0);
});

test("only a declared check runs: a doctor.ts pikit.json does not name is not called, a declared one that is gone is a problem", async () => {
  const undeclared = await runCli(["doctor"], project(REPORTS, false));
  expect(undeclared.out).toContain("pikit doctor: green");
  expect(undeclared.code).toBe(0);
  const gone = project(undefined, true);
  const run = await runCli(["doctor"], gone);
  expect(run.code).toBe(1);
  expect(run.err).toContain("checked: its doctor check failed:");
});

test("a check may also give notes: they are printed and fail nothing", async () => {
  const dir = project('export async function doctor() {\n  return { problems: [], notes: ["the seed is out of date"] };\n}\n');
  const run = await runCli(["doctor"], dir);
  expect(run.code).toBe(0);
  expect(run.out).toContain("checked: the seed is out of date");
  expect(run.out).toContain("pikit doctor: green");
  const bad = await runCli(["doctor"], project('export async function doctor() {\n  return { notes: [] };\n}\n'));
  expect(bad.err).toContain("checked: its doctor check failed: doctor did not resolve with a list of problems, nor with { problems, notes }");
});

test("a config value that looks like a secret is a warning naming its path, pointing to secrets; it fails nothing and is never printed", async () => {
  const dir = project(undefined);
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\nimport checked from "./src/pikit/checked/index.ts";\n\nexport default defineApp({ components: [checked], config: { checked: { fail: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" } } });\n',
  );
  const run = await runCli(["doctor"], dir);
  expect(run.code).toBe(0);
  expect(run.err).toContain("pikit.config.ts's config checked.fail looks like a secret");
  expect(run.err).toContain("through `secrets`");
  expect(run.out).toContain('"fail": "[redacted]"');
  expect(`${run.out}${run.err}`).not.toContain("abcdefghijklmnopqrstuvwxyz0123");

  // A secret's name is what config holds: no warning.
  const plain = await runCli(["doctor"], project(undefined));
  expect(plain.err).not.toContain("looks like a secret");
});

test("pikit up leaves a component with a beforeDeploy hook to that hook (one check per deploy); pikit doctor still runs its check", async () => {
  const dir = project(REPORTS);
  const manifest = readProjectManifest(dir);
  (manifest.components.checked as { hooks?: Record<string, string> }).hooks = { doctor: "src/pikit/checked/doctor.ts", beforeDeploy: "src/pikit/checked/deploy.ts" };
  writeProjectManifest(dir, manifest);
  expect((await runCli(["doctor"], dir)).err).toContain("checked: the config says so");
  const deployed = await runCli(["up"], dir);
  expect(deployed.err).toBe("");
  expect(deployed.code).toBe(0);
  expect(existsSync(join(dir, "deployed"))).toBe(true);
});

test("an unfinished add, remove or upgrade is a problem, with what to do; doctor leaves its marker for the person to delete", async () => {
  const dir = project(undefined);
  writeFileSync(join(dir, OPERATION_MARKER), JSON.stringify({ command: "pikit remove tool-bash", startedAt: "2026-01-01T00:00:00.000Z" }));
  const run = await runCli(["doctor"], dir);
  expect(run.code).toBe(1);
  expect(run.err).toContain("`pikit remove tool-bash`, started 2026-01-01T00:00:00.000Z, did not finish");
  expect(run.err).toContain(`delete ${OPERATION_MARKER} and run \`pikit doctor\``);
  expect(existsSync(join(dir, OPERATION_MARKER))).toBe(true);
  // Every mutating command refuses before planning, even a dry-run upgrade.
  for (const args of [["remove", "checked"], ["add", "log-events", "--yes"], ["upgrade", "--yes"], ["upgrade", "--dry-run"]]) {
    const refused = await runCli(args, dir);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("`pikit remove tool-bash`, started 2026-01-01T00:00:00.000Z, did not finish");
  }
  expect(readProjectManifest(dir).components.checked).toBeDefined();
});

test("a bun.lock that does not match package.json fails doctor even with node_modules there; one that matches (JSONC, overrides) does not", async () => {
  const dir = project(undefined);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "checked", dependencies: {}, overrides: { "left-pad": "1.3.0" } }));
  const lock = (dependencies: string) =>
    `{\n  // bun\n  "lockfileVersion": 2,\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "checked",${dependencies}\n    },\n  },\n  "overrides": {\n    "left-pad": "1.3.0",\n  },\n  "packages": {},\n}\n`;
  writeFileSync(join(dir, "bun.lock"), lock('\n      "dependencies": {\n        "left-pad": "^1.0.0",\n      },'));
  const stale = await runCli(["doctor"], dir);
  expect(stale.code).toBe(1);
  expect(stale.err).toContain("bun.lock does not match package.json");
  expect(stale.err).toContain('left-pad: bun.lock has it (dependencies "^1.0.0"), package.json does not');
  expect(stale.out).not.toContain("pikit doctor: green");

  writeFileSync(join(dir, "bun.lock"), lock(""));
  const matching = await runCli(["doctor"], dir);
  expect(matching.code).toBe(0);
  expect(matching.out).toContain("pikit doctor: green");

  rmSync(join(dir, "bun.lock"));
  const unchecked = await runCli(["doctor"], dir);
  expect(unchecked.code).toBe(0);
  expect(unchecked.out).toContain("there is no bun.lock: whether node_modules matches package.json is not checked");
});

test("a generated file (the manifest's `generated`) is never reported modified; any other edited file is", async () => {
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
  const run = await runCli(["doctor"], dir);
  expect(run.out).toContain(`modified: ${edited} (checked)`);
  expect(run.out).not.toContain(`modified: ${seed}`);
});
