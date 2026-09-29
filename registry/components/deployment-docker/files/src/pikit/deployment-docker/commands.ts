/**
 * `pikit up | down | restart | logs | status` for Docker: plain functions the CLI
 * delegates to, each one `docker compose …` in the project's directory. They run on the machine
 * that hosts the containers, never inside the app.
 *
 * Before it builds, `up` runs the installed components' `beforeDeploy` hooks (tool-mcp writes the seed
 * the image then carries): each one is named in its `component.json`'s `hooks`, and `pikit add`
 * records its file in `pikit.json`.
 *
 * Every command goes through a `Runner`, so tests check the exact `docker` argv without Docker.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export interface RunResult {
  code: number;
  /** Captured output; empty when the output went to the terminal. */
  stdout: string;
}

/**
 * Runs `command` in `cwd`. With `capture`, stdout is returned (stderr still reaches the terminal);
 * without it, the output streams to the terminal, as `docker compose logs --follow` must.
 */
export type Runner = (command: readonly string[], options: { cwd: string; capture: boolean }) => Promise<RunResult>;

export interface CommandOptions {
  /** The project's directory, where `compose.yaml` is. Default: the current directory. */
  cwd?: string;
  /** Default: spawns the command. */
  run?: Runner;
}

export interface UpOptions extends CommandOptions {
  /** Where the components' `beforeDeploy` hooks' lines go. Default: `console.log`. */
  say?: (line: string) => void;
}

/**
 * Runs the components' `beforeDeploy` hooks, then builds the image and starts the containers, and
 * waits until their healthcheck passes. A hook's problem stops it before the build.
 */
export async function up(options: UpOptions = {}): Promise<void> {
  await beforeDeploy(options.cwd ?? process.cwd(), options.say ?? ((line) => console.log(line)));
  // `--wait` makes `up` fail when the app never becomes healthy, instead of reporting success for
  // a container that is crash-looping.
  await compose(["up", "--detach", "--build", "--wait"], options);
}

/**
 * What a component's `beforeDeploy` receives (`component.json`'s `hooks.beforeDeploy` names its file).
 * It resolves with its problems, one line each: empty when done.
 */
export interface BeforeDeployIO {
  /** The component's config in `pikit.config.ts` (its default export's). */
  config: Readonly<Record<string, unknown>>;
  /** A variable exported in the environment, or else in `.env`. */
  get(name: string): string | undefined;
  /**
   * Writes `text` to `file`, a file name of the component's own `src/pikit/<name>/`, unless it already
   * holds it; resolves whether it changed. What it writes is what the image takes.
   */
  write(file: string, text: string): boolean;
  say(line: string): void;
}

/** The installed components' `beforeDeploy` hooks (project-relative files), in `pikit.json`'s order. */
export function beforeDeployHooks(cwd: string): { component: string; file: string }[] {
  const path = join(cwd, "pikit.json");
  if (!existsSync(path)) return [];
  const { components } = JSON.parse(readFileSync(path, "utf8")) as { components?: Record<string, { hooks?: { beforeDeploy?: unknown } }> };
  return Object.entries(components ?? {}).flatMap(([component, installed]) => {
    const file = installed.hooks?.beforeDeploy;
    return typeof file === "string" ? [{ component, file }] : [];
  });
}

/** Runs every hook, then fails with all their problems: nothing is built. */
async function beforeDeploy(cwd: string, say: (line: string) => void): Promise<void> {
  const hooks = beforeDeployHooks(cwd);
  if (hooks.length === 0) return;
  const configPath = join(cwd, "pikit.config.ts");
  const app = existsSync(configPath) ? ((await import(pathToFileURL(configPath).href)) as { default?: { config?: unknown } }).default : undefined;
  const config = typeof app?.config === "object" && app.config !== null ? (app.config as Record<string, unknown>) : {};
  const envPath = join(cwd, ".env");
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  const get = (name: string): string | undefined => process.env[name] || env[name] || undefined;
  const problems: string[] = [];
  for (const hook of hooks) {
    try {
      const module = (await import(pathToFileURL(join(cwd, hook.file)).href)) as { beforeDeploy?: unknown };
      if (typeof module.beforeDeploy !== "function") {
        problems.push(`${hook.component}: ${hook.file} does not export beforeDeploy`);
        continue;
      }
      const own = config[hook.component];
      const io: BeforeDeployIO = {
        config: typeof own === "object" && own !== null ? (own as Record<string, unknown>) : {},
        get,
        write: (file, text) => writeOwnFile(cwd, hook.component, file, text),
        say,
      };
      const found = (await (module.beforeDeploy as (io: BeforeDeployIO) => Promise<unknown>)(io)) ?? [];
      if (!Array.isArray(found)) throw new Error("beforeDeploy did not resolve with a list of problems");
      for (const problem of found) problems.push(`${hook.component}: ${String(problem)}`);
    } catch (error) {
      problems.push(`${hook.component}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`what runs before a deploy failed, so nothing was built:\n  ${problems.join("\n  ")}\nFix it, then \`pikit up\` again`);
  }
}

/** `beforeDeploy`'s `write`: only a file of the component's own directory, and only when its text changes. */
function writeOwnFile(cwd: string, component: string, file: string, text: string): boolean {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(file)) throw new Error(`beforeDeploy may write only a file of src/pikit/${component}/, not "${file}"`);
  const path = join(cwd, "src", "pikit", component, file);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

/**
 * Stops and removes the containers, each with its `stop_grace_period`. The `.pikit/` volume stays:
 * it holds the conversations, and deleting it (`docker compose down --volumes`) is a decision for
 * a person, not for `pikit down`.
 */
export async function down(options: CommandOptions = {}): Promise<void> {
  await compose(["down"], options);
}

/** Stops and starts the same containers (a SIGTERM, then a fresh process). Rebuilding is `up`. */
export async function restart(options: CommandOptions = {}): Promise<void> {
  await compose(["restart"], options);
}

export interface LogsOptions extends CommandOptions {
  /** Keep streaming new lines. Default: false. */
  follow?: boolean;
  /** Only the last `tail` lines of each container. Default: all. */
  tail?: number;
}

/** The containers' JSON-lines logs, streamed to the terminal. */
export async function logs(options: LogsOptions = {}): Promise<void> {
  const args = ["logs", "--no-log-prefix"];
  if (options.follow === true) args.push("--follow");
  if (options.tail !== undefined) args.push("--tail", String(options.tail));
  await compose(args, options);
}

/** A directory of this machine that a command run by `exec` needs, at the same absolute path inside. */
export interface SharedDirectory {
  path: string;
  /** The command writes into it. Default: false, mounted read-only. */
  writable?: boolean;
}

export interface ExecOptions extends CommandOptions {
  /** The program and its arguments, run in the app's working directory (`/app`). */
  command: readonly string[];
  /** Directories of this machine the command reads (a script) or writes (its result). */
  share?: readonly SharedDirectory[];
  /** A person answers the command: it gets a terminal. Default: false. */
  interactive?: boolean;
}

/**
 * Runs a one-off command where the app runs, and resolves with its exit code: the app's image
 * (rebuilt first when the source changed), its `.env` and its `.pikit/` volume. `pikit configure`
 * logs in to a model provider this way, so the tokens land in the volume the app reads,
 * and `pikit up` checks there that the app has credentials.
 *
 * `docker compose run --rm` starts a separate, short-lived container of the same service: it
 * publishes no ports and leaves a running app alone. Without a person, it gets no terminal (`-T`)
 * and its output is not shown, nor is the build's progress: Compose 5.5 fails a `run --build` whose
 * stdout is not a terminal while stderr is ("failed to get console") unless progress is `quiet`. A
 * failing build still prints its error.
 */
export async function exec(options: ExecOptions): Promise<number> {
  const interactive = options.interactive === true;
  const args = [...(interactive ? [] : ["--progress", "quiet"]), "run", "--rm", "--build", "--no-deps"];
  if (!interactive) args.push("-T");
  for (const dir of options.share ?? []) args.push("--volume", `${dir.path}:${dir.path}${dir.writable === true ? "" : ":ro"}`);
  const command = ["docker", "compose", ...args, "app", ...options.command];
  const run = options.run ?? spawnRunner;
  const result = await run(command, { cwd: options.cwd ?? process.cwd(), capture: !interactive });
  return result.code;
}

export interface ContainerState {
  name: string;
  service: string;
  /** `running`, `restarting`, `exited`… */
  state: string;
  /** `healthy`, `unhealthy`, `starting`, or `""` without a healthcheck. */
  health: string;
  /** Docker's own summary, e.g. `Up 3 minutes (healthy)`. */
  status: string;
}

/** A probe's HTTP status, or `"unreachable"` when nothing answered. */
export type Probe = number | "unreachable";

export interface Status {
  containers: ContainerState[];
  /** `GET /health`: 200 while the process can answer. */
  health: Probe;
  /** `GET /ready`: 200 only while every component is started. */
  ready: Probe;
}

export interface StatusOptions extends CommandOptions {
  /** Where the app answers from this machine. Default: `http://127.0.0.1:3000`, compose.yaml's port. */
  url?: string | URL;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** How long each probe waits. Default: 2000 ms. */
  probeTimeoutMs?: number;
}

/** The containers as Docker sees them, and what `/health` and `/ready` answer. */
export async function status(options: StatusOptions = {}): Promise<Status> {
  const result = await compose(["ps", "--all", "--format", "json"], options, true);
  const base = new URL(options.url ?? "http://127.0.0.1:3000");
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.probeTimeoutMs ?? 2_000;
  const probe = (path: string): Promise<Probe> =>
    fetcher(new URL(path, base), { signal: AbortSignal.timeout(timeoutMs) }).then(
      (response) => response.status,
      () => "unreachable" as const,
    );
  const [health, ready] = await Promise.all([probe("/health"), probe("/ready")]);
  return { containers: parseContainers(result.stdout), health, ready };
}

/**
 * `docker compose ps --format json` prints one JSON object per line (Compose ≥ 2.21) or one JSON
 * array (older releases). Both are read.
 */
export function parseContainers(output: string): ContainerState[] {
  const text = output.trim();
  if (text === "") return [];
  const raw: unknown[] = text.startsWith("[")
    ? (JSON.parse(text) as unknown[])
    : text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
  return raw.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const field = (key: string): string => (typeof item[key] === "string" ? (item[key] as string) : "");
    return { name: field("Name"), service: field("Service"), state: field("State"), health: field("Health"), status: field("Status") };
  });
}

async function compose(args: string[], options: CommandOptions, capture = false): Promise<RunResult> {
  const command = ["docker", "compose", ...args];
  const run = options.run ?? spawnRunner;
  const result = await run(command, { cwd: options.cwd ?? process.cwd(), capture });
  if (result.code !== 0) throw new Error(`\`${command.join(" ")}\` exited with code ${result.code}`);
  return result;
}

/** The real runner: no shell, so no argument is ever interpreted. */
export const spawnRunner: Runner = (command, { cwd, capture }) =>
  new Promise((resolve, reject) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, { cwd, stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error(`\`${file}\` was not found: install Docker with the Compose plugin`) : error),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
