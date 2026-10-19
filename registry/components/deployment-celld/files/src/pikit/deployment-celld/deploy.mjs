#!/usr/bin/env node
/**
 * deployment-celld: the deploy command where no `pikit up` runs (a CI job that deploys every merge to
 * the main branch: `ci/deploy.yml`; a deploy by hand), by the same rules as `pikit up` (`rollout.mjs`).
 * No dependency: Node 22 or later, and `celld` (`PIKIT_CELLD_BIN`, else the PATH).
 *
 *   node src/pikit/deployment-celld/deploy.mjs [<after-deploy script>…]
 *
 * From the environment (CI secrets and variables): `CELLD_BUCKET`, `PIKIT_CELLD_URL` and the bucket's
 * settings (`S3_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), which stay
 * here; and the app's secrets: every variable `.env.example` names (and `PIKIT_CELLD_VARS`, names
 * separated by commas, for your own) that is set, but the deploy settings, goes to the Worker.
 *
 * 1. runs `wrangler.jsonc`'s `build.command` (the UI projects' build: it needs Bun);
 * 2. reads the deployment serving now (`deploy/current.json`), to roll back to;
 * 3. `celld deploy` of the config derived from `wrangler.jsonc`, with the secrets and a new
 *    `PIKIT_DEPLOYMENT`; the derived file is deleted after;
 * 4. waits until `GET <PIKIT_CELLD_URL>/health` answers from it (3 minutes at most);
 * 5. if it answers that its App does not start, or does not answer in time, writes the previous
 *    pointer back and exits 1, so the job fails: `pikit: <id> … failed /health: rolled back to celld
 *    version <v>`. Not when the deploy changed the Durable Object classes, nor on a bucket pikit cannot
 *    write (not S3-compatible, or no keys here): it exits 1 and says so, and the deploy stays;
 * 6. once it answers ok, runs each after-deploy script given, in order: `node <script> <url> <id>`
 *    (channel-telegram-webhook's `setup-webhook.mjs` registers the bot's webhook). It exits 1 when one
 *    fails; the deploy stays (it answers: what failed is outside it).
 *
 * Unlike `pikit up`, it runs no component's `beforeDeploy` hook: commit what they write (tool-mcp's
 * seed) before you merge. `PIKIT_HEALTH_WAIT_MS` and `PIKIT_HEALTH_INTERVAL_MS` change how long it
 * waits, and how often it asks.
 */

import { spawn } from "node:child_process";
import { bucketStore } from "./bucket.mjs";
import { exampleNames, isMachineVariable, readProjectConfig, workerSecrets } from "./celld-config.mjs";
import { deploy, deploymentId, healthFailure, INTERVAL_MS, readPrevious, rollBack, rollbackLine, runBuild, WAIT_MS, waitForVersion } from "./rollout.mjs";

const WAIT = Number(process.env.PIKIT_HEALTH_WAIT_MS ?? WAIT_MS);
const INTERVAL = Number(process.env.PIKIT_HEALTH_INTERVAL_MS ?? INTERVAL_MS);

/** Runs `command`, its output to ours (or captured); resolves with its exit code and stdout. */
function run(command, { capture = false, env = {} } = {}) {
  return new Promise((resolve) => {
    const [file, ...args] = command;
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.on("error", (error) => {
      if (error.code !== "ENOENT") console.error(`pikit: \`${file}\` did not start (${error.message})`);
      resolve({ code: 127, stdout });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** The Worker's variables: the names `.env.example` lists, and `PIKIT_CELLD_VARS`', as this environment sets them. */
function secretsFromEnvironment(cwd) {
  const names = new Set([...exampleNames(cwd), ...(process.env.PIKIT_CELLD_VARS ?? "").split(",").map((name) => name.trim())].filter((name) => name !== ""));
  const unset = [...names].filter((name) => !isMachineVariable(name) && !process.env[name]);
  if (unset.length > 0) console.log(`pikit: not set here, so the Worker has none: ${unset.join(", ")}`);
  return workerSecrets(Object.fromEntries([...names].map((name) => [name, process.env[name]])));
}

async function main(scripts) {
  const cwd = process.cwd();
  const missing = ["CELLD_BUCKET", "PIKIT_CELLD_URL"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`pikit: ${missing.join(" and ")} must be set: the fleet's bucket and its public URL`);
    return 1;
  }
  const store = bucketStore(process.env);
  let deployed;
  let previous;
  try {
    const project = readProjectConfig(cwd);
    await runBuild({ project, run });
    previous = await readPrevious(store);
    if (previous.error !== undefined) console.log(`pikit: a deploy that fails /health cannot be rolled back: ${previous.error}`);
    deployed = await deploy({
      cwd,
      project,
      secrets: secretsFromEnvironment(cwd),
      deployment: deploymentId(),
      url: process.env.PIKIT_CELLD_URL,
      env: process.env,
      run,
    });
  } catch (error) {
    console.error(`pikit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(`pikit: celld deployed ${deployed.worker} (celld version ${deployed.celldVersion}) as ${deployed.version}; waiting for ${deployed.url}/health`);

  const outcome = await waitForVersion(deployed, { waitMs: WAIT, intervalMs: INTERVAL });
  if (outcome.kind !== "ok") {
    console.error(`pikit: ${healthFailure(deployed, outcome, WAIT)}`);
    console.error(rollbackLine(deployed, await rollBack({ store, previous, deployed })));
    console.error("pikit: its logs say why: each node's journal (`journalctl -u celld`), or `pikit logs`");
    return 1;
  }
  console.log(`pikit: ${deployed.version} answers ${deployed.url}/health`);

  let code = 0;
  for (const script of scripts) {
    const done = await run([process.execPath, script, deployed.url, deployed.version]);
    if (done.code !== 0) {
      console.error(`pikit: ${script} failed (exit code ${done.code}); ${deployed.version} stays deployed`);
      code = 1;
    }
  }
  return code;
}

process.exitCode = await main(process.argv.slice(2));
