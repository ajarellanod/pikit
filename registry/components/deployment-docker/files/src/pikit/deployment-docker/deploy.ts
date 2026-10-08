/**
 * `pikit deploy watch | install`: the deployer on the host (SPEC §6, on the server). An approved
 * proposal is a merge into the project's main branch on GitHub; this deploys it, outside the
 * container (the app cannot run `docker`), and rolls it back when the new version is unhealthy.
 *
 * `watch` polls, so the host needs no inbound access: every `intervalSeconds` it runs `git fetch` in
 * the project's checkout, and when the branch's upstream (`origin/main`) is a commit not deployed yet:
 * 1. tags the image of the running app as `<image>:pikit-previous`;
 * 2. `git merge --ff-only` to that commit (never a merge commit: local changes stop it), then
 *    `bun install --frozen-lockfile` (`pikit up` loads the project here, with its dependencies);
 * 3. `pikit up` (in a fresh process: the CLI's checks, the `beforeDeploy` hooks, the build, and
 *    Compose's wait for the healthcheck), then `GET /health`;
 * 4. if a step fails or `/health` does not answer 200: puts the previous image back as the app's,
 *    `docker compose up --no-build`, returns the checkout to the deployed commit (`git reset --keep`),
 *    and logs `pikit: <commit> failed /health: rolled back to <previous>`. That commit is not tried
 *    again; the next one is.
 * It never rolls back across a change `irreversible` names (none is known on a server today: the hook
 * is here for one, such as a storage migration).
 *
 * What is deployed is kept in `.pikit/deployer.json` on the host (`deployed`, and the commit that
 * `failed`), so a restarted deployer neither redeploys nor retries. Its first start takes the
 * checkout's `HEAD` as what runs.
 *
 * `install` writes a systemd user service that runs `watch` (`~/.config/systemd/user/`) and enables
 * it. Every command goes through a `Runner`, so tests check the exact argv without git, Docker or
 * systemd.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Runner, spawnRunner } from "./commands.ts";

export const DEFAULT_INTERVAL_SECONDS = 60;

/** What `pikit deploy` passes. */
export interface DeployOptions {
  /** The project's directory: a git checkout of the project's repository. Default: the current directory. */
  cwd?: string;
  /** `watch`: deploy each new commit until stopped; `install`: a systemd user service that runs `watch`. */
  action: "watch" | "install";
  /** How this machine runs `pikit`: a program and its first arguments (the CLI passes its own). */
  cli: readonly string[];
  /** Between two `git fetch`. Default: 60. */
  intervalSeconds?: number;
  /** Stops `watch` between two deploys. */
  signal?: AbortSignal;
  run?: Runner;
  say?: (line: string) => void;
}

/** `pikit deploy watch | install`. */
export async function deploy(options: DeployOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const shared = { cwd, cli: options.cli, ...(options.run !== undefined && { run: options.run }), ...(options.say !== undefined && { say: options.say }) };
  if (options.action === "install") {
    await install({ ...shared, intervalSeconds });
    return;
  }
  await watch({ ...shared, intervalMs: intervalSeconds * 1_000, ...(options.signal !== undefined && { signal: options.signal }) });
}

/**
 * Whether going from the deployed commit `from` to `to` cannot be undone by running the previous
 * image again: the reason, or `undefined`. Nothing is known on a server today (the `.pikit/` volume
 * is shared by both images); a storage migration a previous version cannot read would be one.
 * Edit it here: this file is yours.
 */
export async function noneIrreversible(_change: { from: string; to: string; cwd: string }): Promise<string | undefined> {
  return undefined;
}

export interface WatchOptions {
  cwd: string;
  cli: readonly string[];
  run?: Runner;
  /** Where the deployer's lines go. Default: `console.log` (the journal, under systemd). */
  say?: (line: string) => void;
  /** Whether the new version is healthy once `pikit up` succeeded. Default: `probeHealth()`. */
  health?: () => Promise<boolean>;
  /** Default: `noneIrreversible`. */
  irreversible?: (change: { from: string; to: string; cwd: string }) => Promise<string | undefined>;
  /** Default: 60 s. */
  intervalMs?: number;
  signal?: AbortSignal;
  /** Bun, for `bun install`. Default: the one running this. */
  bun?: string;
}

export type Outcome = "unchanged" | "deployed" | "rolled back" | "failed" | "not deployed" | "fetch failed";

interface DeployerState {
  /** The commit running, as far as the deployer knows. */
  deployed?: string;
  /** The last commit that failed: not tried again. */
  failed?: string;
}

const statePath = (cwd: string) => join(cwd, ".pikit", "deployer.json");
const short = (commit: string) => commit.slice(0, 7);

async function readState(cwd: string): Promise<DeployerState> {
  if (!existsSync(statePath(cwd))) return {};
  return JSON.parse(await readFile(statePath(cwd), "utf8")) as DeployerState;
}

async function writeState(cwd: string, state: DeployerState): Promise<void> {
  await mkdir(join(cwd, ".pikit"), { recursive: true });
  await writeFile(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

/** `git`, `docker` and `pikit` in the project's directory, captured. */
function commands(cwd: string, run: Runner) {
  const exec = async (command: readonly string[]) => {
    const result = await run(command, { cwd, capture: true });
    return { code: result.code, out: result.stdout.trim() };
  };
  const must = async (command: readonly string[]) => {
    const result = await exec(command);
    if (result.code !== 0) throw new Error(`\`${command.join(" ")}\` exited with code ${result.code}`);
    return result.out;
  };
  return { exec, must };
}

/** The app's image (`compose.yaml`'s `app` service): its repository and tag. */
async function appImage(must: (command: readonly string[]) => Promise<string>): Promise<{ repository: string; tag: string }> {
  const config = JSON.parse(await must(["docker", "compose", "config", "--format", "json"])) as { name?: string; services?: Record<string, { image?: string }> };
  const image = config.services?.app?.image ?? `${config.name}-app`;
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/") ? { repository: image.slice(0, colon), tag: image.slice(colon + 1) } : { repository: image, tag: "latest" };
}

/** `GET <url>` answers 200, within `attempts` tries `delayMs` apart. */
export async function probeHealth(options: { url?: string; fetch?: typeof fetch; attempts?: number; delayMs?: number } = {}): Promise<boolean> {
  const url = options.url ?? "http://127.0.0.1:3000/health";
  const fetcher = options.fetch ?? fetch;
  const attempts = options.attempts ?? 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const status = await fetcher(url, { signal: AbortSignal.timeout(5_000) }).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 200) return true;
    if (attempt < attempts) await sleep(options.delayMs ?? 2_000);
  }
  return false;
}

/** One poll: fetch, and deploy the upstream's commit when it is new. */
export async function deployOnce(options: WatchOptions): Promise<Outcome> {
  const { cwd, cli } = options;
  const say = options.say ?? ((line: string) => console.log(line));
  const { exec, must } = commands(cwd, options.run ?? spawnRunner);

  const fetched = await exec(["git", "fetch", "--quiet", "origin"]);
  if (fetched.code !== 0) {
    say(`pikit: git fetch failed (exit code ${fetched.code}); trying again at the next poll`);
    return "fetch failed";
  }
  const target = await must(["git", "rev-parse", "@{upstream}"]);
  const state = await readState(cwd);
  const deployed = state.deployed ?? (await must(["git", "rev-parse", "HEAD"]));
  if (target === deployed || target === state.failed) return "unchanged";

  say(`pikit: deploying ${short(target)} (running ${short(deployed)})`);
  const image = await appImage(must);
  const previous = `${image.repository}:pikit-previous`;
  // The running app's image, kept under a tag of its own before anything is built.
  const container = (await exec(["docker", "compose", "ps", "--quiet", "app"])).out.split("\n")[0] ?? "";
  const running = container === "" ? undefined : await exec(["docker", "inspect", "--format", "{{.Image}}", container]);
  const kept = running !== undefined && running.code === 0 && (await exec(["docker", "tag", running.out, previous])).code === 0;

  if ((await must(["git", "rev-parse", "HEAD"])) !== target) {
    const merged = await exec(["git", "merge", "--ff-only", "--quiet", target]);
    if (merged.code !== 0) {
      await writeState(cwd, { deployed, failed: target });
      say(`pikit: ${short(target)} is not a fast-forward of this checkout (a local commit or change?): not deployed. Clean the checkout; the next commit is deployed`);
      return "not deployed";
    }
  }

  // Their output streams to the deployer's (the journal).
  const stream = (command: readonly string[]) => (options.run ?? spawnRunner)(command, { cwd, capture: false });
  let failure: string | undefined;
  const installed = await stream([options.bun ?? process.execPath, "install", "--frozen-lockfile"]);
  if (installed.code !== 0) failure = `failed (bun install exited with code ${installed.code})`;
  else {
    const up = await stream([...cli, "up"]);
    if (up.code !== 0) failure = `failed (pikit up exited with code ${up.code})`;
    else if (!(await (options.health ?? probeHealth)())) failure = "failed /health";
  }
  if (failure === undefined) {
    await writeState(cwd, { deployed: target });
    say(`pikit: deployed ${short(target)}`);
    return "deployed";
  }
  await writeState(cwd, { deployed, failed: target });
  const failed = `pikit: ${short(target)} ${failure}`;

  const reason = await (options.irreversible ?? noneIrreversible)({ from: deployed, to: target, cwd });
  if (reason !== undefined) {
    say(`${failed}: not rolled back, because ${reason}. Roll back by hand`);
    return "failed";
  }
  if (!kept) {
    say(`${failed}: no previous image to roll back to`);
    return "failed";
  }
  const restored =
    (await exec(["docker", "tag", previous, `${image.repository}:${image.tag}`])).code === 0 &&
    (await exec(["docker", "compose", "up", "--detach", "--no-build", "--force-recreate", "--wait"])).code === 0;
  // The checkout matches what runs again, so a `pikit up` by hand builds it.
  const reset = await exec(["git", "reset", "--quiet", "--keep", deployed]);
  if (!restored) {
    say(`${failed}; rolling back to ${short(deployed)} failed too: see \`pikit status\` and \`pikit logs\``);
    return "failed";
  }
  say(`${failed}: rolled back to ${short(deployed)}${reset.code === 0 ? "" : ` (the checkout stays at ${short(target)}: \`git reset --keep ${short(deployed)}\` failed)`}`);
  return "rolled back";
}

/** Deploys each new commit of the checkout's upstream until `signal` aborts; a failed poll is logged, never fatal. */
export async function watch(options: WatchOptions): Promise<void> {
  const say = options.say ?? ((line: string) => console.log(line));
  const upstream = await upstreamOf(options.cwd, options.run ?? spawnRunner);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_SECONDS * 1_000;
  say(`pikit: deploying each new commit of ${upstream} in ${options.cwd}, polling every ${Math.round(intervalMs / 1_000)} s`);
  while (options.signal?.aborted !== true) {
    try {
      await deployOnce({ ...options, say });
    } catch (error) {
      say(`pikit: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await sleep(intervalMs, undefined, options.signal === undefined ? {} : { signal: options.signal });
    } catch {
      break;
    }
  }
  say("pikit: deployer stopped");
}

/** The branch the checkout follows (`origin/main`); refuses a checkout that follows none. */
async function upstreamOf(cwd: string, run: Runner): Promise<string> {
  const result = await commands(cwd, run).exec(["git", "rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (result.code !== 0 || result.out === "") {
    throw new Error(`${cwd} is not a git checkout whose branch follows one on GitHub: clone the project's repository there, or \`git branch --set-upstream-to origin/main\``);
  }
  return result.out;
}

export interface InstallOptions {
  cwd: string;
  cli: readonly string[];
  intervalSeconds: number;
  run?: Runner;
  say?: (line: string) => void;
  /** Where systemd reads user units from. Default: `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user`. */
  unitDirectory?: string;
  /** The `PATH` the service runs with (git, docker). Default: this one. */
  path?: string;
  /** Default: this OS user. */
  user?: string;
}

/** The service's name: one per project directory. */
export function serviceName(cwd: string): string {
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `pikit-deploy-${slug || "project"}.service`;
}

/** One systemd argument: quoted when it must be, with `%` and `$` escaped (systemd expands both). */
function systemdWord(word: string): string {
  const escaped = word.replaceAll("%", "%%").replaceAll("$", "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The systemd user unit that runs `pikit deploy watch` in `cwd`. */
export function systemdUnit(options: { cwd: string; cli: readonly string[]; intervalSeconds: number; path: string }): string {
  const exec = [...options.cli, "deploy", "watch", "--interval", String(options.intervalSeconds)].map(systemdWord).join(" ");
  return `# pikit's deployer for ${options.cwd} (deployment-docker): written by \`pikit deploy install\`.
# It deploys each new commit of the checkout's upstream with \`pikit up\`, and rolls back when unhealthy.
# Logs: journalctl --user -u ${serviceName(options.cwd)} -f
[Unit]
Description=pikit deployer: ${options.cwd.replaceAll("%", "%%")}

[Service]
Type=simple
WorkingDirectory=${options.cwd.replaceAll("%", "%%")}
Environment=${systemdWord(`PATH=${options.path}`)}
ExecStart=${exec}
Restart=always
RestartSec=30
# SIGTERM reaches the deployer alone, which stops after the deploy in progress (a build can be long).
KillMode=mixed
TimeoutStopSec=15min

[Install]
WantedBy=default.target
`;
}

/** Writes the unit, enables and starts it; says how to keep it running after logout. Resolves with the unit's path. */
export async function install(options: InstallOptions): Promise<string> {
  const run = options.run ?? spawnRunner;
  const say = options.say ?? ((line: string) => console.log(line));
  await upstreamOf(options.cwd, run);
  const directory = options.unitDirectory ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
  const name = serviceName(options.cwd);
  const path = join(directory, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path, systemdUnit({ cwd: options.cwd, cli: options.cli, intervalSeconds: options.intervalSeconds, path: options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" }));
  say(`wrote ${path}`);
  const systemctl = async (...args: string[]) => {
    try {
      return await run(["systemctl", "--user", ...args], { cwd: options.cwd, capture: true });
    } catch {
      throw new Error("`systemctl` was not found: `pikit deploy install` sets up a systemd user service (Linux). Elsewhere, run `pikit deploy watch` under a supervisor of your own");
    }
  };
  for (const args of [["daemon-reload"], ["enable", "--now", name]]) {
    const result = await systemctl(...args);
    if (result.code !== 0) throw new Error(`\`systemctl --user ${args.join(" ")}\` exited with code ${result.code}`);
  }
  say(`started ${name}: it deploys each new commit; logs: journalctl --user -u ${name} -f`);
  const user = options.user ?? userInfo().username;
  const linger = await run(["loginctl", "show-user", user, "--property=Linger", "--value"], { cwd: options.cwd, capture: true }).catch(() => ({ code: 1, stdout: "" }));
  if (linger.stdout.trim() !== "yes") say(`to keep it running after you log out and start it at boot: sudo loginctl enable-linger ${user}`);
  return path;
}
