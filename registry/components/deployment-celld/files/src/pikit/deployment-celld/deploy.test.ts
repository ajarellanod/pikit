/**
 * `deploy.mjs`, the deploy command of a CI job without pikit, run by Node as a job runs it: against
 * the fake `celld` on the PATH, the fake bucket and the fake `/health` (`fake-fleet.test-support.ts`).
 * The app's secrets come from the environment, named by `.env.example`; a deploy that answers runs the
 * after-deploy scripts; one that fails is rolled back and fails the job.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "./celld-config.mjs";
import { type FakeFleet, fakeFleet } from "./fake-fleet.test-support.ts";

const NODE = Bun.which("node") ?? process.execPath;
const SHIPPED = readFileSync(join(import.meta.dir, "..", "..", "..", "wrangler.jsonc"), "utf8");

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((done) => done()));

/** An after-deploy script: notes what it is given. */
const STEP = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.STEP_LOG, process.argv.slice(2).join(" ") + "\\n");
process.exitCode = Number(process.env.STEP_CODE ?? 0);
`;

const EXAMPLE = "# deployment-celld\nCELLD_BUCKET=\nPIKIT_CELLD_URL=\nAWS_ACCESS_KEY_ID=\n\n# channel-telegram-webhook\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_PASSWORD=\n";

async function deploy(f: FakeFleet, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pikit-celld-ci-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-bot" }));
  writeFileSync(join(dir, "wrangler.jsonc"), SHIPPED);
  writeFileSync(join(dir, ".env.example"), EXAMPLE);
  writeFileSync(join(dir, "step.mjs"), STEP);
  const child = Bun.spawn([NODE, join(import.meta.dir, "deploy.mjs"), join(dir, "step.mjs")], {
    cwd: dir,
    env: { ...f.env(), STEP_LOG: join(dir, "step.log"), PIKIT_HEALTH_WAIT_MS: "3000", PIKIT_HEALTH_INTERVAL_MS: "10", TELEGRAM_BOT_TOKEN: "123:abc", GITHUB_TOKEN: "never", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const steps = existsSync(join(dir, "step.log")) ? readFileSync(join(dir, "step.log"), "utf8").trim().split("\n") : [];
  const deploys = f.calls().filter((call) => call.args[0] === "deploy");
  return { code, out, err, steps, deploys, dir };
}

test("a deploy that answers: the secrets .env.example names (and only those) from the environment, waited for, then the after-deploy scripts get its URL and id", async () => {
  const f = fleet();
  f.seed("my-bot", "old");
  const run = await deploy(f, { EXTRA: "mine", PIKIT_CELLD_VARS: "EXTRA" });
  expect(run.err).toBe("Uploaded my-bot\n");
  expect(run.code).toBe(0);
  const config = parseJsonc(run.deploys[0]?.config ?? "") as { name: string; vars: Record<string, string> };
  const id = config.vars.PIKIT_DEPLOYMENT as string;
  expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  // Not the bucket's settings, nor what .env.example does not name (GITHUB_TOKEN); an unset one is said.
  expect(config.vars).toEqual({ TELEGRAM_BOT_TOKEN: "123:abc", EXTRA: "mine", PIKIT_DEPLOYMENT: id });
  expect(run.out).toContain("pikit: not set here, so the Worker has none: TELEGRAM_PASSWORD\n");
  expect(run.out).toContain(`pikit: ${id} answers ${f.url}/health\n`);
  expect(run.steps).toEqual([`${f.url} ${id}`]);
  expect(f.serving()).toBe(id);
  expect(existsSync(join(run.dir, "wrangler.celld.jsonc"))).toBe(false);
});

test("a deploy whose App does not start is rolled back to the previous deployment, and the job fails", async () => {
  const f = fleet();
  const previous = f.seed("my-bot", "old");
  f.unhealthy = true;
  const run = await deploy(f);
  expect(run.code).toBe(1);
  expect(run.err).toContain("that its App does not start (the object's App did not start)\n");
  expect(run.err).toContain(`failed /health: rolled back to celld version ${previous};`);
  expect(run.steps).toEqual([]);
  expect(f.serving()).toBe("old");
});

test("a deploy the fleet never answers from is rolled back too", async () => {
  const f = fleet();
  f.seed("my-bot", "old");
  f.frozen = "old";
  const run = await deploy(f, { PIKIT_HEALTH_WAIT_MS: "200" });
  expect(run.code).toBe(1);
  expect(run.err).toContain("did not answer");
  expect(run.err).toContain("(last: HTTP 200 from version old)");
  expect(run.err).toContain("rolled back to celld version");
});

test("without the bucket's keys the deploy goes on, but a failure is not rolled back, and both are said", async () => {
  const f = fleet();
  f.seed("my-bot", "old");
  f.unhealthy = true;
  const run = await deploy(f, { AWS_SECRET_ACCESS_KEY: "" });
  expect(run.out).toContain("pikit: a deploy that fails /health cannot be rolled back: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set here");
  expect(run.code).toBe(1);
  expect(run.err).toContain("was not rolled back: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set here");
});

test("a failed celld deploy fails the job with nothing probed; missing settings are named first", async () => {
  const f = fleet();
  const failed = await deploy(f, { FAKE_DEPLOY_CODE: "1" });
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("pikit: `celld deploy` exited with code 1");
  expect(failed.steps).toEqual([]);
  const unset = await deploy(f, { PIKIT_CELLD_URL: "" });
  expect(unset.code).toBe(1);
  expect(unset.err).toBe("pikit: PIKIT_CELLD_URL must be set: the fleet's bucket and its public URL\n");
});

test("an after-deploy script that fails fails the job, and the deployment stays", async () => {
  const f = fleet();
  const run = await deploy(f, { STEP_CODE: "1" });
  expect(run.code).toBe(1);
  expect(run.err).toContain("step.mjs failed (exit code 1);");
  expect(run.err).toContain("stays deployed\n");
  expect(f.serving()).toMatch(/Z-[0-9a-f]{6}$/);
});

function fleet(): FakeFleet {
  const made = fakeFleet();
  cleanup.push(() => made.stop());
  return made;
}
