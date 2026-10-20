/**
 * proposals-local's doctor check with a fake Compose (no Docker needed): the exact argv it runs, from
 * pikit.json's Compose files, and what it says for each answer. Copied with the component; it keeps
 * running in your project.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposeRunner, doctor, NOT_A_LOCK, NOT_DEPLOYED_IN_DEV } from "./doctor.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A project whose pikit.json has `components`. */
function project(components?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-proposals-doctor-"));
  dirs.push(dir);
  if (components !== undefined) writeFileSync(join(dir, "pikit.json"), JSON.stringify({ version: 1, components }));
  return dir;
}

function compose(answer: { code?: number; stdout?: string; stderr?: string } | Error) {
  const calls: { command: readonly string[]; cwd: string }[] = [];
  const run: ComposeRunner = async (command, cwd) => {
    calls.push({ command, cwd });
    if (answer instanceof Error) throw answer;
    return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { calls, run };
}

const IO = { config: {}, get: () => undefined };
const INSTALLED = { "expose-a": { compose: "src/pikit/expose-a/compose.yaml" }, "deployment-docker": {}, "proposals-local": { compose: "src/pikit/proposals-local/compose.yaml" } };

test("Compose lists the deployer: fine; it ran config over compose.yaml and every Compose file of pikit.json, in its order", async () => {
  const dir = project(INSTALLED);
  const { calls, run } = compose({ stdout: "app\ncloudflared\ndeployer\n" });
  expect(await doctor(IO, run, dir)).toEqual({ problems: [], notes: [] });
  expect(calls).toEqual([
    { command: ["docker", "compose", "-f", "compose.yaml", "-f", "src/pikit/expose-a/compose.yaml", "-f", "src/pikit/proposals-local/compose.yaml", "config", "--services"], cwd: dir },
  ]);
});

test("no deployer service (the Compose file not recorded, or not applied): a problem, naming the command", async () => {
  for (const dir of [project({ "deployment-docker": {}, "proposals-local": {} }), project()]) {
    const { calls, run } = compose({ stdout: "app\n" });
    const { problems } = await doctor(IO, run, dir);
    expect(calls[0]?.command).toEqual(["docker", "compose", "-f", "compose.yaml", "config", "--services"]);
    expect(problems).toEqual([expect.stringContaining("Compose lists no deployer service (`docker compose -f compose.yaml config --services`)")]);
  }
});

test("Compose fails (an override without the base service, no compose.yaml): a problem with what it said last", async () => {
  const { run } = compose({ code: 15, stderr: 'warning\nservice "deployer" has neither an image nor a build context specified: invalid compose project\n' });
  const { problems } = await doctor(IO, run, project(INSTALLED));
  expect(problems).toEqual([expect.stringMatching(/exited with code 15: service "deployer" has neither an image nor a build context specified: invalid compose project$/)]);
});

test("without Docker here: a note, no problem; another failure to start is the check's", async () => {
  const missing = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  expect(await doctor(IO, compose(missing).run, project(INSTALLED))).toEqual({ problems: [], notes: [expect.stringContaining("Docker is not installed here")] });
  await expect(doctor(IO, compose(new Error("EACCES")).run, project(INSTALLED))).rejects.toThrow("EACCES");
});

test("with execution-local, a note that an approval is a decision, not a lock; with execution-gondolin, none", async () => {
  const local = await doctor(IO, compose({ stdout: "app\ndeployer\n" }).run, project({ ...INSTALLED, "execution-local": {} }));
  expect(local).toEqual({ problems: [], notes: [NOT_A_LOCK] });
  const vm = await doctor(IO, compose({ stdout: "app\ndeployer\n" }).run, project({ ...INSTALLED, "execution-gondolin": {} }));
  expect(vm).toEqual({ problems: [], notes: [] });
  const missing = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  expect((await doctor(IO, compose(missing).run, project({ ...INSTALLED, "execution-local": {} }))).notes).toContain(NOT_A_LOCK);
});

test("before pikit dev (no deployer runs): no Docker, no problem, a note saying so; execution-local's note still given", async () => {
  for (const installed of [INSTALLED, { "proposals-local": { compose: "src/pikit/proposals-local/compose.yaml" } }]) {
    const { calls, run } = compose({ code: 1, stderr: "open compose.yaml: no such file or directory\n" });
    expect(await doctor({ ...IO, operation: "dev" }, run, project(installed))).toEqual({ problems: [], notes: [NOT_DEPLOYED_IN_DEV] });
    expect(calls).toEqual([]);
  }
  const { calls, run } = compose({ stdout: "app\n" });
  expect(await doctor({ ...IO, operation: "dev" }, run, project({ ...INSTALLED, "execution-local": {} }))).toEqual({ problems: [], notes: [NOT_DEPLOYED_IN_DEV, NOT_A_LOCK] });
  expect(calls).toEqual([]);
});

test("pikit doctor and the check before pikit up keep checking Compose", async () => {
  for (const operation of ["doctor", "up"] as const) {
    const { calls, run } = compose({ stdout: "app\n" });
    const { problems } = await doctor({ ...IO, operation }, run, project(INSTALLED));
    expect(calls).toHaveLength(1);
    expect(problems).toEqual([expect.stringContaining("Compose lists no deployer service")]);
  }
});
