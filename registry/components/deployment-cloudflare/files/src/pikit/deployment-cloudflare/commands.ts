/**
 * `pikit up | down | logs | status | dev` for Cloudflare (SPEC §11, C8): plain functions the CLI
 * delegates to, each one `wrangler …` in the project's directory. They run on the machine that
 * deploys, never inside the app (the one file of this component that imports `node:*`).
 *
 * Every command goes through a `Runner`, so tests check the exact `wrangler` argv without wrangler or
 * a Cloudflare account. The real runner runs the project's own wrangler (`node_modules/.bin/wrangler`),
 * without a shell.
 *
 * The Worker is named after `package.json`'s `name`, passed as `--name` to every command, so two
 * projects on one account never deploy over each other.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

export interface RunResult {
  code: number;
  /** Captured output; empty when the output went to the terminal. */
  stdout: string;
}

/**
 * Runs `command` in `cwd`, with `env` over the process's own. With `capture`, stdout is returned
 * (stderr still reaches the terminal); without it, the output streams to the terminal.
 */
export type Runner = (command: readonly string[], options: { cwd: string; capture: boolean; env?: Record<string, string> }) => Promise<RunResult>;

export interface CommandOptions {
  /** The project's directory, where `wrangler.jsonc` and `package.json` are. Default: the current directory. */
  cwd?: string;
  /** Default: spawns the project's wrangler. */
  run?: Runner;
}

/** What `up` deployed, and where it answers. */
export interface Deployed {
  /** The Worker version wrangler uploaded, as `/health` reports it. */
  version: string;
  /** Where `/health` was asked: the `workers.dev` URL wrangler reported, or `url`. */
  url: string;
}

export interface UpOptions extends CommandOptions {
  /** Where the Worker answers. Default: the `https://…workers.dev` URL wrangler reports. */
  url?: string | URL;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** How long to wait for the new version to answer `/health`. Default: 180 000 ms. */
  waitMs?: number;
  /** Between two probes. Default: 2000 ms. */
  intervalMs?: number;
  /** Roll back (`wrangler rollback`) when the new version answers that its App does not start. Default: true. */
  rollback?: boolean;
}

/**
 * Deploys the project, with `.env`'s secrets, and resolves once `/health` answers ok from the version
 * it deployed (C8): a new version takes seconds to reach every request, and whatever registers
 * against the Worker next (a Telegram webhook) must reach this one.
 *
 * Secrets go with the version (`wrangler deploy --secrets-file`), not before it (`wrangler secret`):
 * the version `/health` checks is the code and its secrets together, and no request ever sees new
 * secrets with old code. Wrangler adds them to the ones already set and deletes none. Variables named
 * `CLOUDFLARE_*` stay on this machine: they are wrangler's own credentials, never the Worker's.
 *
 * If the new version answers that its App does not start, it is rolled back to the previous one and
 * `up` rejects. If it never answers, `up` rejects and leaves it: whether to roll back is yours.
 */
export async function up(options: UpOptions = {}): Promise<Deployed> {
  const cwd = options.cwd ?? process.cwd();
  const name = workerName(cwd);
  // Private to this user (mkdtemp is 0700): the secrets file and wrangler's output file.
  const work = mkdtempSync(join(tmpdir(), "pikit-cloudflare-"));
  try {
    const output = join(work, "wrangler-output.jsonl");
    const args = ["deploy", "--name", name];
    const secrets = deploySecrets(cwd);
    if (Object.keys(secrets).length > 0) {
      const file = join(work, "secrets.json");
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
      args.push("--secrets-file", file);
    }
    await wrangler(args, options, { WRANGLER_OUTPUT_FILE_PATH: output });
    const deployed = readDeployOutput(output, options.url);
    writeFileSync(recordPath(cwd, true), `${JSON.stringify(deployed, null, 2)}\n`);

    const outcome = await waitForVersion(deployed, options);
    if (outcome.kind === "ok") return deployed;
    if (outcome.kind === "failing" && options.rollback !== false) {
      const rolledBack = await run(["wrangler", "rollback", "--name", name, "--message", `pikit up: ${deployed.version} failed /health`, "--yes"], options, false);
      throw new Error(
        `the new version ${deployed.version} answers ${deployed.url}/health that its App does not start (${outcome.detail}); ` +
          (rolledBack.code === 0 ? "it was rolled back to the previous version" : "rolling it back failed: run `wrangler rollback`") +
          ". Its logs say why: `pikit logs`, or Workers Logs in the dashboard",
      );
    }
    throw new Error(
      outcome.kind === "failing"
        ? `the new version ${deployed.version} answers ${deployed.url}/health that its App does not start (${outcome.detail}); it is still deployed`
        : `the new version ${deployed.version} did not answer ${deployed.url}/health within ${Math.round((options.waitMs ?? 180_000) / 1000)} s (last: ${outcome.detail}); it is deployed: check \`pikit status\`, and \`wrangler rollback --name ${name}\` if it is broken`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface DownOptions extends CommandOptions {
  /** A person is at a terminal to answer wrangler's question. Default: stdin is a TTY and `CI` is unset. */
  interactive?: boolean;
}

/**
 * Deletes the Worker (`wrangler delete`), and with it every conversation's Durable Object and its
 * data: Cloudflare cannot stop a Worker without deleting it. Only a person decides that: wrangler
 * asks at the terminal, and without one (a script, CI, where wrangler would answer yes by itself)
 * `down` refuses.
 */
export async function down(options: DownOptions = {}): Promise<void> {
  const interactive = options.interactive ?? (process.stdin.isTTY === true && (process.env.CI ?? "") === "");
  if (!interactive) {
    throw new Error(
      "`down` deletes the Worker and every conversation's Durable Object with it (Cloudflare cannot stop a Worker without deleting it). " +
        "It asks a person: run it at a terminal, outside CI",
    );
  }
  await wrangler(["delete", "--name", workerName(options.cwd ?? process.cwd())], options);
}

export interface LogsOptions extends CommandOptions {
  /** Accepted for the CLI's sake: `wrangler tail` always follows. */
  follow?: boolean;
  /** Refused: Cloudflare keeps no lines to replay here (Workers Logs in the dashboard has them). */
  tail?: number;
}

/** The Worker's and its objects' logs, live, until Ctrl-C (`wrangler tail`). */
export async function logs(options: LogsOptions = {}): Promise<void> {
  if (options.tail !== undefined) {
    throw new Error("--tail: `wrangler tail` streams from now on and replays nothing; past logs are in the dashboard (Workers Logs)");
  }
  await wrangler(["tail", workerName(options.cwd ?? process.cwd())], options);
}

/** One deployment: which versions serve, and how much of the traffic each one gets. */
export interface Deployment {
  id: string;
  created: string;
  message?: string;
  versions: { id: string; percentage: number }[];
}

/** A probe's HTTP status, `"unreachable"` when nothing answered, `"unknown"` without a URL. */
export type Probe = number | "unreachable" | "unknown";

export interface Status {
  /** Oldest first, the last one serving now (`wrangler deployments list`, at most 10). */
  deployments: Deployment[];
  /** Where `/health` was asked: `url`, or the one the last `up` from this machine deployed to. */
  url?: string;
  /** `GET /health`. */
  health: Probe;
  /** The version `/health` answered from, when it did. */
  version?: string | null;
}

export interface StatusOptions extends CommandOptions {
  url?: string | URL;
  fetch?: typeof fetch;
  /** Default: 30 000 ms: `/health` starts an object's App. */
  probeTimeoutMs?: number;
}

/** The Worker's deployments as Cloudflare lists them, and what `/health` answers. */
export async function status(options: StatusOptions = {}): Promise<Status> {
  const cwd = options.cwd ?? process.cwd();
  const listed = await wrangler(["deployments", "list", "--name", workerName(cwd), "--json"], options, {}, true);
  const deployments = parseDeployments(listed.stdout);
  const url = options.url?.toString() ?? readRecord(cwd)?.url;
  if (url === undefined) return { deployments, health: "unknown" };
  const seen = await probeHealth(url, options.fetch ?? fetch, options.probeTimeoutMs ?? 30_000);
  return { deployments, url, health: seen.status, ...(seen.version !== undefined && { version: seen.version }) };
}

/** `wrangler deployments list --json`: an array, oldest first. */
export function parseDeployments(output: string): Deployment[] {
  const text = output.trim();
  if (text === "") return [];
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("`wrangler deployments list --json` did not print an array");
  return raw.map((entry) => {
    const item = (entry ?? {}) as { id?: unknown; created_on?: unknown; annotations?: Record<string, unknown>; versions?: unknown };
    const message = item.annotations?.["workers/message"];
    const versions = Array.isArray(item.versions) ? (item.versions as { version_id?: unknown; percentage?: unknown }[]) : [];
    return {
      id: String(item.id ?? ""),
      created: String(item.created_on ?? ""),
      ...(typeof message === "string" && { message }),
      versions: versions.map((v) => ({ id: String(v.version_id ?? ""), percentage: Number(v.percentage ?? 0) })),
    };
  });
}

/**
 * `pikit dev`: the Worker and its objects locally in workerd (`wrangler dev`), reloading on change,
 * with `.env` as its secrets. Resolves with wrangler's exit code.
 */
export async function dev(options: CommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  return (await run(["wrangler", "dev", "--name", workerName(cwd)], options, false)).code;
}

/** The Worker's name: `package.json`'s `name`, in the letters Cloudflare accepts (`my_bot.v2` → `my-bot-v2`). */
export function workerName(cwd: string): string {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) throw new Error(`${cwd} has no package.json: the Worker is named after its "name"`);
  const { name } = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
  if (typeof name !== "string" || name === "") throw new Error(`package.json has no "name": the Worker is named after it`);
  const worker = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (worker === "") throw new Error(`package.json's name "${name}" has no letter or digit to name a Worker with`);
  return worker;
}

/** `.env`'s values for the Worker: set, and not wrangler's own `CLOUDFLARE_*` credentials. */
export function deploySecrets(cwd: string): Record<string, string> {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value === undefined || value === "" || name.startsWith("CLOUDFLARE_")) continue;
    secrets[name] = value;
  }
  return secrets;
}

/** The version and URL of `wrangler deploy`'s output file (`WRANGLER_OUTPUT_FILE_PATH`, one JSON object per line). */
export function readDeployOutput(path: string, url?: string | URL): Deployed {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
  const entry = lines
    .map((line) => JSON.parse(line) as { type?: unknown; version_id?: unknown; targets?: unknown })
    .filter((item) => item.type === "deploy")
    .at(-1);
  if (typeof entry?.version_id !== "string") throw new Error("`wrangler deploy` succeeded but reported no version id");
  const targets = Array.isArray(entry.targets) ? entry.targets.filter((t): t is string => typeof t === "string") : [];
  const found = url?.toString() ?? targets.find((t) => t.startsWith("https://"));
  if (found === undefined) {
    throw new Error(`the Worker has no workers.dev URL to check /health on (targets: ${targets.join(", ") || "none"}): pass its URL`);
  }
  return { version: entry.version_id, url: found.replace(/\/+$/, "") };
}

type Outcome = { kind: "ok" } | { kind: "failing"; detail: string } | { kind: "timeout"; detail: string };

/** Probes `/health` until the deployed version answers it. */
async function waitForVersion(deployed: Deployed, options: UpOptions): Promise<Outcome> {
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + (options.waitMs ?? 180_000);
  let last = "no answer yet";
  for (;;) {
    const seen = await probeHealth(deployed.url, fetcher, 30_000);
    if (seen.version === deployed.version) {
      if (seen.ok) return { kind: "ok" };
      return { kind: "failing", detail: seen.error ?? `HTTP ${String(seen.status)}` };
    }
    last = seen.status === "unreachable" ? "unreachable" : `HTTP ${seen.status} from version ${seen.version ?? "unknown"}`;
    if (Date.now() >= deadline) return { kind: "timeout", detail: last };
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 2_000));
  }
}

async function probeHealth(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number | "unreachable"; ok?: boolean; version?: string | null; error?: string }> {
  let response: Response;
  try {
    response = await fetcher(new URL("/health", url), { signal: AbortSignal.timeout(timeoutMs), headers: { "cache-control": "no-cache" } });
  } catch {
    return { status: "unreachable" };
  }
  const body = (await response.json().catch(() => undefined)) as { ok?: unknown; version?: unknown; error?: unknown } | undefined;
  return {
    status: response.status,
    ok: body?.ok === true,
    ...(body !== undefined && { version: typeof body.version === "string" ? body.version : null }),
    ...(typeof body?.error === "string" && { error: body.error }),
  };
}

/** Where `up` notes what it deployed, for `status`: `.pikit/`, this machine's state, never committed. */
function recordPath(cwd: string, create = false): string {
  const path = join(cwd, ".pikit", "deployment-cloudflare.json");
  if (create) mkdirSync(dirname(path), { recursive: true });
  return path;
}

function readRecord(cwd: string): Deployed | undefined {
  const path = recordPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Deployed;
  } catch {
    return undefined;
  }
}

async function wrangler(args: string[], options: CommandOptions, env: Record<string, string> = {}, capture = false): Promise<RunResult> {
  const result = await run(["wrangler", ...args], options, capture, env);
  if (result.code !== 0) throw new Error(`\`wrangler ${args.join(" ")}\` exited with code ${result.code}`);
  return result;
}

function run(command: string[], options: CommandOptions, capture: boolean, env: Record<string, string> = {}): Promise<RunResult> {
  return (options.run ?? spawnRunner)(command, { cwd: options.cwd ?? process.cwd(), capture, ...(Object.keys(env).length > 0 && { env }) });
}

/**
 * The real runner: `wrangler` is the project's (`node_modules/.bin/wrangler`, here or in a parent
 * directory), run without a shell, so no argument is ever interpreted.
 */
export const spawnRunner: Runner = (command, { cwd, capture, env }) =>
  new Promise((resolve, reject) => {
    const [name = "", ...args] = command;
    const file = name === "wrangler" ? projectWrangler(cwd) : name;
    if (file === undefined) {
      reject(new Error("wrangler is not installed in this project: run `bun add --dev wrangler`, then try again"));
      return;
    }
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error(`\`${file}\` was not found`) : error),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });

function projectWrangler(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules", ".bin", "wrangler");
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) return undefined;
  }
}
