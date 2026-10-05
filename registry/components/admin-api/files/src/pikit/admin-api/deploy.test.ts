/**
 * admin-api's `beforeDeploy`: on Cloudflare it builds the dashboard (`src/dashboard/`) before the Worker
 * is bundled; on a server, or without a dashboard, it builds nothing (Docker's image builds its own).
 * The commands are a double here, but one: a real `bun run build` in a small project.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard, type Run } from "./deploy.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A project on `targets`, with a dashboard whose package.json is `dashboard` (none when undefined). */
function project(targets: string[], dashboard?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-admin-api-deploy-"));
  dirs.push(dir);
  writeFileSync(join(dir, "pikit.json"), JSON.stringify({ targets }));
  if (dashboard !== undefined) {
    mkdirSync(join(dir, "src", "dashboard"), { recursive: true });
    writeFileSync(join(dir, "src", "dashboard", "package.json"), JSON.stringify(dashboard));
  }
  return dir;
}

/** A runner that records each command and answers `codes` in turn (0 after). */
function runner(codes: number[] = []): Run & { ran: { command: string; cwd: string }[] } {
  const ran: { command: string; cwd: string }[] = [];
  const run = (async (command: string[], cwd: string) => {
    ran.push({ command: command.join(" "), cwd });
    const code = codes.shift() ?? 0;
    return { code, output: code === 0 ? "" : "error: lockfile had changes, but lockfile is frozen" };
  }) as Run & { ran: typeof ran };
  run.ran = ran;
  return run;
}

test("on Cloudflare with a dashboard: its frozen install, then its build, in src/dashboard/", async () => {
  const dir = project(["durable"], { name: "pikit-dashboard" });
  const run = runner();
  const said: string[] = [];

  expect(await buildDashboard(dir, (line) => said.push(line), run)).toEqual([]);

  expect(run.ran).toEqual([
    { command: "bun install --frozen-lockfile", cwd: `${dir}/src/dashboard` },
    { command: "bun run build", cwd: `${dir}/src/dashboard` },
  ]);
  expect(said).toEqual(["✓ admin-api: the dashboard is built into src/pikit/admin-api/dashboard-files.ts"]);
});

test("a failed step is the deploy's problem, with what it printed; the build is not tried after a failed install", async () => {
  const dir = project(["durable"], { name: "pikit-dashboard" });
  const run = runner([1]);

  const problems = await buildDashboard(dir, () => {}, run);

  expect(run.ran.map((each) => each.command)).toEqual(["bun install --frozen-lockfile"]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("the dashboard's `bun install --frozen-lockfile` failed in src/dashboard/ (exit code 1)");
  expect(problems[0]).toContain("lockfile is frozen");
});

test("on a server, or without a dashboard, nothing is built", async () => {
  const run = runner();

  expect(await buildDashboard(project(["server"], { name: "pikit-dashboard" }), () => {}, run)).toEqual([]);
  expect(await buildDashboard(project(["durable"]), () => {}, run)).toEqual([]);

  expect(run.ran).toEqual([]);
});

test("the real commands: a dashboard whose build writes a file", async () => {
  const dir = project(["durable"], { name: "pikit-dashboard", private: true, scripts: { build: "echo yes > built.txt" } });

  expect(await buildDashboard(dir, () => {})).toEqual([]);

  expect(readFileSync(join(dir, "src", "dashboard", "built.txt"), "utf8").trim()).toBe("yes");
});
