/**
 * proposals-local's Compose file and doctor check with the real `docker compose config --services`
 * (no daemon: `DOCKER_HOST` points nowhere, nothing starts), over deployment-docker's compose.yaml and
 * expose-cloudflare-tunnel's file, in a new project without `.env`. Skipped without Docker's CLI.
 *
 * A repository test, not copied with the component: it reads other components' files.
 */

import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctor } from "./files/src/pikit/proposals-local/doctor.ts";

const COMPONENTS = join(import.meta.dir, "..");
const OVERRIDE = "src/pikit/proposals-local/compose.yaml";
const TUNNEL = "src/pikit/expose-cloudflare-tunnel/compose.yaml";
// Async, never spawnSync (Bun 1.4's lost child exits: testing/cli.ts).
const hasDocker = Bun.which("docker") !== null && (await Bun.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;

/** A new project: compose.yaml, the two Compose files, pikit.json listing `listed`; no .env. */
function project(listed: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-proposals-compose-"));
  cpSync(join(COMPONENTS, "deployment-docker", "files", "compose.yaml"), join(dir, "compose.yaml"));
  for (const [file, from] of [[OVERRIDE, "proposals-local"], [TUNNEL, "expose-cloudflare-tunnel"]] as const) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(COMPONENTS, from, "files", file), join(dir, file));
  }
  const components = Object.fromEntries(Object.entries(listed).map(([name, compose]) => [name, { compose }]));
  writeFileSync(join(dir, "pikit.json"), JSON.stringify({ version: 1, components }));
  return dir;
}

async function services(dir: string, files: string[]): Promise<string[]> {
  const child = Bun.spawn(["docker", "compose", ...files.flatMap((file) => ["-f", file]), "config", "--services"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, DOCKER_HOST: "unix:///nonexistent/docker.sock" } });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return out.split("\n").filter((line) => line !== "").sort();
}

test.skipIf(!hasDocker)("compose.yaml alone has no deployer; with the override it has, the other services untouched; the doctor says so, writing nothing", async () => {
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
  const dirs: string[] = [];
  try {
    const on = project({ "expose-cloudflare-tunnel": TUNNEL, "proposals-local": OVERRIDE });
    const off = project({ "expose-cloudflare-tunnel": TUNNEL });
    dirs.push(on, off);
    expect(await services(on, ["compose.yaml"])).toEqual(["app"]);
    expect(await services(on, ["compose.yaml", TUNNEL])).toEqual(["app", "cloudflared"]);
    expect(await services(on, ["compose.yaml", TUNNEL, OVERRIDE])).toEqual(["app", "cloudflared", "deployer"]);

    const io = { config: {}, get: () => undefined };
    const before = readdirSync(on, { recursive: true }).sort();
    expect(await doctor(io, undefined, on)).toEqual({ problems: [], notes: [] });
    expect(readdirSync(on, { recursive: true }).sort()).toEqual(before);
    expect((await doctor(io, undefined, off)).problems).toEqual([expect.stringContaining("Compose lists no deployer service")]);
    expect((await doctor({ ...io, operation: "up" }, undefined, off)).problems).toEqual([expect.stringContaining("Compose lists no deployer service")]);
    // Before `pikit dev`, no deployer runs: nothing is checked, not even without compose.yaml.
    rmSync(join(off, "compose.yaml"));
    expect(await doctor({ ...io, operation: "dev" }, undefined, off)).toEqual({ problems: [], notes: [expect.stringContaining("`pikit dev` runs no deployer")] });
    // The override without the service it turns on fails out loud.
    rmSync(join(on, "compose.yaml"));
    writeFileSync(join(on, "compose.yaml"), "services:\n  app:\n    image: app\n");
    expect((await doctor(io, undefined, on)).problems).toEqual([expect.stringContaining('service "deployer" has neither an image nor a build context')]);
  } finally {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
