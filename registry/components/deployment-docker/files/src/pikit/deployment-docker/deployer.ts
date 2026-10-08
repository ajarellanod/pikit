/**
 * Self-improvement's deployer on a server (SPEC §6): it deploys the proposals an operator approves
 * in the dashboard, next to the app, with nothing to set up. compose.yaml's `deployer` service runs it
 * (profile `self-improvement`, on when `proposals-local` is installed), started by the same `pikit up`:
 * its own image (git, Bun, Docker's CLI), the Docker socket, the project's directory at `/project`,
 * the app's state volume at `/state` and a volume of its own at `/checks`. The app never gets the
 * socket.
 *
 * What it shares with the app is `/state/self` (the app's `.pikit/self`, proposals-local's):
 * - `project.git`, the proposals repository: it makes it from the project's main branch, and keeps its
 *   `main` there; the steward clones it and pushes branches `pikit/self/<topic>`;
 * - `decisions.json`, the operator's approvals (proposals-local writes them): all it takes from the
 *   app is "this head of this branch was approved";
 * - `deployer.json`, what it writes back: a heartbeat, whether the project can be deployed from, each
 *   approved head's outcome with its checks, the last deploy, rollback and failure.
 *
 * Every `intervalMs` (10 s) it writes its heartbeat, makes or updates the proposals repository's `main`,
 * and deploys the oldest approved head without an outcome:
 * 1. The project must be a git repository on `main` with no uncommitted change (the deployer deploys
 *    main plus the proposal: an edit not committed would be lost): else the approval waits, and says why.
 * 2. In `/checks/repo` (its own clone), the project's main and the proposal's branch are fetched; the
 *    branch must still be at the approved head; a change of the deployment's own files (compose.yaml,
 *    the Dockerfile, `.dockerignore`, `src/pikit/deployment-docker/`) is refused; then it merges:
 *    fast-forward when it can, else a merge commit; a conflict fails it.
 * 3. The checks, each in a container of the deployer's image with no socket and no secret:
 *    `bun install --frozen-lockfile`, `bun run typecheck` when package.json has it, `bun test`; then
 *    the components' `beforeDeploy` hooks (with the project's `.env`). The agent's code runs only
 *    there, never in the deployer.
 * 4. It tags the running app's image `<image>:pikit-previous`, builds the merge (`docker build`), and
 *    recreates `app` (`docker compose up --no-build --force-recreate --wait app`); then `/health` must
 *    answer 200 (`http://app:3000/health`).
 * 5. Deployed: the project's `main` is fast-forwarded to it (as the directory's owner), and so is the
 *    proposals repository's. A failure before step 4 changes nothing; one after it puts the previous
 *    image back (`rolled back`). Either way `main` never moved, and the outcome is recorded.
 *
 * Every command goes through a `Runner` (`commands.ts`), so tests run real git with a fake Docker.
 * Running as root (the socket's), it runs git in a directory as that directory's owner (`setpriv`), so
 * the project's files keep their owner.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeDeployHooks, type Runner, spawnRunner } from "./commands.ts";

export const DEFAULT_INTERVAL_MS = 10_000;

/** The deployment's own files: a proposal never changes them (the deployer and the app's container are the deployment). */
export const FENCED = [/^compose\.ya?ml$/, /^Dockerfile$/, /^\.dockerignore$/, /^src\/pikit\/deployment-docker\//];

/** A step the deployer ran on an approved head (proposals-local reads them as the proposal's checks). */
export interface DeployerCheck {
  name: string;
  state: "passing" | "failing" | "pending" | "skipped";
  detail: string;
}

export interface DeployRecord {
  head: string;
  id?: string;
  message: string;
  at: string;
}

export interface Outcome {
  id?: string;
  outcome: "waiting" | "deploying" | "deployed" | "rolled back" | "failed";
  message: string;
  at: string;
  checks?: DeployerCheck[];
}

/** `deployer.json`: what the deployer writes for the app (proposals-local reads it). */
export interface DeployerState {
  startedAt?: string;
  heartbeatAt?: string;
  project?: { ok: boolean; message: string };
  deploying?: string;
  outcomes?: Record<string, Outcome>;
  lastDeploy?: DeployRecord;
  lastRollback?: DeployRecord;
  lastFailure?: DeployRecord;
}

/** An approval, as proposals-local writes it in `decisions.json`. */
export interface Decision {
  id: string;
  branch: string;
  head: string;
  decision: "approved" | "rejected";
  operator: string;
  at: string;
  title: string;
}

/** Where the deployer is in Docker: found by inspecting its own container (`discover`). */
export interface DockerSetup {
  /** The compose project's name (`com.docker.compose.project`). */
  project: string;
  /** The deployer's own image: the checks' containers run it. */
  image: string;
  /** The volume at `/checks`, which the checks' containers mount too. */
  checksVolume: string;
  /** The app's image, as compose names it. */
  appImage: string;
}

export interface DeployerOptions {
  /** The project's directory. Default `/project`. */
  project?: string;
  /** The shared directory (the app's `.pikit/self`). Default `/state/self`. */
  state?: string;
  /** The deployer's own volume. Default `/checks`. */
  checks?: string;
  mainBranch?: string;
  run?: Runner;
  say?: (line: string) => void;
  /** Whether the new app is healthy. Default: `GET http://app:3000/health` answers 200, within 5 tries. */
  health?: () => Promise<boolean>;
  /** Default: `discover()`. */
  docker?: DockerSetup;
  intervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** Run `command` as `path`'s owner. Default: `setpriv` to the owner when running as root and the owner is another user. */
  asOwner?: (path: string, command: readonly string[]) => readonly string[];
}

const short = (commit: string) => commit.slice(0, 7);
const GIT = ["git", "-c", "safe.directory=*", "-c", "user.name=pikit deployer", "-c", "user.email=deployer@pikit.invalid", "-c", "gc.auto=0"];

/** `command` as `path`'s owner: through `setpriv` when this process is root and the owner is not. */
export function ownerCommand(path: string, command: readonly string[]): readonly string[] {
  if (process.getuid?.() !== 0 || !existsSync(path)) return command;
  const { uid, gid } = statSync(path);
  if (uid === 0) return command;
  return ["setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--", "env", "HOME=/tmp", ...command];
}

/** `GET <url>` answers 200, within `attempts` tries `delayMs` apart. */
export async function probeHealth(options: { url?: string; fetch?: typeof fetch; attempts?: number; delayMs?: number } = {}): Promise<boolean> {
  const url = options.url ?? "http://app:3000/health";
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

/** The deployer's compose project, image and volume, from its own container (`HOSTNAME` is its id). */
export async function discover(run: Runner, projectDir: string): Promise<DockerSetup> {
  const self = process.env.HOSTNAME ?? "";
  const inspected = await run(["docker", "inspect", "--format", "{{json .}}", self], { cwd: "/", capture: true });
  if (inspected.code !== 0) throw new Error(`the deployer cannot inspect its own container (${self}): is the Docker socket mounted?`);
  const container = JSON.parse(inspected.stdout) as { Config?: { Image?: string; Labels?: Record<string, string> }; Mounts?: { Destination?: string; Name?: string }[] };
  const project = container.Config?.Labels?.["com.docker.compose.project"];
  const checksVolume = container.Mounts?.find((mount) => mount.Destination === "/checks")?.Name;
  if (project === undefined || checksVolume === undefined || container.Config?.Image === undefined) throw new Error("the deployer runs only as compose.yaml's deployer service");
  const config = await run([...composeCommand(project, projectDir), "config", "--format", "json"], { cwd: projectDir, capture: true });
  const services = (JSON.parse(config.stdout || "{}") as { services?: Record<string, { image?: string }> }).services;
  return { project, image: container.Config.Image, checksVolume, appImage: services?.app?.image ?? `${project}-app` };
}

/** `docker compose` on the host's project, from inside the deployer. */
function composeCommand(project: string, projectDir: string): string[] {
  return ["docker", "compose", "--project-name", project, "--file", join(projectDir, "compose.yaml"), "--project-directory", projectDir];
}

/** One deployer: `pass()` does what one poll does. */
export function createDeployer(options: DeployerOptions) {
  const projectDir = options.project ?? "/project";
  const stateDir = options.state ?? "/state/self";
  const checksDir = options.checks ?? "/checks";
  const repo = join(checksDir, "repo");
  const bare = join(stateDir, "project.git");
  const main = options.mainBranch ?? "main";
  const run = options.run ?? spawnRunner;
  const say = options.say ?? ((line: string) => console.log(line));
  const now = () => new Date((options.now ?? Date.now)()).toISOString();
  const asOwner = options.asOwner ?? ownerCommand;
  let docker = options.docker;
  const startedAt = now();

  const exec = async (command: readonly string[], cwd = "/") => {
    const result = await run(command, { cwd, capture: true });
    return { code: result.code, out: result.stdout.trim() };
  };
  /** git in `dir`, as its owner. */
  const git = (dir: string, ...args: string[]) => exec(asOwner(dir, [...GIT, "-C", dir, ...args]), dir);
  const must = async (result: Promise<{ code: number; out: string }>, what: string) => {
    const done = await result;
    if (done.code !== 0) throw new Error(`${what} exited with code ${done.code}`);
    return done.out;
  };

  const statePath = join(stateDir, "deployer.json");
  const readState = async (): Promise<DeployerState> => {
    try {
      return JSON.parse(await readFile(statePath, "utf8")) as DeployerState;
    } catch {
      return {};
    }
  };
  const writeState = async (state: DeployerState) => {
    await mkdir(stateDir, { recursive: true });
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, statePath);
  };
  const decisions = async (): Promise<Decision[]> => {
    try {
      return ((JSON.parse(await readFile(join(stateDir, "decisions.json"), "utf8")) as { decisions?: Decision[] }).decisions ?? []).filter((each) => each.decision === "approved");
    } catch {
      return [];
    }
  };

  /** Whether the project can be deployed from: a repository on `main`, nothing uncommitted. */
  const checkProject = async (): Promise<{ ok: boolean; message: string; head?: string }> => {
    const head = await git(projectDir, "rev-parse", "--verify", "--quiet", `refs/heads/${main}`);
    if (head.code !== 0) return { ok: false, message: `${projectDir} is not a git repository with a ${main} branch: self-improvement needs one (\`git init\`, then commit the project)` };
    const branch = await git(projectDir, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (branch.out !== main) return { ok: false, message: `the project's checkout is on ${branch.out || "a detached HEAD"}, not ${main}: approvals wait until it is back on ${main}` };
    const changes = (await git(projectDir, "status", "--porcelain")).out.split("\n").filter((line) => line !== "");
    if (changes.length > 0) {
      const named = changes.slice(0, 5).map((line) => line.replace(/^\s*\S{1,2}\s+/, "")).join(", ");
      return { ok: false, message: `the project has uncommitted changes (${named}${changes.length > 5 ? ", …" : ""}): commit them; approvals wait, since a deploy builds ${main} and would leave them out`, head: head.out };
    }
    return { ok: true, message: `${main} at ${short(head.out)}, nothing uncommitted.`, head: head.out };
  };

  /** Makes the proposals repository when it is missing, and keeps its `main` at the project's. */
  const syncProposals = async (head: string) => {
    if (!existsSync(join(bare, "HEAD"))) {
      say(`pikit deployer: making the proposals repository ${bare} from the project's ${main}`);
      await must(exec(asOwner(stateDir, [...GIT, "init", "--quiet", "--bare", `--initial-branch=${main}`, bare]), stateDir), "git init");
    }
    const current = await exec(asOwner(bare, [...GIT, "--git-dir", bare, "rev-parse", "--verify", "--quiet", `refs/heads/${main}`]));
    if (current.out === head) return;
    await must(exec(asOwner(bare, [...GIT, "--git-dir", bare, "fetch", "--quiet", "--no-tags", projectDir, `+refs/heads/${main}:refs/heads/${main}`])), "git fetch into the proposals repository");
  };

  /** Runs `command` in a container of the deployer's image, on `/checks/repo`, without the socket. */
  const sandbox = async (setup: DockerSetup, command: readonly string[], env?: string) => {
    const { uid, gid } = existsSync(checksDir) ? statSync(checksDir) : { uid: 0, gid: 0 };
    const args = ["docker", "run", "--rm", "--user", `${uid}:${gid}`, "--env", "HOME=/tmp", "--volume", `${setup.checksVolume}:${checksDir}`, "--workdir", repo];
    if (env !== undefined && existsSync(env)) args.push("--env-file", env);
    // Streamed to the deployer's log (`pikit logs`).
    return (await run([...args, setup.image, ...command], { cwd: "/", capture: false })).code;
  };

  /** Deploys `decision`; resolves with its outcome. */
  const deploy = async (setup: DockerSetup, decision: Decision): Promise<Outcome> => {
    const checks: DeployerCheck[] = [];
    const at = () => now();
    const failed = (message: string): Outcome => ({ id: decision.id, outcome: "failed", message, at: at(), checks });
    // 2. The merge, in the deployer's own clone.
    if (!existsSync(join(repo, ".git"))) await must(exec(asOwner(checksDir, [...GIT, "init", "--quiet", repo]), checksDir), "git init");
    await must(git(repo, "fetch", "--quiet", "--no-tags", projectDir, `+refs/heads/${main}:refs/remotes/project/${main}`), "git fetch of the project");
    const fetched = await git(repo, "fetch", "--quiet", "--no-tags", bare, `+refs/heads/${decision.branch}:refs/remotes/self/candidate`);
    const head = fetched.code === 0 ? (await git(repo, "rev-parse", "refs/remotes/self/candidate")).out : "";
    if (head !== decision.head) return failed(head === "" ? `${decision.branch} is gone: nothing to deploy` : `${decision.branch} moved after it was approved (now ${short(head)}): approve its new head to deploy it`);
    const base = await must(git(repo, "rev-parse", `refs/remotes/project/${main}`), "git rev-parse");
    const fork = (await git(repo, "merge-base", base, head)).out;
    const touched = (await git(repo, "diff", "--name-only", fork || base, head)).out.split("\n").filter((path) => FENCED.some((fence) => fence.test(path)));
    if (touched.length > 0) return failed(`it changes the deployment itself (${touched.join(", ")}): such a change is yours to make by hand, never a proposal's`);
    await must(git(repo, "checkout", "--quiet", "--force", "--detach", base), "git checkout");
    await must(git(repo, "clean", "-fdq"), "git clean");
    if ((await git(repo, "merge", "--ff-only", "--quiet", head)).code !== 0) {
      const merged = await git(repo, "merge", "--no-ff", "--quiet", "-m", `Merge ${decision.branch}: ${decision.title} (approved by ${decision.operator})`, head);
      if (merged.code !== 0) {
        await git(repo, "merge", "--abort");
        checks.push({ name: "merge", state: "failing", detail: `conflicts with ${main}` });
        return failed(`it conflicts with ${main} (${short(base)}): ask the agent to start again from the latest ${main}`);
      }
    }
    const candidate = await must(git(repo, "rev-parse", "HEAD"), "git rev-parse");
    checks.push({ name: "merge", state: "passing", detail: candidate === head ? "fast-forward" : `merge commit ${short(candidate)}` });

    // 3. The checks: the agent's code runs only in these containers.
    const scripts = (() => {
      try {
        return ((JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}) as Record<string, string>;
      } catch {
        return {};
      }
    })();
    const steps: [string, string[], string | undefined][] = [
      ["bun install", ["bun", "install", "--frozen-lockfile"], undefined],
      ...(scripts.typecheck === undefined ? [] : [["typecheck", ["bun", "run", "typecheck"], undefined] as [string, string[], undefined]]),
      ["bun test", ["bun", "test"], undefined],
    ];
    for (const [name, command] of steps) {
      const code = await sandbox(setup, command);
      checks.push({ name, state: code === 0 ? "passing" : "failing", detail: code === 0 ? "passed" : `exited with code ${code}` });
      if (code !== 0) return failed(`${name} exited with code ${code}: not deployed`);
    }
    // What the tests left behind does not reach the image.
    await git(repo, "reset", "--quiet", "--hard", candidate);
    await git(repo, "clean", "-fdq");
    if (beforeDeployHooks(repo).length > 0) {
      const code = await sandbox(setup, ["bun", "src/pikit/deployment-docker/before-deploy.ts"], join(projectDir, ".env"));
      checks.push({ name: "beforeDeploy hooks", state: code === 0 ? "passing" : "failing", detail: code === 0 ? "passed" : `exited with code ${code}` });
      if (code !== 0) return failed(`the components' beforeDeploy hooks failed (exit code ${code}): not deployed`);
    }

    // 4. The image, kept, then the new one.
    const compose = composeCommand(setup.project, projectDir);
    const previous = `${setup.appImage}:pikit-previous`;
    const container = (await exec([...compose, "ps", "--quiet", "app"], projectDir)).out.split("\n")[0] ?? "";
    const running = container === "" ? undefined : await exec(["docker", "inspect", "--format", "{{.Image}}", container]);
    const kept = running !== undefined && running.code === 0 && (await exec(["docker", "tag", running.out, previous])).code === 0;
    const built = (await run(["docker", "build", "--tag", `${setup.appImage}:latest`, repo], { cwd: repo, capture: false })).code;
    checks.push({ name: "build", state: built === 0 ? "passing" : "failing", detail: built === 0 ? "built" : `docker build exited with code ${built}` });
    if (built !== 0) return failed(`the image did not build (exit code ${built}): not deployed`);
    const up = [...compose, "up", "--detach", "--no-build", "--force-recreate", "--no-deps", "--wait", "app"];
    const started = (await run(up, { cwd: projectDir, capture: false })).code === 0;
    const healthy = started && (await (options.health ?? probeHealth)());
    checks.push({ name: "/health", state: healthy ? "passing" : "failing", detail: healthy ? "200" : started ? "no 200 from /health" : "the app did not start healthy" });
    if (!healthy) {
      const restored = kept && (await exec(["docker", "tag", previous, `${setup.appImage}:latest`])).code === 0 && (await run(up, { cwd: projectDir, capture: false })).code === 0;
      if (!kept) return failed(`${short(candidate)} failed /health, and there was no previous image to roll back to: see \`pikit status\` and \`pikit logs\``);
      if (!restored) return failed(`${short(candidate)} failed /health; rolling back failed too: see \`pikit status\` and \`pikit logs\``);
      return { id: decision.id, outcome: "rolled back", message: `${short(candidate)} failed /health: rolled back to the previous image`, at: at(), checks };
    }

    // 5. Deployed: the project's main, then the proposals repository's, follow.
    await must(exec(asOwner(projectDir, [...GIT, "-C", projectDir, "fetch", "--quiet", "--no-tags", repo, "+HEAD:refs/pikit/deployed"]), projectDir), "git fetch of the deployed commit");
    const project = await checkProject();
    const forwarded = project.ok && (await git(projectDir, "merge", "--ff-only", "--quiet", "refs/pikit/deployed")).code === 0;
    const note = forwarded ? "" : ` The project's ${main} was not moved (${project.ok ? `it moved meanwhile` : project.message}): merge refs/pikit/deployed there.`;
    return { id: decision.id, outcome: "deployed", message: `deployed ${short(candidate)}${candidate === head ? "" : ` (merged with ${main})`}.${note}`, at: at(), checks };
  };

  return {
    /** One poll: heartbeat, the proposals repository, and the oldest approval not deployed yet. */
    async pass(): Promise<void> {
      const state = await readState();
      state.startedAt = startedAt;
      state.heartbeatAt = now();
      const project = await checkProject();
      state.project = { ok: project.ok, message: project.message };
      if (project.head !== undefined) await syncProposals(project.head);
      const outcomes = (state.outcomes ??= {});
      const next = (await decisions()).filter((decision) => outcomes[decision.head] === undefined || outcomes[decision.head]?.outcome === "waiting").sort((a, b) => a.at.localeCompare(b.at))[0];
      if (next === undefined || !project.ok) {
        if (next !== undefined) outcomes[next.head] = { id: next.id, outcome: "waiting", message: `Waiting: ${project.message}`, at: now() };
        await writeState(state);
        return;
      }
      docker ??= await discover(run, projectDir);
      say(`pikit deployer: deploying ${next.branch} at ${short(next.head)}, approved by ${next.operator}`);
      outcomes[next.head] = { id: next.id, outcome: "deploying", message: "Deploying: merging, checking, building.", at: now() };
      state.deploying = next.id;
      await writeState(state);
      let outcome: Outcome;
      try {
        outcome = await deploy(docker, next);
      } catch (error) {
        outcome = { id: next.id, outcome: "failed", message: error instanceof Error ? error.message : String(error), at: now() };
      }
      const after = await readState();
      after.outcomes = { ...after.outcomes, [next.head]: outcome };
      delete after.deploying;
      const record: DeployRecord = { head: next.head, id: next.id, message: outcome.message, at: outcome.at };
      if (outcome.outcome === "deployed") {
        after.lastDeploy = record;
        const synced = await checkProject();
        if (synced.head !== undefined) await syncProposals(synced.head).catch(() => {});
      } else if (outcome.outcome === "rolled back") after.lastRollback = record;
      else after.lastFailure = record;
      after.heartbeatAt = now();
      await writeState(after);
      say(`pikit deployer: ${next.branch} at ${short(next.head)}: ${outcome.outcome}: ${outcome.message}`);
    },
  };
}

/** Polls until `signal` aborts; a failed poll is logged, never fatal. */
export async function runDeployer(options: DeployerOptions = {}): Promise<void> {
  const say = options.say ?? ((line: string) => console.log(line));
  const deployer = createDeployer({ ...options, say });
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  say(`pikit deployer: deploying approved proposals, polling every ${Math.round(intervalMs / 1000)} s`);
  while (options.signal?.aborted !== true) {
    try {
      await deployer.pass();
    } catch (error) {
      say(`pikit deployer: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await sleep(intervalMs, undefined, options.signal === undefined ? {} : { signal: options.signal });
    } catch {
      break;
    }
  }
  say("pikit deployer: stopped");
}
