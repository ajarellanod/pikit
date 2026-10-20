/**
 * `pikit up | down | restart | logs | status | dev` for a service of this machine: plain functions the
 * CLI delegates to, run on this machine, never inside the app. The supervisor is systemd's user manager
 * on Linux and launchd on macOS (`supervisor.ts`); the service runs the project in place, in its own
 * directory, with its own `.pikit/` (the one `pikit dev` uses: never both at once).
 *
 * `up` is the deploy: the components' `beforeDeploy` hooks, `bun install`, the UI projects' builds, the
 * unit (or plist) written from this component's template, the service (re)started, `/health` waited
 * for, then the components' `afterDeploy` hooks with the public URL (`PIKIT_PUBLIC_URL`, which
 * `pikit expose` writes). A crash restart in between runs the files as they are on disk.
 *
 * Every command goes through a `Runner`, so tests check the exact `systemctl` and `launchctl` argv
 * without a supervisor.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  APP_LOG,
  createSupervisor,
  ENTRY,
  readTemplate,
  render,
  type Runner,
  type RunResult,
  type ServiceState,
  serviceFile,
  serviceNames,
  STDIO_LOG,
  type Supervisor,
  type SupervisorKind,
  supervisorKind,
} from "./supervisor.ts";

export type { Runner, RunResult, ServiceState };

export interface CommandOptions {
  /** The project's directory. Default: the current directory. */
  cwd?: string;
  /** Default: spawns the command. */
  run?: Runner;
  /** Default: `process.platform`. */
  platform?: string;
  /** Where the unit or plist goes. Default: the user's home. */
  home?: string;
  /** Default: the current user's (launchd's `gui/<uid>`, systemd's linger). */
  uid?: number;
  user?: string;
  /** The environment `up` takes `PATH` and `HOME` from. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The Bun the service runs. Default: the one running this (`process.execPath`). */
  bun?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Default: `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
  /** Where lines for a person go. Default: `console.log`. */
  say?: (line: string) => void;
}

interface Context {
  cwd: string;
  run: Runner;
  platform: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  bun: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  say: (line: string) => void;
  uid: number;
  user: string;
}

function context(options: CommandOptions): Context {
  return {
    cwd: options.cwd ?? process.cwd(),
    run: options.run ?? spawnRunner,
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
    bun: options.bun ?? process.execPath,
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
    say: options.say ?? ((line) => console.log(line)),
    uid: options.uid ?? process.getuid?.() ?? 0,
    user: options.user ?? userInfo().username,
  };
}

interface Service {
  kind: SupervisorKind;
  supervisor: Supervisor;
  /** The unit's or plist's path. */
  file: string;
  /** What `status` calls it: the unit, or the label. */
  name: string;
}

/** The project's service, or `undefined` on a platform with neither supervisor. */
function serviceOf(ctx: Context): Service | undefined {
  const kind = supervisorKind(ctx.platform);
  if (kind === undefined) return undefined;
  const names = serviceNames(ctx.cwd);
  const file = serviceFile(kind, ctx.home, names);
  const supervisor = createSupervisor(kind, { run: ctx.run, cwd: ctx.cwd, uid: ctx.uid, user: ctx.user, names, file, sleep: ctx.sleep });
  return { kind, supervisor, file, name: kind === "systemd" ? `${names.unit}.service` : names.label };
}

function requireService(ctx: Context): Service {
  const service = serviceOf(ctx);
  if (service === undefined) {
    throw new Error(`deployment-local runs the app under systemd (Linux) or launchd (macOS), and ${ctx.platform} has neither: use deployment-docker (\`pikit remove deployment-local\`, then \`pikit add deployment-docker\`)`);
  }
  return service;
}

/** How long `up` waits for the new process's `/health`: the entrypoint's start deadline (30 s) and a margin. */
export const UP_TIMEOUT_MS = 45_000;

export interface UpOptions extends CommandOptions {
  /** Default: `UP_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Deploys what is on disk: the hooks, `bun install`, the UI builds, the unit or plist, a restart, and
 * `/health` from the new process. A problem before the restart leaves the running service alone; one
 * after it (no `/health` in time) leaves the service installed and restarting, as a container that
 * fails `docker compose up --wait`, and prints the last lines of its logs.
 */
export async function up(options: UpOptions = {}): Promise<void> {
  const ctx = context(options);
  const service = requireService(ctx);
  const unreachable = await service.supervisor.check();
  if (unreachable !== undefined) throw new Error(unreachable);
  const beside = besideTheApp(ctx.cwd);
  if (beside.length > 0) throw new Error(besideProblem(beside));
  // Doctor sees this CLI's exported variables too, but the service reads only .env. Do not start it
  // with a required key it cannot see just because it happened to be in this shell.
  const env = readDotEnv(ctx.cwd);
  for (const [name, installed] of Object.entries(installedComponents(ctx.cwd))) {
    for (const variable of installed.environment ?? []) {
      if (variable.required && !env[variable.name]) {
        throw new Error(`${variable.name} is required by ${name} but is not in .env: run \`pikit configure\`; an exported variable in this shell does not reach the service`);
      }
    }
  }
  // Rendered before anything runs: a path the unit cannot hold fails here, not after the build.
  const settings = { project: ctx.cwd, bun: ctx.bun, path: ctx.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", home: ctx.env.HOME ?? ctx.home };
  const text = render(service.kind, readTemplate(service.kind), settings, serviceNames(ctx.cwd));

  await runBeforeDeployHooks(ctx.cwd, ctx.say);
  await mustRun(ctx, [ctx.bun, "install", "--frozen-lockfile"], ctx.cwd);
  for (const dir of uiProjects(ctx.cwd)) {
    ctx.say(`building ${dir}`);
    await mustRun(ctx, [ctx.bun, "install", "--frozen-lockfile"], join(ctx.cwd, dir));
    await mustRun(ctx, [ctx.bun, "--bun", "run", "build"], join(ctx.cwd, dir));
  }

  const port = await appPort(ctx.cwd);
  const before = await service.supervisor.state();
  if (!before.active && port !== undefined && (await probe(ctx, port, "/health")) !== "unreachable") {
    throw new Error(`something else answers at http://127.0.0.1:${port} (\`pikit dev\`, or another project?): stop it, then \`pikit up\` again`);
  }

  prepareLogs(ctx.cwd);
  mkdirSync(dirname(service.file), { recursive: true });
  if (!existsSync(service.file) || readFileSync(service.file, "utf8") !== text) writeFileSync(service.file, text);
  await service.supervisor.start();
  await waitUntilServing(ctx, service, port, options.timeoutMs ?? UP_TIMEOUT_MS);

  if ((await service.supervisor.lingers()) === false) {
    ctx.say(`it stops when you log out: \`sudo loginctl enable-linger ${ctx.user}\` keeps it running (and starts it at boot)`);
  }
  const installed = Object.keys(installedComponents(ctx.cwd));
  if (installed.includes("tool-bash") && installed.includes("execution-local")) {
    ctx.say("the agent's shell (tool-bash on execution-local) runs as you, with your files: deployment-local's README, \"Isolation\"");
  }
  await runAfterDeployHooks(ctx.cwd, ctx.say);
}

/** Waits until the service is active and `/health` answers 200; without server-bun, until it stays up a moment. */
async function waitUntilServing(ctx: Context, service: Service, port: number | undefined, timeoutMs: number): Promise<void> {
  if (port === undefined) {
    ctx.say("no server-bun in pikit.config.ts, so no /health to wait for: checking that it stays up");
    await ctx.sleep(3_000);
    const state = await service.supervisor.state();
    if (state.active && state.pid !== undefined) return;
    throw new Error(`the service is not running (${state.summary})${logTails(ctx.cwd)}`);
  }
  const started = Date.now();
  let last: ServiceState | undefined;
  let health: Probe = "unreachable";
  while (Date.now() - started < timeoutMs) {
    last = await service.supervisor.state();
    health = await probe(ctx, port, "/health");
    if (last.active && health === 200) return;
    await ctx.sleep(500);
  }
  throw new Error(
    `the app did not answer /health within ${Math.round(timeoutMs / 1000)} s (GET /health: ${health}; ${service.name}: ${last?.summary ?? "unknown"}). It stays installed and keeps restarting: fix it, then \`pikit up\` again, or \`pikit down\`${logTails(ctx.cwd)}`,
  );
}

/** Stops the service and removes its unit or plist. `.pikit/` stays: it holds the conversations. */
export async function down(options: CommandOptions = {}): Promise<void> {
  const ctx = context(options);
  const service = requireService(ctx);
  await service.supervisor.stop();
  rmSync(service.file, { force: true });
  await service.supervisor.forget();
}

/** A stop and a fresh process, with the files as they are on disk. Deploying (hooks, install, builds) is `up`. */
export async function restart(options: CommandOptions = {}): Promise<void> {
  const ctx = context(options);
  const service = requireService(ctx);
  if (!(await service.supervisor.state()).installed) throw new Error("the service is not installed: `pikit up` first");
  await service.supervisor.restart();
}

export interface LogsOptions extends CommandOptions {
  /** Keep printing new lines. Default: false. */
  follow?: boolean;
  /** Only the last `tail` lines. Default: all. */
  tail?: number;
  /** Where each line goes. Default: stdout. */
  write?: (line: string) => void;
  /** Ends `follow`. Default: never (Ctrl-C). */
  signal?: AbortSignal;
}

/** The app's JSON lines, oldest first, from `.pikit/logs/app.log` and its rotated files. */
export async function logs(options: LogsOptions = {}): Promise<void> {
  const ctx = context(options);
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const current = join(ctx.cwd, APP_LOG);
  let lines = logFiles(ctx.cwd).flatMap((file) => readFileSync(file, "utf8").split("\n").filter((line) => line !== ""));
  if (options.tail !== undefined) lines = options.tail <= 0 ? [] : lines.slice(-options.tail);
  for (const line of lines) write(line);
  if (options.follow !== true) {
    if (!existsSync(current)) ctx.say(`no logs yet: ${APP_LOG} is written once \`pikit up\` started the app`);
    return;
  }
  // Polls the current file: it rotates (a smaller size, or another inode) and is read from its start.
  let offset = existsSync(current) ? statSync(current).size : 0;
  let inode = existsSync(current) ? statSync(current).ino : undefined;
  let partial = "";
  while (options.signal?.aborted !== true) {
    await ctx.sleep(500);
    if (!existsSync(current)) continue;
    const stat = statSync(current);
    if (stat.ino !== inode || stat.size < offset) {
      inode = stat.ino;
      offset = 0;
      partial = "";
    }
    if (stat.size === offset) continue;
    const fd = openSync(current, "r");
    try {
      const buffer = Buffer.alloc(stat.size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      offset = stat.size;
      const text = partial + buffer.toString("utf8");
      const parts = text.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) if (line !== "") write(line);
    } finally {
      closeSync(fd);
    }
  }
}

/** A probe's HTTP status, or `"unreachable"` when nothing answered. */
export type Probe = number | "unreachable";

export interface Status {
  state: ServiceState;
  /** `GET /health`, without server-bun `undefined`. */
  health?: Probe;
  /** `GET /ready`. */
  ready?: Probe;
  /** What `pikit status` prints, one line each. */
  lines: string[];
}

/** The service as its supervisor sees it, and what `/health` and `/ready` answer. */
export async function status(options: CommandOptions = {}): Promise<Status> {
  const ctx = context(options);
  const service = requireService(ctx);
  const state = await service.supervisor.state();
  const port = await appPort(ctx.cwd);
  const lines = [`${service.kind} ${service.name}: ${state.summary}`];
  let health: Probe | undefined;
  let ready: Probe | undefined;
  if (port !== undefined) {
    [health, ready] = await Promise.all([probe(ctx, port, "/health"), probe(ctx, port, "/ready")]);
    lines.push(`GET /health: ${health}`, `GET /ready:  ${ready}`);
  }
  if (state.installed && health !== 200) lines.push("its last lines: `pikit logs --tail 50`, and .pikit/logs/stdio.log for a crash before the app's logger");
  if ((await service.supervisor.lingers()) === false) lines.push(`linger: off, so it stops when you log out (\`sudo loginctl enable-linger ${ctx.user}\`)`);
  return { state, ...(health !== undefined && { health }), ...(ready !== undefined && { ready }), lines };
}

/** A directory of this machine a command needs: here it is the same disk, so nothing is shared. */
export interface SharedDirectory {
  path: string;
  writable?: boolean;
}

export interface ExecOptions extends CommandOptions {
  /** The program and its arguments, run in the project's directory; `bun` is the service's Bun. */
  command: readonly string[];
  share?: readonly SharedDirectory[];
  /** A person answers the command: it gets the terminal. Default: false. */
  interactive?: boolean;
}

/**
 * Runs a command where the app runs: here, in the project, with `.env` over this process's
 * environment, as the service sees it. `pikit configure` logs in to a model provider this way, and
 * `pikit up` checks the logins with it: the app and `pikit dev` share `.pikit/`, so one login serves
 * both. Without a person, its output is not shown, as deployment-docker's `exec`.
 */
export async function exec(options: ExecOptions): Promise<number> {
  const ctx = context(options);
  const [program = "", ...args] = options.command;
  // The service's secrets are `.env`, not the CLI shell: otherwise a key exported for this one
  // `pikit up` would pass its credential check, but the app's next launch could not see it.
  const env = {
    PATH: ctx.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: ctx.env.HOME ?? ctx.home,
    NODE_ENV: "production",
    ...readDotEnv(ctx.cwd),
  };
  // Bun normally loads .env.local and .env.production too; the service uses --env-file=.env.
  const command = program === "bun" ? [ctx.bun, "--env-file=.env", ...args] : [program, ...args];
  const result = await ctx.run(command, { cwd: ctx.cwd, capture: options.interactive !== true, env });
  // Its output is not shown, but why it failed is.
  if (result.code !== 0 && result.stderr !== "") process.stderr.write(result.stderr);
  return result.code;
}

/**
 * `pikit dev`: refuses while the service runs (they would share `.pikit/` and the port); else builds
 * each UI project once and runs `main.ts` with Bun's `--watch` and `.env`, until Ctrl-C. The CLI
 * rebuilds a UI project when its files change.
 */
export async function dev(options: CommandOptions = {}): Promise<number> {
  const ctx = context(options);
  const service = serviceOf(ctx);
  if (service !== undefined && (await service.supervisor.state()).active) {
    throw new Error(`the service runs (\`pikit up\`): \`pikit down\` first. \`pikit dev\` and the service would share .pikit/ and the port`);
  }
  for (const dir of uiProjects(ctx.cwd)) {
    const built = await ctx.run([ctx.bun, "run", "build"], { cwd: join(ctx.cwd, dir), capture: false });
    if (built.code !== 0) ctx.say(`${dir}: its build failed (were its packages installed? \`bun install\` in ${dir}/): the app serves its last build`);
  }
  ctx.say(`bun --watch ${ENTRY}`);
  const child = Bun.spawn([ctx.bun, "--watch", ENTRY], {
    cwd: ctx.cwd,
    env: { ...readDotEnv(ctx.cwd), ...process.env } as Record<string, string>,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Ctrl-C reaches the child through the terminal; a SIGTERM to the CLI is passed on.
  const forward = () => child.kill("SIGTERM");
  process.on("SIGTERM", forward);
  try {
    return await child.exited;
  } finally {
    process.off("SIGTERM", forward);
  }
}

/** What a component's `doctor(io)` receives (`component.json`'s `hooks.doctor`). */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

/**
 * `pikit doctor`'s check (so `pikit dev`'s and `pikit up`'s first step). Only notes: `pikit dev` needs
 * none of it, and `up` refuses on its own what it cannot do. The supervisor is reachable, the project's
 * path fits a unit, linger, macOS's protected folders, the components that run beside the app in
 * Docker, `.env`'s permissions, and the Bun the installed service runs.
 */
export async function doctor(_io: DoctorIO, options: CommandOptions = {}): Promise<{ problems: string[]; notes: string[] }> {
  const ctx = context(options);
  const notes: string[] = [];
  const service = serviceOf(ctx);
  if (service === undefined) {
    notes.push(`\`pikit up\` needs systemd (Linux) or launchd (macOS), and ${ctx.platform} has neither: \`pikit dev\` runs here, \`pikit up\` does not (use deployment-docker)`);
  } else {
    const unreachable = await service.supervisor.check();
    if (unreachable !== undefined) notes.push(`\`pikit up\` cannot reach the supervisor: ${unreachable}`);
    try {
      render(service.kind, readTemplate(service.kind), { project: ctx.cwd, bun: ctx.bun, path: "", home: ctx.home }, serviceNames(ctx.cwd));
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
    if (unreachable === undefined && (await service.supervisor.lingers()) === false) {
      notes.push(`linger is off: the service stops when you log out (\`sudo loginctl enable-linger ${ctx.user}\`)`);
    }
    if (service.kind === "launchd") {
      const protectedDir = ["Documents", "Desktop", "Downloads", join("Library", "Mobile Documents")].find((dir) => ctx.cwd.startsWith(join(ctx.home, dir) + "/"));
      if (protectedDir !== undefined) {
        notes.push(`the project is under ~/${protectedDir}, which macOS keeps from background processes without Full Disk Access: move it (~/agents/…) before \`pikit up\``);
      }
    }
    const runs = installedBun(service);
    if (runs !== undefined && !existsSync(runs)) notes.push(`the installed service runs ${runs}, which is gone: \`pikit up\` again`);
  }
  const beside = besideTheApp(ctx.cwd);
  if (beside.length > 0) notes.push(`\`pikit up\` refuses this: ${besideProblem(beside)}`);
  const envFile = join(ctx.cwd, ".env");
  if (existsSync(envFile) && (statSync(envFile).mode & 0o077) !== 0) notes.push(".env is readable by other users of this machine: `chmod 600 .env`");
  return { problems: [], notes };
}

/** The Bun path in the installed unit or plist, if there is one. */
function installedBun(service: Service): string | undefined {
  if (!existsSync(service.file)) return undefined;
  const text = readFileSync(service.file, "utf8");
  const found = service.kind === "systemd" ? /^ExecStart="([^"]+)"/m.exec(text)?.[1]?.replace(/%%/g, "%").replace(/\$\$/g, "$") : /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  return found;
}

/** The installed components that run services beside the app with Docker Compose (`compose` in pikit.json). */
function besideTheApp(cwd: string): string[] {
  return Object.entries(installedComponents(cwd))
    .filter(([, installed]) => typeof installed.compose === "string")
    .map(([name]) => name);
}

function besideProblem(names: string[]): string {
  const one = names.length === 1;
  return `${names.join(", ")} run${one ? "s" : ""} beside the app in Docker (\`compose\` in ${one ? "its" : "their"} component.json), which deployment-local cannot run: \`pikit remove\` ${one ? "it" : "them"}, or use deployment-docker`;
}

/** server-bun's port in `pikit.config.ts`, or `undefined` without server-bun (or on a port it picks). */
async function appPort(cwd: string): Promise<number | undefined> {
  const { config } = await projectConfig(cwd);
  const server = config["server-bun"] as { port?: unknown } | undefined;
  return typeof server?.port === "number" && server.port > 0 ? server.port : undefined;
}

async function probe(ctx: Context, port: number, path: string): Promise<Probe> {
  return await ctx.fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.status,
    () => "unreachable" as const,
  );
}

/** `.pikit/logs/`, and `stdio.log` cut when it grew past 10 MB: nothing rotates it but this. */
function prepareLogs(cwd: string): void {
  mkdirSync(join(cwd, ".pikit", "logs"), { recursive: true });
  const stdio = join(cwd, STDIO_LOG);
  if (existsSync(stdio) && statSync(stdio).size > 10 * 1024 * 1024) truncateSync(stdio, 0);
}

/** `app.log`'s files, oldest first. */
function logFiles(cwd: string): string[] {
  const current = join(cwd, APP_LOG);
  const rotated = existsSync(dirname(current))
    ? readdirSync(dirname(current))
        .map((file) => /^app\.log\.(\d+)$/.exec(file)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .sort((a, b) => b - a)
        .map((n) => `${current}.${n}`)
    : [];
  return [...rotated, ...(existsSync(current) ? [current] : [])];
}

/** The last lines of both logs, for an error a person reads. */
function logTails(cwd: string): string {
  const tail = (file: string, n: number) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "").slice(-n) : []);
  const parts = [
    [STDIO_LOG, tail(join(cwd, STDIO_LOG), 15)],
    [APP_LOG, tail(join(cwd, APP_LOG), 15)],
  ] as const;
  return parts
    .filter(([, lines]) => lines.length > 0)
    .map(([file, lines]) => `\n--- the last lines of ${file}:\n${lines.join("\n")}`)
    .join("");
}

/** The project's UI projects: every folder of `src/` with a `package.json`, but `src/pikit/` (as deployment-docker's Dockerfile). */
function uiProjects(cwd: string): string[] {
  const src = join(cwd, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "pikit" && existsSync(join(src, entry.name, "package.json")))
    .map((entry) => `src/${entry.name}`)
    .sort();
}

async function mustRun(ctx: Context, command: readonly string[], cwd: string): Promise<void> {
  const result = await ctx.run(command, { cwd, capture: true });
  if (result.code !== 0) {
    const said = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`\`${command.join(" ")}\` in ${cwd} exited with code ${result.code}, so the service was not restarted${said === "" ? "" : `:\n${said}`}`);
  }
}

function readDotEnv(cwd: string): Record<string, string> {
  const path = join(cwd, ".env");
  return existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>) : {};
}

/** `pikit.json`'s components, as this file reads them; none without `pikit.json`. */
interface InstalledComponent {
  hooks?: Record<string, unknown>;
  compose?: unknown;
  environment?: { name: string; required: boolean }[];
}
function installedComponents(cwd: string): Record<string, InstalledComponent> {
  const path = join(cwd, "pikit.json");
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, "utf8")) as { components?: Record<string, InstalledComponent> }).components ?? {};
}

/** The default App's config in `pikit.config.ts` (its default export's), and a reader of the environment then `.env`. */
async function projectConfig(cwd: string): Promise<{ config: Record<string, unknown>; get(name: string): string | undefined }> {
  const configPath = join(cwd, "pikit.config.ts");
  const app = existsSync(configPath) ? ((await import(pathToFileURL(configPath).href)) as { default?: { config?: unknown } }).default : undefined;
  const config = typeof app?.config === "object" && app.config !== null ? (app.config as Record<string, unknown>) : {};
  const env = readDotEnv(cwd);
  return { config, get: (name) => process.env[name] || env[name] || undefined };
}

/** The installed components' `hook` hooks (project-relative files), in `pikit.json`'s order. */
function deployHooks(cwd: string, hook: "beforeDeploy" | "afterDeploy"): { component: string; file: string }[] {
  return Object.entries(installedComponents(cwd)).flatMap(([component, installed]) => {
    const file = installed.hooks?.[hook];
    return typeof file === "string" ? [{ component, file }] : [];
  });
}

/**
 * What a component's `beforeDeploy` receives (`component.json`'s `hooks.beforeDeploy` names its file),
 * the same shape as deployment-docker's and deployment-cloudflare's. It resolves with its problems.
 */
export interface BeforeDeployIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
  /** Writes `text` to `file`, a file name of the component's own `src/pikit/<name>/`, unless it already holds it. */
  write(file: string, text: string): boolean;
  say(line: string): void;
}

/** What a component's `afterDeploy` receives, once the new process answers: the project's public URL. */
export interface AfterDeployIO {
  url: string;
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
  say(line: string): void;
}

/** Runs every installed component's `beforeDeploy`, then fails with all their problems: nothing is restarted. */
export async function runBeforeDeployHooks(cwd: string, say: (line: string) => void): Promise<void> {
  const hooks = deployHooks(cwd, "beforeDeploy");
  if (hooks.length === 0) return;
  const { config, get } = await projectConfig(cwd);
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
    throw new Error(`what runs before a deploy failed, so nothing was restarted:\n  ${problems.join("\n  ")}\nFix it, then \`pikit up\` again`);
  }
}

/**
 * Runs every installed component's `afterDeploy` with the project's public URL (`PIKIT_PUBLIC_URL`),
 * once the new process answers; without one it runs none and says why. Every hook runs, then `up`
 * fails with all their problems (the service stays up).
 */
export async function runAfterDeployHooks(cwd: string, say: (line: string) => void): Promise<void> {
  const hooks = deployHooks(cwd, "afterDeploy");
  if (hooks.length === 0) return;
  const { config, get } = await projectConfig(cwd);
  const url = get("PIKIT_PUBLIC_URL");
  if (url === undefined) {
    say(`no public URL (PIKIT_PUBLIC_URL), so what runs after a deploy did not run (${hooks.map((hook) => hook.component).join(", ")}): set it to where the platform reaches this machine, then \`pikit up\` again`);
    return;
  }
  const problems: string[] = [];
  for (const hook of hooks) {
    try {
      const module = (await import(pathToFileURL(join(cwd, hook.file)).href)) as { afterDeploy?: unknown };
      if (typeof module.afterDeploy !== "function") {
        problems.push(`${hook.component}: ${hook.file} does not export afterDeploy`);
        continue;
      }
      const own = config[hook.component];
      const io: AfterDeployIO = { url, config: typeof own === "object" && own !== null ? (own as Record<string, unknown>) : {}, get, say };
      const found = (await (module.afterDeploy as (io: AfterDeployIO) => Promise<unknown>)(io)) ?? [];
      if (!Array.isArray(found)) throw new Error("afterDeploy did not resolve with a list of problems");
      for (const problem of found) problems.push(`${hook.component}: ${String(problem)}`);
    } catch (error) {
      problems.push(`${hook.component}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`the service is up at ${url}, but what runs after a deploy failed:\n  ${problems.join("\n  ")}\nFix it, then \`pikit up\` again`);
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

/** The real runner: no shell, so no argument is ever interpreted. */
export const spawnRunner: Runner = (command, { cwd, capture, env }) =>
  new Promise((resolve, reject) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, { cwd, ...(env !== undefined && { env }), stdio: ["inherit", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? resolve({ code: 127, stdout: "", stderr: `\`${file}\` was not found` }) : reject(error)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
