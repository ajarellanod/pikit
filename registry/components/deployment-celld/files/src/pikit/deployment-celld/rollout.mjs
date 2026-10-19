/**
 * A deploy to a celld fleet, the same for every way a project deploys: `pikit up` (`commands.ts`) and
 * a CI job without pikit (`deploy.mjs`, which deploys every merge). Build the UI projects, derive the
 * config celld reads, `celld deploy` it, wait until `/health` answers from what was deployed (C8),
 * and roll a deploy that fails back to the previous one.
 *
 * - **The version** `/health` reports is `PIKIT_DEPLOYMENT`, a new id each deploy writes into the
 *   Worker's variables (celld has no `version_metadata`). celld's own version (a hash of the bundle and
 *   its metadata, from `celld deploy --json`) is kept beside it.
 * - **The wait.** Each node polls the deployment pointer (`CELLD_DEPLOY_POLL_S`, 30 s by default) and
 *   adopts it in place, so the new id reaches `/health` within that, then the rest of the fleet.
 * - **The rollback.** celld has none (denoland/celld#181), but it keeps every deployment and selects
 *   one with the pointer `deploy/current.json`. Before deploying, the pointer is read; if the new
 *   deploy answers that its App does not start, or never answers, the old pointer is written back,
 *   only if the pointer is still the one this deploy wrote (`If-Match`: never over a later deploy).
 *   Not when the deploy changed the Durable Object classes (as on Cloudflare: a migration is
 *   forward-only), and only on an S3-compatible bucket with keys in the environment (`bucket.mjs`).
 *
 * Plain JavaScript with no dependency, so Node runs it in a CI job that has neither pikit nor
 * TypeScript; its types are in `rollout.d.mts`. Every command goes through a `run(command, options)`
 * the caller gives, and every probe and bucket request through its `fetch`, so tests need no celld,
 * no fleet and no bucket.
 */

import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, celldConfig, GENERATED_CONFIG, readProjectConfig, scriptName, writeGeneratedConfig } from "./celld-config.mjs";

/** The fleet-wide pointer, and a Worker's own: `celld deploy` writes the second, then the first. */
export const FLEET_POINTER = "deploy/current.json";
export const namedPointer = (worker) => `deploy/${worker}/current.json`;

/** A new deployment id: when, and 6 random hex digits (`20261019T120000Z-a1b2c3`). */
export function deploymentId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${randomBytes(3).toString("hex")}`;
}

/**
 * The esbuild celld bundles with (`CELLD_ESBUILD`): one given, else the project's
 * (`node_modules/.bin/esbuild`, a dev dependency of this component), else celld's own lookup (`PATH`).
 */
export function esbuildPath(cwd, env) {
  if (env.CELLD_ESBUILD) return env.CELLD_ESBUILD;
  const own = join(cwd, "node_modules", ".bin", "esbuild");
  return existsSync(own) ? own : undefined;
}

/** The celld executable: `PIKIT_CELLD_BIN`, else `celld` from the PATH. */
export const celldBin = (env) => env.PIKIT_CELLD_BIN || "celld";

/**
 * Runs `wrangler.jsonc`'s `build.command` (`sh -c`, where `run` runs: the project's directory), the UI projects' build, when it has one:
 * a build that fails throws, and nothing is deployed, so no Worker ships an old or empty page.
 */
export async function runBuild({ project, run }) {
  const command = buildCommand(project);
  if (command === undefined) return;
  const done = await run(["sh", "-c", command], { capture: false });
  if (done.code !== 0) throw new Error(`the UI build (wrangler.jsonc's build.command) exited with code ${done.code}, so nothing was deployed`);
}

/** The last JSON object `celld deploy --json` printed: `{ worker, version, location }`. */
export function readDeployOutput(stdout) {
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text.startsWith("{"))
    .at(-1);
  let entry;
  try {
    entry = line === undefined ? undefined : JSON.parse(line);
  } catch {
    entry = undefined;
  }
  if (typeof entry?.version !== "string" || typeof entry?.worker !== "string") throw new Error("`celld deploy` succeeded but printed no deployment (worker and version)");
  return { worker: entry.worker, celldVersion: entry.version, location: typeof entry.location === "string" ? entry.location : "" };
}

/**
 * The deployment serving before this one: the fleet pointer and its ETag, `{ none: true }` on a
 * bucket that has none yet, or `{ error }` (then a failed deploy is not rolled back, and says why).
 */
export async function readPrevious(store) {
  if (store.unsupported !== undefined) return { error: store.unsupported };
  try {
    const found = await store.get(FLEET_POINTER);
    if (found === undefined) return { none: true };
    const pointer = JSON.parse(found.body);
    if (typeof pointer?.version !== "string" || typeof pointer?.prefix !== "string") return { error: `${FLEET_POINTER} is not a deployment pointer` };
    return { pointer, body: found.body };
  } catch (error) {
    return { error: `could not read ${FLEET_POINTER}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Derives the config, runs `celld deploy --config wrangler.celld.jsonc --json` with `env` (the
 * bucket's settings) and deletes the config whatever happens (it holds `secrets`). Resolves with what
 * was deployed: `{ version, celldVersion, worker, location, url }`, `version` being `deployment`, the id
 * `/health` will report.
 */
export async function deploy({ cwd, project, secrets, deployment, url, env, run }) {
  const name = scriptName(cwd, project);
  const config = celldConfig(project, { name, secrets, deployment });
  writeGeneratedConfig(cwd, config);
  let done;
  try {
    const esbuild = esbuildPath(cwd, env);
    done = await run([celldBin(env), "deploy", "--config", GENERATED_CONFIG, "--json"], { capture: true, env: esbuild === undefined ? {} : { CELLD_ESBUILD: esbuild } });
  } finally {
    rmSync(join(cwd, GENERATED_CONFIG), { force: true });
  }
  if (done.code === 127) throw new Error(`celld is not installed here (or not on the PATH): curl -fsSL https://celld.dev/install.sh | sh, or set PIKIT_CELLD_BIN`);
  if (done.code !== 0) throw new Error(`\`celld deploy\` exited with code ${done.code}: what it printed above says why`);
  return { version: deployment, ...readDeployOutput(done.stdout), url: url.replace(/\/+$/, "") };
}

/** `GET <url>/health`: its status (`"unreachable"` when nothing answered), and what its body says. */
export async function probeHealth(url, fetcher, timeoutMs) {
  let response;
  try {
    response = await fetcher(new URL("/health", url), { signal: AbortSignal.timeout(timeoutMs), headers: { "cache-control": "no-cache" } });
  } catch {
    return { status: "unreachable" };
  }
  const body = await response.json().catch(() => undefined);
  return {
    status: response.status,
    ok: body?.ok === true,
    ...(body !== undefined && { version: typeof body?.version === "string" ? body.version : null }),
    ...(typeof body?.error === "string" && { error: body.error }),
  };
}

/** How long a deploy has to answer `/health` (3 minutes: the nodes poll every 30 s), and between two probes. */
export const WAIT_MS = 180_000;
export const INTERVAL_MS = 2_000;

/** Probes `/health` until the deployed version answers it: ok, failing (its App does not start), or not in time. */
export async function waitForVersion(deployed, options = {}) {
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    const seen = await probeHealth(deployed.url, fetcher, 30_000);
    if (seen.version === deployed.version) {
      if (seen.ok) return { kind: "ok" };
      return { kind: "failing", detail: seen.error ?? `HTTP ${String(seen.status)}` };
    }
    const last = seen.status === "unreachable" ? "unreachable" : `HTTP ${seen.status} from version ${seen.version ?? "unknown"}`;
    if (Date.now() >= deadline) return { kind: "timeout", detail: last };
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? INTERVAL_MS));
  }
}

/** What went wrong with a deploy that is not ok: `<id> answers …/health that its App does not start (…)`. */
export function healthFailure(deployed, outcome, waitMs = WAIT_MS) {
  return outcome.kind === "failing"
    ? `${deployed.version} answers ${deployed.url}/health that its App does not start (${outcome.detail})`
    : `${deployed.version} did not answer ${deployed.url}/health within ${Math.round(waitMs / 1000)} s (last: ${outcome.detail})`;
}

/** A manifest's Durable Object classes, as a comparable mark: `Conversation|sqlite:Conversation`. */
function classesMark(manifest) {
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string").sort() : []);
  return `${list(manifest?.do_classes).join(",")}|sqlite:${list(manifest?.sqlite_classes).join(",")}`;
}

/**
 * Rolls `deployed`, which failed `/health`, back to `previous` (what `readPrevious` read before the
 * deploy) by writing its pointer back: the Worker's own pointer, then the fleet's, each only if it is
 * still the one this deploy wrote. Resolves with what happened; it never throws.
 */
export async function rollBack({ store, previous, deployed }) {
  if (previous.error !== undefined) return { kind: "unsupported", detail: previous.error };
  if (previous.none === true) return { kind: "none" };
  const to = previous.pointer.version;
  try {
    const fleet = await store.get(FLEET_POINTER);
    const current = fleet === undefined ? undefined : JSON.parse(fleet.body);
    if (current?.version !== deployed.celldVersion) return { kind: "superseded", to, by: current?.version ?? "nothing" };
    const [before, now] = await Promise.all([store.get(`${previous.pointer.prefix}/manifest.json`), store.get(`${current.prefix}/manifest.json`)]);
    if (before === undefined) return { kind: "failed", to, detail: `the previous deployment's manifest (${previous.pointer.prefix}/manifest.json) is gone` };
    const was = classesMark(JSON.parse(before.body));
    const is = now === undefined ? was : classesMark(JSON.parse(now.body));
    if (was !== is) return { kind: "migration", to, previous: was, mark: is };
    // The Worker's own pointer first, as celld writes them: the fleet's is the application's selector.
    if (previous.pointer.script_name === deployed.worker) {
      const named = await store.get(namedPointer(deployed.worker));
      if (named !== undefined && JSON.parse(named.body)?.version === deployed.celldVersion) {
        if (!(await store.replace(namedPointer(deployed.worker), previous.body, named.etag))) return { kind: "superseded", to, by: "a later deploy" };
      }
    }
    if (!(await store.replace(FLEET_POINTER, previous.body, fleet.etag))) return { kind: "superseded", to, by: "a later deploy" };
    return { kind: "rolled-back", to };
  } catch (error) {
    return { kind: "failed", to, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The log's line for a rollback's result: `pikit: <id> failed /health: rolled back to celld version <v>`, or why not. */
export function rollbackLine(deployed, result) {
  const failed = `pikit: ${deployed.version} (celld version ${deployed.celldVersion}) failed /health`;
  switch (result.kind) {
    case "rolled-back":
      return `${failed}: rolled back to celld version ${result.to}; the nodes adopt it at their next poll (CELLD_DEPLOY_POLL_S, 30 s by default)`;
    case "migration":
      return (
        `${failed} and was NOT rolled back: this deploy changed the Durable Object classes (${result.mark}; the previous deployment ${result.to} has ${result.previous}), ` +
        "and a migration only goes forward. It is still deployed: fix it forward, with a deploy that keeps the migration in wrangler.jsonc"
      );
    case "none":
      return `${failed} and was not rolled back: there is no earlier deployment in the bucket to go back to`;
    case "superseded":
      return `${failed} and was not rolled back: the bucket now serves ${result.by}, another deploy that landed since`;
    case "unsupported":
      return `${failed} and was not rolled back: ${result.detail}. It is still deployed: fix it forward, or deploy the previous commit`;
    default:
      return `${failed}, and rolling it back${result.to === undefined ? "" : ` to celld version ${result.to}`} failed (${result.detail}): it is still deployed. Fix it forward, or deploy the previous commit`;
  }
}

/** The project's `wrangler.jsonc` (re-exported for the callers' sake). */
export { readProjectConfig };
