/**
 * `pikit up | down | logs | status | dev`, and `pikit doctor`'s check, for a celld fleet (SPEC C8):
 * plain functions the CLI delegates to. They run on the machine that deploys, never inside the app
 * (with the `.mjs` files, the only files of this component that import `node:*`).
 *
 * - `up`: the components' `beforeDeploy` hooks, the UI build (`wrangler.jsonc`'s `build.command`),
 *   `celld deploy` of the config derived from `wrangler.jsonc` with `.env`'s secrets as variables,
 *   then it waits until `/health` at `PIKIT_CELLD_URL` answers from what it deployed, rolls back a
 *   deploy that fails (`rollout.mjs`), and runs the components' `afterDeploy` hooks.
 * - `dev`: `celld dev`, one local node with a local store, `.env` as the Worker's variables.
 * - `status`: what this machine deployed last, the fleet's nodes (`celld diagnose --read-only`), and
 *   `/health`.
 * - `logs` and `down` reach the nodes over SSH (`PIKIT_CELLD_SSH`: the systemd unit this component
 *   ships, `nodes/celld.service`): `journalctl`, and `systemctl stop` one node at a time. celld has no
 *   command for either, and without SSH they say where to look instead.
 *
 * Every command goes through a `Runner`: tests run them against a fake `celld` (and `ssh`, `git`) on
 * the PATH, no fleet and no bucket.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { bucketStore } from "./bucket.mjs";
import { celldConfig, DEPLOYMENT_VAR, dotenvText, GENERATED_CONFIG, isMachineVariable, PROJECT_CONFIG, readDotEnv, readProjectConfig, scriptName, workerSecrets, writeGeneratedConfig, writePrivate } from "./celld-config.mjs";
import {
  celldBin,
  type Deployed,
  deploy,
  deploymentId,
  esbuildPath,
  healthFailure,
  probeHealth,
  readPrevious,
  rollBack,
  rollbackLine,
  runBuild,
  WAIT_MS,
  waitForVersion,
} from "./rollout.mjs";

export type { Deployed } from "./rollout.mjs";

/** The oldest celld this component was proven on (the spike's, features/deployment-celld.md). */
export const MIN_CELLD_VERSION = "0.6.1";
/** The systemd unit `logs` and `down` reach on each node (`nodes/celld.service`); `PIKIT_CELLD_UNIT` names another. */
export const DEFAULT_UNIT = "celld.service";
/** `celld dev`'s variables file: written from `.env` for each `pikit dev`, deleted after. */
export const DEV_VARS = ".dev.vars";

type Env = Readonly<Record<string, string | undefined>>;

export interface RunResult {
  code: number;
  /** Captured output; empty when the output went to the terminal. */
  stdout: string;
  /** With `quiet`, its stderr. */
  stderr?: string;
}

/**
 * Runs `command` in `cwd` with exactly `env` (the caller's environment, already merged). With
 * `capture`, stdout is returned (stderr still reaches the terminal); without it, the output streams
 * to the terminal. `quiet` captures stderr too (a check's own noise: celld's warnings). `timeoutMs` kills
 * it (code 124).
 */
export type Runner = (command: readonly string[], options: { cwd: string; capture: boolean; env: Env; timeoutMs?: number; quiet?: boolean }) => Promise<RunResult>;

export interface CommandOptions {
  /** The project's directory, where `wrangler.jsonc` and `.env` are. Default: the current directory. */
  cwd?: string;
  /** The environment, before `.env`'s deploy settings. Default: `process.env`. */
  env?: Env;
  /** Default: spawns the command, without a shell. */
  run?: Runner;
  /** Where lines go. Default: `console.log`. */
  say?: (line: string) => void;
}

/** A `Run` bound to the project (`rollout.mjs`'s), which may also be given a deadline. */
type ContextRun = (command: string[], options: { capture: boolean; env?: Record<string, string>; timeoutMs?: number; quiet?: boolean }) => Promise<RunResult>;

/** What is resolved once for a command: the directory, the environment with `.env`'s deploy settings, the runner. */
interface Context {
  cwd: string;
  env: Env;
  run: ContextRun;
  say: (line: string) => void;
}

function context(options: CommandOptions): Context {
  const cwd = options.cwd ?? process.cwd();
  const env = machineEnv(cwd, options.env ?? process.env);
  const runner = options.run ?? spawnRunner;
  const run: ContextRun = (command, opts) =>
    runner(command, { cwd, capture: opts.capture, env: { ...env, ...opts.env }, ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }), ...(opts.quiet === true && { quiet: true }) });
  return { cwd, env, run, say: options.say ?? ((line) => console.log(line)) };
}

/**
 * `env` with `.env`'s deploy settings under it (`isMachineVariable`: the bucket's location and keys,
 * `PIKIT_CELLD_*`): an exported variable wins. The app's secrets are not here: they go to the Worker,
 * never to celld's process.
 */
export function machineEnv(cwd: string, env: Env): Env {
  const own: Record<string, string> = {};
  for (const [name, value] of Object.entries(readDotEnv(cwd))) {
    if (value !== undefined && value !== "" && isMachineVariable(name)) own[name] = value;
  }
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  return { ...own, ...set };
}

/** What `up` needs that `dev` does not: where the fleet's bucket is and where it answers. */
function fleetSettings(env: Env, url: string | URL | undefined): { bucket: string; url: string } {
  const missing = [env.CELLD_BUCKET ? undefined : "CELLD_BUCKET (the fleet's bucket: s3://name, or gs://, az://)", url ?? env.PIKIT_CELLD_URL ? undefined : "PIKIT_CELLD_URL (the fleet's public URL, https://bot.example.com)"].filter(
    (item) => item !== undefined,
  );
  if (missing.length > 0) {
    throw new Error(`deployment-celld needs ${missing.join(" and ")}: in .env (\`pikit configure\`) or exported. README, "Running a fleet"`);
  }
  return { bucket: env.CELLD_BUCKET as string, url: String(url ?? env.PIKIT_CELLD_URL) };
}

export interface UpOptions extends CommandOptions {
  /** Where the fleet answers. Default: `PIKIT_CELLD_URL`. */
  url?: string | URL;
  /** Default: the global `fetch` (`/health`, and the bucket for a rollback). */
  fetch?: typeof fetch;
  /** How long to wait for the deploy to answer `/health`. Default: 180 000 ms. */
  waitMs?: number;
  /** Between two probes. Default: 2000 ms. */
  intervalMs?: number;
  /** Roll back a deploy that does not answer ok (S3-compatible buckets). Default: true. */
  rollback?: boolean;
  /** The deployment's id. Default: a new one (`deploymentId`). */
  deployment?: string;
}

/**
 * Deploys the project to the fleet, with `.env`'s secrets as the Worker's variables, and resolves
 * once `/health` answers ok from the deployment it wrote (C8): the nodes adopt it at their next poll
 * of the bucket, and whatever registers against the fleet next (a Telegram webhook) must reach it.
 *
 * Secrets: celld has none (denoland/celld#190). They go in the derived config's `vars`, written to
 * `wrangler.celld.jsonc` (0600, ignored by git: `up` refuses otherwise) only while `celld deploy`
 * runs, and land in the bucket's deployment manifest: the bucket is the fleet's trust boundary (its
 * credentials are the fleet's administrator's, and every conversation is in it). The deploy settings
 * (`isMachineVariable`) stay on this machine.
 *
 * A deploy whose App does not start, or that does not answer in time, is rolled back to the previous
 * deployment and `up` rejects (`rollout.mjs`); not across a change of Durable Object classes, and only
 * on an S3-compatible bucket with keys in the environment.
 */
export async function up(options: UpOptions = {}): Promise<Deployed> {
  const ctx = context(options);
  const { cwd, env, run, say } = ctx;
  const fleet = fleetSettings(env, options.url);
  const project = readProjectConfig(cwd);
  await checkIgnored(ctx);
  await beforeDeploy(cwd, env, say);
  await runBuild({ project, run });
  const fetcher = options.fetch ?? fetch;
  const store = bucketStore(env, fetcher);
  const previous = await readPrevious(store);
  const deployed = await deploy({
    cwd,
    project,
    secrets: workerSecrets(readDotEnv(cwd)),
    deployment: options.deployment ?? deploymentId(),
    url: fleet.url,
    env,
    run,
  });
  say(`celld deployed ${deployed.worker} (celld version ${deployed.celldVersion}) as ${DEPLOYMENT_VAR}=${deployed.version}; waiting for ${deployed.url}/health to answer from it`);

  const outcome = await waitForVersion(deployed, { fetch: fetcher, waitMs: options.waitMs, intervalMs: options.intervalMs });
  if (outcome.kind === "ok") {
    // What `status` says this machine deployed: only a deployment that answered (a rolled-back one does not serve).
    writeFileSync(recordPath(cwd, true), `${JSON.stringify({ ...deployed, at: new Date().toISOString() }, null, 2)}\n`);
    await afterDeploy(cwd, env, deployed, say);
    return deployed;
  }
  const failed = `the deployment ${healthFailure(deployed, outcome, options.waitMs ?? WAIT_MS)}`;
  if (options.rollback === false) throw new Error(`${failed}; it is still deployed`);
  const result = await rollBack({ store, previous, deployed });
  throw new Error(`${failed}\n${rollbackLine(deployed, result)}\nIts logs say why: \`pikit logs\` (with PIKIT_CELLD_SSH), or each node's journal`);
}

/** In a git repository, the derived config must be ignored: it holds the secrets while a deploy runs. */
async function checkIgnored({ cwd, run }: Context): Promise<void> {
  if (!existsSync(join(cwd, ".git"))) return;
  const checked = await run(["git", "check-ignore", "-q", GENERATED_CONFIG], { capture: true });
  if (checked.code === 1) {
    throw new Error(`${GENERATED_CONFIG} is not ignored by git, and it holds .env's secrets while a deploy runs: add it to .gitignore (with .celld/ and .dev.vars*), then \`pikit up\` again`);
  }
}

/** A component's deploy hook, as `pikit.json` records it: its project-relative file. */
export interface DeployHook {
  component: string;
  file: string;
}

/** The installed components' `hook` hooks (default: `afterDeploy`), in `pikit.json`'s order; none without `pikit.json`. */
export function deployHooks(cwd: string, hook: "beforeDeploy" | "afterDeploy" = "afterDeploy"): DeployHook[] {
  const path = join(cwd, "pikit.json");
  if (!existsSync(path)) return [];
  const { components } = JSON.parse(readFileSync(path, "utf8")) as { components?: Record<string, { hooks?: Record<string, unknown> }> };
  return Object.entries(components ?? {}).flatMap(([component, installed]) => {
    const file = installed.hooks?.[hook];
    return typeof file === "string" ? [{ component, file }] : [];
  });
}

/** What a component's `beforeDeploy` receives; it resolves with its problems, one line each. */
export interface BeforeDeployIO {
  config: Readonly<Record<string, unknown>>;
  /** A variable exported in the environment, or else in `.env`. */
  get(name: string): string | undefined;
  /** Writes `text` to `file` of the component's own `src/pikit/<name>/`, unless it holds it already; resolves whether it changed. */
  write(file: string, text: string): boolean;
  say(line: string): void;
}

/** What a component's `afterDeploy` receives; it resolves with its problems, one line each. */
export interface AfterDeployIO {
  /** The fleet's public URL, once it answers with the new deployment. */
  url: string;
  config: Readonly<Record<string, unknown>>;
  /** A variable exported in the environment, or else in `.env`: the secrets the deploy gave the Worker. */
  get(name: string): string | undefined;
  say(line: string): void;
}

function reader(cwd: string, env: Env): (name: string) => string | undefined {
  const file = readDotEnv(cwd);
  return (name) => env[name] || file[name] || undefined;
}

/** Every installed component's `beforeDeploy`, before anything is built: all run, then their problems stop the deploy. */
async function beforeDeploy(cwd: string, env: Env, say: (line: string) => void): Promise<void> {
  const hooks = deployHooks(cwd, "beforeDeploy");
  if (hooks.length === 0) return;
  const config = await projectConfig(cwd);
  const get = reader(cwd, env);
  const problems = await runHooks(cwd, hooks, "beforeDeploy", (component) => ({ config: own(config, component), get, write: (file: string, text: string) => writeOwnFile(cwd, component, file, text), say }));
  if (problems.length > 0) throw new Error(`what runs before a deploy failed, so nothing was deployed:\n  ${problems.join("\n  ")}\nFix it, then \`pikit up\` again`);
}

/** Every installed component's `afterDeploy`, once the deployment answers (a Telegram webhook): problems fail `up`, the deployment stays. */
async function afterDeploy(cwd: string, env: Env, deployed: Deployed, say: (line: string) => void): Promise<void> {
  const hooks = deployHooks(cwd);
  if (hooks.length === 0) return;
  const config = await projectConfig(cwd);
  const get = reader(cwd, env);
  const problems = await runHooks(cwd, hooks, "afterDeploy", (component) => ({ url: deployed.url, config: own(config, component), get, say }));
  if (problems.length > 0) {
    throw new Error(
      `the deployment ${deployed.version} answers at ${deployed.url}, but what runs after a deploy failed:\n  ${problems.join("\n  ")}\n` + "It stays deployed. Fix it, then `pikit up` again",
    );
  }
}

async function runHooks(cwd: string, hooks: DeployHook[], name: "beforeDeploy" | "afterDeploy", io: (component: string) => object): Promise<string[]> {
  const problems: string[] = [];
  for (const hook of hooks) {
    try {
      const module = (await import(pathToFileURL(join(cwd, hook.file)).href)) as Record<string, unknown>;
      const fn = module[name];
      if (typeof fn !== "function") {
        problems.push(`${hook.component}: ${hook.file} does not export ${name}`);
        continue;
      }
      const found = (await (fn as (io: object) => Promise<unknown>)(io(hook.component))) ?? [];
      if (!Array.isArray(found)) throw new Error(`${name} did not resolve with a list of problems`);
      for (const problem of found) problems.push(`${hook.component}: ${String(problem)}`);
    } catch (error) {
      problems.push(`${hook.component}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

function own(config: Readonly<Record<string, unknown>>, component: string): Readonly<Record<string, unknown>> {
  const value = config[component];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** `beforeDeploy`'s `write`: only a file of the component's own directory, and only when its text changes. */
function writeOwnFile(cwd: string, component: string, file: string, text: string): boolean {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(file)) throw new Error(`beforeDeploy may write only a file of src/pikit/${component}/, not "${file}"`);
  const path = join(cwd, "src", "pikit", component, file);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

/** The default App's config, as `pikit.config.ts` resolves it. */
async function projectConfig(cwd: string): Promise<Readonly<Record<string, unknown>>> {
  const path = join(cwd, "pikit.config.ts");
  if (!existsSync(path)) return {};
  const app = ((await import(pathToFileURL(path).href)) as { default?: { config?: unknown } }).default;
  const config = app?.config;
  return typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
}

/** The nodes `logs` and `down` reach: `PIKIT_CELLD_SSH`, SSH destinations separated by commas or spaces. */
export function sshNodes(env: Env): string[] {
  return (env.PIKIT_CELLD_SSH ?? "").split(/[\s,]+/).filter((node) => node !== "");
}

const NO_SSH =
  "celld has no command for it: set PIKIT_CELLD_SSH to the nodes' SSH destinations (`deploy@10.0.0.11,deploy@10.0.0.12`, each running nodes/celld.service), " +
  "or do it on each node: `journalctl -u celld -f` for the logs, `sudo systemctl stop celld` to stop it (on ECS, the service's desired count)";

export interface LogsOptions extends CommandOptions {
  follow?: boolean;
  /** Lines per node. Default: 100 without `follow`, 10 with it. */
  tail?: number;
}

/** Each node's celld log (`journalctl -u celld` over SSH, all nodes at once), each line led by its node. */
export async function logs(options: LogsOptions = {}): Promise<void> {
  const ctx = context(options);
  const nodes = sshNodes(ctx.env);
  if (nodes.length === 0) throw new Error(`logs: ${NO_SSH}`);
  const unit = ctx.env.PIKIT_CELLD_UNIT || DEFAULT_UNIT;
  const lines = String(options.tail ?? (options.follow === true ? 10 : 100));
  const codes = await Promise.all(
    nodes.map((node) =>
      streamLines(
        ["ssh", "-o", "BatchMode=yes", node, "journalctl", `--unit=${unit}`, "--output=cat", "--no-pager", `--lines=${lines}`, ...(options.follow === true ? ["--follow"] : [])],
        ctx,
        (line) => ctx.say(`${node} | ${line}`),
      ),
    ),
  );
  const failed = nodes.filter((_, i) => codes[i] !== 0);
  if (failed.length > 0) throw new Error(`logs: ssh to ${failed.join(", ")} failed (exit code ${failed.map((n) => codes[nodes.indexOf(n)]).join(", ")})`);
}

/** Runs `command` and hands each line of its stdout to `line`; resolves with its exit code. */
function streamLines(command: string[], { cwd, env }: Context, line: (text: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "inherit"] });
    createInterface({ input: child.stdout }).on("line", line);
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Stops celld on every node over SSH (`sudo systemctl stop`), one at a time: each hands its cells off
 * before the next stops. It deletes nothing: the deployment and every conversation stay in the
 * bucket, and starting the nodes again (`sudo systemctl start celld`) serves them. To delete them,
 * empty the bucket (or its prefix) yourself.
 */
export async function down(options: CommandOptions = {}): Promise<void> {
  const ctx = context(options);
  const nodes = sshNodes(ctx.env);
  if (nodes.length === 0) throw new Error(`down: ${NO_SSH}. It deletes nothing either way: the deployment and every conversation stay in the bucket`);
  const unit = ctx.env.PIKIT_CELLD_UNIT || DEFAULT_UNIT;
  for (const node of nodes) {
    ctx.say(`stopping celld on ${node} (it hands its conversations off first: up to TimeoutStopSec)`);
    const done = await ctx.run(["ssh", "-o", "BatchMode=yes", node, "sudo", "systemctl", "stop", unit], { capture: false });
    if (done.code !== 0) throw new Error(`down: \`sudo systemctl stop ${unit}\` on ${node} failed (exit code ${done.code}); the nodes before it are stopped`);
  }
  ctx.say(`stopped ${nodes.length} node(s). Nothing was deleted: the deployment and every conversation stay in ${ctx.env.CELLD_BUCKET ?? "the bucket"}; \`sudo systemctl start celld\` on each node serves them again`);
}

/** A probe's HTTP status, `"unreachable"` when nothing answered, `"unknown"` without a URL. */
export type Probe = number | "unreachable" | "unknown";

/** One check of `celld diagnose --json`. */
export interface FleetCheck {
  verdict: string;
  check: string;
  detail: string;
}

export interface Status {
  /** What `up` on this machine deployed last. */
  deployed?: Deployed & { at?: string };
  /** `celld diagnose --read-only --json`'s checks: the bucket, the node leases, each live node. */
  fleet: FleetCheck[];
  url?: string;
  health: Probe;
  version?: string | null;
  /** What `pikit status` prints, one line each. */
  lines: string[];
}

export interface StatusOptions extends CommandOptions {
  url?: string | URL;
  fetch?: typeof fetch;
  /** Default: 30 000 ms: `/health` starts an object's App. */
  probeTimeoutMs?: number;
}

/** What this machine deployed last, the fleet's nodes as `celld diagnose` sees them, and `/health`. */
export async function status(options: StatusOptions = {}): Promise<Status> {
  const ctx = context(options);
  const deployed = readRecord(ctx.cwd);
  const lines: string[] = [];
  lines.push(
    deployed === undefined
      ? "no deploy from this machine yet"
      : `deployed from here: ${deployed.version} (celld version ${deployed.celldVersion}) of ${deployed.worker}${deployed.at === undefined ? "" : `, ${deployed.at}`}`,
  );
  const fleet = ctx.env.CELLD_BUCKET ? await diagnose(ctx) : [];
  if (!ctx.env.CELLD_BUCKET) lines.push("fleet: CELLD_BUCKET is not set");
  for (const check of fleet) lines.push(`fleet: ${check.verdict} ${check.check}${check.detail === "" ? "" : `: ${check.detail}`}`);
  const url = options.url?.toString() ?? ctx.env.PIKIT_CELLD_URL ?? deployed?.url;
  if (url === undefined) {
    lines.push("GET /health: no URL (PIKIT_CELLD_URL)");
    return { ...(deployed !== undefined && { deployed }), fleet, health: "unknown", lines };
  }
  const seen = await probeHealth(url, options.fetch ?? fetch, options.probeTimeoutMs ?? 30_000);
  lines.push(`GET /health at ${url}: ${seen.status}${typeof seen.version === "string" ? ` from version ${seen.version}` : ""}`);
  return { ...(deployed !== undefined && { deployed }), fleet, url, health: seen.status, ...(seen.version !== undefined && { version: seen.version }), lines };
}

/**
 * `celld diagnose --read-only --json`: reads the bucket and probes each live node; writes nothing. Its
 * checks of its own listeners (it binds them to check, on this machine) are left out.
 */
async function diagnose({ run, env }: Context, timeoutMs = 20_000): Promise<FleetCheck[]> {
  const done = await run([celldBin(env), "diagnose", "--read-only", "--json"], { capture: true, timeoutMs, quiet: true });
  const checks = done.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line): FleetCheck[] => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        return [{ verdict: String(row.verdict ?? "?"), check: String(row.check ?? ""), detail: String(row.detail ?? "") }];
      } catch {
        return [];
      }
    })
    .filter((check) => !/^(listen|internal listen|advertise) /.test(check.check));
  if (done.code === 127) return [{ verdict: "fail", check: "celld", detail: "not installed here (or not on the PATH)" }];
  if (done.code === 124) checks.push({ verdict: "fail", check: "celld diagnose", detail: `no answer within ${timeoutMs / 1000} s` });
  else if (done.code !== 0 && !checks.some((check) => check.verdict === "fail")) checks.push({ verdict: "fail", check: "celld diagnose", detail: lastError(done.stderr) ?? `exited with code ${done.code}` });
  return checks;
}

/**
 * Where the deployed app answers: the last healthy `up` from this machine recorded it, else the
 * fleet's configured `PIKIT_CELLD_URL` (exported or in `.env`). Reads no bucket or node. The CLI's
 * `pikit configure --login` on `durable` uploads a credential to its operator route there.
 */
export async function url(options: CommandOptions = {}): Promise<string | undefined> {
  const cwd = options.cwd ?? process.cwd();
  return readRecord(cwd)?.url ?? machineEnv(cwd, options.env ?? process.env).PIKIT_CELLD_URL;
}

/**
 * `pikit dev`: `celld dev`, one node on this machine with a local store (`.celld/dev`), on
 * http://127.0.0.1:9876, rebuilding on change. Before it starts, the UI projects are built once
 * (`build.command`; the CLI builds them again when they change). `.env`, without the deploy settings,
 * becomes the Worker's variables through `.dev.vars` (0600), which `celld dev` reads instead of `.env`;
 * the derived config and `.dev.vars` are written again when `.env` or `wrangler.jsonc` change, and
 * deleted when it exits. Resolves with celld's exit code.
 */
export async function dev(options: CommandOptions = {}): Promise<number> {
  const ctx = context(options);
  const { cwd, run } = ctx;
  const write = () => writeDevFiles(cwd);
  write();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(cwd, (_event, file) => {
    if (file !== ".env" && file !== PROJECT_CONFIG) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      try {
        write();
      } catch (error) {
        ctx.say(`deployment-celld: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 100);
  });
  try {
    await runBuild({ project: readProjectConfig(cwd), run });
    const esbuild = esbuildPath(cwd, ctx.env);
    const done = await run([celldBin(ctx.env), "dev", GENERATED_CONFIG, "--watch-ignore", ".pikit/**", "--watch-ignore", "src/*/dist/**"], {
      capture: false,
      env: esbuild === undefined ? {} : { CELLD_ESBUILD: esbuild },
    });
    if (done.code === 127) throw new Error("celld is not installed here (or not on the PATH): curl -fsSL https://celld.dev/install.sh | sh, or set PIKIT_CELLD_BIN");
    return done.code;
  } finally {
    clearTimeout(pending);
    watcher.close();
    rmSync(join(cwd, GENERATED_CONFIG), { force: true });
    rmSync(join(cwd, DEV_VARS), { force: true });
  }
}

/** The derived config (`PIKIT_DEPLOYMENT=dev`, no secrets in it) and `.dev.vars` from `.env`. */
function writeDevFiles(cwd: string): void {
  const project = readProjectConfig(cwd);
  writeGeneratedConfig(cwd, celldConfig(project, { name: scriptName(cwd, project), deployment: "dev" }));
  writePrivate(join(cwd, DEV_VARS), dotenvText(workerSecrets(readDotEnv(cwd)), "# Written by `pikit dev` from .env (without the deploy settings) for celld dev; deleted when it exits.\n"));
}

/** What `pikit doctor` gives the check (`component-doctor.ts`). */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

/**
 * `pikit doctor`'s check (so `pikit dev`'s and `pikit up`'s first step): celld is installed and recent
 * enough, esbuild is there to bundle with, and `wrangler.jsonc` derives a config celld accepts, with
 * `.env`'s variables; problems. With `CELLD_BUCKET`, the bucket answers `celld diagnose --read-only`
 * (which writes nothing) and how many nodes serve it; and whether a failed deploy can be rolled back:
 * notes, since `pikit dev` needs neither.
 */
export async function doctor(_io: DoctorIO, options: CommandOptions = {}): Promise<{ problems: string[]; notes: string[] }> {
  const ctx = context(options);
  const problems: string[] = [];
  const notes: string[] = [];

  const version = await ctx.run([celldBin(ctx.env), "--version"], { capture: true, quiet: true });
  const found = /celld\s+(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
  if (version.code === 127 || (version.code !== 0 && found === undefined)) {
    problems.push("celld is not installed (or not on the PATH): `curl -fsSL https://celld.dev/install.sh | sh` (Linux x86-64 and ARM64, macOS ARM64), or set PIKIT_CELLD_BIN to it");
  } else if (found === undefined) {
    problems.push(`\`celld --version\` printed no version (${version.stdout.trim().slice(0, 80)})`);
  } else if (compareVersions(found, MIN_CELLD_VERSION) < 0) {
    problems.push(`celld ${found} is older than ${MIN_CELLD_VERSION}, the oldest deployment-celld runs on: install a newer one (CELLD_VERSION=v${MIN_CELLD_VERSION} or later)`);
  }

  if (esbuildPath(ctx.cwd, ctx.env) === undefined && Bun.which("esbuild", { PATH: ctx.env.PATH ?? "" }) === null) {
    problems.push("esbuild is not installed: `bun install` (deployment-celld's dev dependency), or put it on the PATH or in CELLD_ESBUILD; celld bundles the Worker with it");
  }

  try {
    const project = readProjectConfig(ctx.cwd);
    celldConfig(project, { name: scriptName(ctx.cwd, project), secrets: workerSecrets(readDotEnv(ctx.cwd)), deployment: "doctor" });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const unset = ["CELLD_BUCKET", "PIKIT_CELLD_URL"].filter((name) => !ctx.env[name]);
  if (unset.length > 0) notes.push(`\`pikit up\` needs ${unset.join(" and ")} (README, "Running a fleet"); \`pikit dev\` does not`);
  if (ctx.env.CELLD_BUCKET && problems.length === 0) {
    const checks = await diagnose(ctx);
    const failed = checks.filter((check) => check.verdict === "fail");
    if (failed.length > 0) notes.push(`the bucket ${ctx.env.CELLD_BUCKET} does not answer \`celld diagnose --read-only\`: ${failed.map((c) => `${c.check}: ${c.detail}`).join("; ")}`);
    else {
      const leases = checks.find((check) => check.check === "fleet")?.detail ?? "";
      notes.push(/^0 node/.test(leases) ? `no node serves ${ctx.env.CELLD_BUCKET} yet: \`pikit up\` deploys, but nothing answers until one runs (README, "Running a fleet")` : `fleet: ${leases || "reachable"}`);
    }
    const store = bucketStore(ctx.env);
    if (store.unsupported !== undefined) notes.push(`a deploy that fails /health cannot be rolled back from here: ${store.unsupported}`);
  }
  return { problems, notes };
}

/** The last line of celld's error (`Error: …`, then `Caused by:` lines): the innermost cause. */
function lastError(stderr: string | undefined): string | undefined {
  const lines = (stderr ?? "").split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith("Error: "));
  if (start < 0) return undefined;
  const causes = lines.slice(start + 1).filter((line) => /^\d+: /.test(line));
  return (causes.at(-1)?.replace(/^\d+: /, "") ?? lines[start]?.slice("Error: ".length))?.slice(0, 200);
}

/** `a` against `b`, both `x.y.z`: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map((part) => Number.parseInt(part, 10) || 0));
  for (let i = 0; i < 3; i++) {
    const d = ((x as number[])[i] ?? 0) - ((y as number[])[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Where `up` notes what it deployed, for `status`: `.pikit/`, this machine's state, never committed. */
function recordPath(cwd: string, create = false): string {
  const path = join(cwd, ".pikit", "deployment-celld.json");
  if (create) mkdirSync(dirname(path), { recursive: true });
  return path;
}

function readRecord(cwd: string): (Deployed & { at?: string }) | undefined {
  const path = recordPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Deployed & { at?: string };
  } catch {
    return undefined;
  }
}

/** The real runner: the command from the PATH of `env`, without a shell, so no argument is ever interpreted. */
export const spawnRunner: Runner = (command, { cwd, capture, env, timeoutMs, quiet }) =>
  new Promise((resolve) => {
    const [file = "", ...args] = command;
    const stdio = ["inherit", capture ? "pipe" : "inherit", quiet === true ? "pipe" : "inherit"] as const;
    const child = spawn(file, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: [...stdio], ...(timeoutMs !== undefined && { timeout: timeoutMs }) });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    const result = (code: number): RunResult => ({ code, stdout, ...(quiet === true && { stderr }) });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") console.error(`\`${file}\` did not start: ${error.message}`);
      resolve(result(127));
    });
    child.on("close", (code, signal) => resolve(result(code ?? (signal === "SIGTERM" && timeoutMs !== undefined ? 124 : 1))));
  });
