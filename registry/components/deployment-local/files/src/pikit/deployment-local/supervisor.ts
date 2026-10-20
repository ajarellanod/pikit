/**
 * The supervisor that keeps the app running on this machine: systemd's user manager on Linux,
 * launchd's user agents on macOS. Both run the same program, `<bun> --env-file=.env
 * src/pikit/deployment-local/main.ts`, in the project's directory, restart it whenever it exits, and
 * stop it with SIGTERM and 20 s before SIGKILL (the entrypoint's stop deadline is 10 s).
 *
 * The unit and the plist are written from this component's templates (`pikit.service`,
 * `pikit.plist`: edit them, then `pikit up`), with `{{…}}` filled in by `render`. Every command goes
 * through a `Runner`, so tests check the exact `systemctl` and `launchctl` argv without a supervisor.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The process the supervisor runs, relative to the project. */
export const ENTRY = "src/pikit/deployment-local/main.ts";
/** What the process writes before its logger exists (an import error, a crash): the supervisor's stdout and stderr. */
export const STDIO_LOG = ".pikit/logs/stdio.log";
/** The app's JSON lines (`main.ts`'s logger), rotated. */
export const APP_LOG = ".pikit/logs/app.log";
/** The supervisor's stop budget, above the entrypoint's stop deadline (10 s); `files.test.ts` keeps them apart. */
export const STOP_BUDGET_S = 20;

export interface RunResult {
  code: number;
  /** Captured output; empty when it went to the terminal. */
  stdout: string;
  /** Captured errors; empty when they went to the terminal. */
  stderr: string;
}

/**
 * Runs `command` in `cwd`, without a shell, with `env` (default: this process's). With `capture`, stdout
 * and stderr are returned; without it, they stream to the terminal.
 */
export type Runner = (command: readonly string[], options: { cwd: string; capture: boolean; env?: Record<string, string> }) => Promise<RunResult>;

export type SupervisorKind = "systemd" | "launchd";

/** The supervisor of `platform` (`process.platform`), or `undefined` where deployment-local does not run. */
export function supervisorKind(platform: string): SupervisorKind | undefined {
  return platform === "linux" ? "systemd" : platform === "darwin" ? "launchd" : undefined;
}

export interface ServiceNames {
  /** systemd's unit name, without `.service`: `pikit-<project>-<hash>`. */
  unit: string;
  /** launchd's label: `dev.pikit.<project>.<hash>`. */
  label: string;
}

/**
 * The service's names, from the project's absolute path: its folder's name, and 8 hex digits of the
 * path's SHA-256, so two projects of the same name never share a service, and moving a project makes
 * a new one (`pikit down` before moving it).
 */
export function serviceNames(projectDir: string): ServiceNames {
  const slug =
    basename(projectDir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 8);
  return { unit: `pikit-${slug}-${hash}`, label: `dev.pikit.${slug}.${hash}` };
}

/** What the unit and the plist are filled in with: everything the process needs, nothing secret. */
export interface ServiceSettings {
  /** The project's absolute path: the working directory. */
  project: string;
  /** The absolute path of the Bun that runs the app (the CLI's, `process.execPath`, at `up`). */
  bun: string;
  /** `PATH`, as the shell that ran `up` has it: the agent's shell needs your tools. */
  path: string;
  /** `HOME`. */
  home: string;
}

/** Where `pikit up` writes the service's file, under `home`. */
export function serviceFile(kind: SupervisorKind, home: string, names: ServiceNames): string {
  return kind === "systemd" ? join(home, ".config", "systemd", "user", `${names.unit}.service`) : join(home, "Library", "LaunchAgents", `${names.label}.plist`);
}

/** The template of `kind`, this component's own file. */
export function readTemplate(kind: SupervisorKind): string {
  return readFileSync(join(import.meta.dir, kind === "systemd" ? "pikit.service" : "pikit.plist"), "utf8");
}

/**
 * Fills in `template`'s `{{NAME}}`s, each escaped for where it stands: inside a systemd unit's quoted
 * value, or a plist's `<string>`. Throws on a placeholder it does not know, or a project path a unit
 * cannot hold.
 */
export function render(kind: SupervisorKind, template: string, settings: ServiceSettings, names: ServiceNames): string {
  if (kind === "systemd" && /[\s"'\\$%;]/.test(settings.project)) {
    throw new Error(`deployment-local: the project's path (${settings.project}) has a space or one of "'\\$%; which a systemd unit cannot hold as a path: move the project to a plain path`);
  }
  const values: Record<string, string> = {
    DESCRIPTION: `pikit: ${basename(settings.project)} (${settings.project})`,
    PROJECT: settings.project,
    BUN: settings.bun,
    PATH: settings.path,
    HOME: settings.home,
    STDIO: join(settings.project, STDIO_LOG),
    LABEL: names.label,
    UNIT: names.unit,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`deployment-local: the ${kind === "systemd" ? "pikit.service" : "pikit.plist"} template names {{${name}}}, which is not one of ${Object.keys(values).join(", ")}`);
    if (kind === "launchd") return xml(value);
    // In a unit, `%` starts a specifier: doubled. In ExecStart (Bun's path) `$` starts a variable:
    // doubled there only, as `Environment=` takes it literally. Quotes and backslashes are escaped for
    // the quoted values the template puts them in.
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
    return name === "BUN" ? escaped.replace(/\$/g, "$$$$") : escaped;
  });
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The service as its supervisor sees it. */
export interface ServiceState {
  /** Its file is loaded: `pikit up` installed it and `pikit down` did not remove it. */
  installed: boolean;
  /** Running, starting, or waiting to be restarted: the app's storage and port are taken. */
  active: boolean;
  pid?: number;
  /** Restarts since it was loaded. */
  restarts?: number;
  /** The last exit's code, once it exited. */
  lastExit?: number;
  /** One line: `active (running) · pid 123 · 2 restarts · last exit 1`. */
  summary: string;
}

const NOT_INSTALLED: ServiceState = { installed: false, active: false, summary: "not installed (`pikit up` installs it)" };

/** `systemctl --user show <unit> --property=…`'s `Key=value` lines. */
export function parseSystemdShow(stdout: string): ServiceState {
  const props = Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (props.LoadState !== "loaded") return NOT_INSTALLED;
  const active = ["active", "activating", "deactivating", "reloading"].includes(props.ActiveState ?? "");
  const pid = Number(props.MainPID);
  const restarts = Number(props.NRestarts);
  const lastExit = Number(props.ExecMainStatus);
  return describe({
    installed: true,
    active,
    ...(pid > 0 && { pid }),
    ...(Number.isFinite(restarts) && props.NRestarts !== undefined && { restarts }),
    ...(Number.isFinite(lastExit) && props.ExecMainStatus !== undefined && !(active && lastExit === 0) && { lastExit }),
    summary: `${props.ActiveState ?? "unknown"} (${props.SubState ?? "unknown"})`,
  });
}

/** `launchctl print gui/<uid>/<label>`: its exit code (113 when the service is not loaded) and output. */
export function parseLaunchctlPrint(code: number, stdout: string): ServiceState {
  if (code !== 0) return NOT_INSTALLED;
  // The service's own keys are indented by one tab; nested dictionaries (endpoints…) by more.
  const field = (key: string): string | undefined => new RegExp(`^\\t${key} = (.*)$`, "m").exec(stdout)?.[1]?.trim();
  const state = field("state") ?? "unknown";
  const pid = Number(field("pid"));
  const runs = Number(field("runs"));
  const lastExit = Number(field("last exit code"));
  return describe({
    installed: true,
    // Loaded with KeepAlive, it runs or is about to run again (`spawn scheduled`, throttled).
    active: true,
    ...(pid > 0 && { pid }),
    ...(runs > 0 && { restarts: runs - 1 }),
    ...(Number.isFinite(lastExit) && { lastExit }),
    summary: state,
  });
}

function describe(state: ServiceState): ServiceState {
  const parts = [state.summary];
  if (state.pid !== undefined) parts.push(`pid ${state.pid}`);
  if (state.restarts !== undefined) parts.push(`${state.restarts} restart${state.restarts === 1 ? "" : "s"}`);
  if (state.lastExit !== undefined) parts.push(`last exit ${state.lastExit}`);
  return { ...state, summary: parts.join(" · ") };
}

/** What a command needs to reach the supervisor. */
export interface SupervisorContext {
  run: Runner;
  cwd: string;
  /** The user's id: launchd's `gui/<uid>` domain. */
  uid: number;
  /** The user's name: systemd's linger (`loginctl`). */
  user: string;
  names: ServiceNames;
  /** The service's file (`serviceFile`), which launchd loads by path. */
  file: string;
  /** Between two checks of a stopping service. Default: `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Supervisor {
  kind: SupervisorKind;
  /** A problem when the supervisor cannot be reached from here (no user manager, no GUI session). */
  check(): Promise<string | undefined>;
  /** Loads the written file and starts the service, restarting it when it ran: the new files run. */
  start(): Promise<void>;
  /** Stops the service and unloads it; nothing when it is not loaded. The file stays: the caller removes it. */
  stop(): Promise<void>;
  /** Called once the file is gone (systemd forgets the unit). */
  forget(): Promise<void>;
  /** A stop and a fresh process, the files as they are. */
  restart(): Promise<void>;
  state(): Promise<ServiceState>;
  /** Linux: whether it keeps running after you log out (linger); `undefined` when not known or not asked. */
  lingers(): Promise<boolean | undefined>;
}

export function createSupervisor(kind: SupervisorKind, ctx: SupervisorContext): Supervisor {
  return kind === "systemd" ? systemd(ctx) : launchd(ctx);
}

async function must(ctx: SupervisorContext, command: readonly string[]): Promise<RunResult> {
  const result = await ctx.run(command, { cwd: ctx.cwd, capture: true });
  if (result.code !== 0) {
    const said = (result.stderr || result.stdout).trim();
    throw new Error(`\`${command.join(" ")}\` exited with code ${result.code}${said === "" ? "" : `: ${said}`}`);
  }
  return result;
}

function systemd(ctx: SupervisorContext): Supervisor {
  const unit = `${ctx.names.unit}.service`;
  const systemctl = (...args: string[]) => ["systemctl", "--user", ...args];
  return {
    kind: "systemd",
    async check() {
      const result = await ctx.run(systemctl("show", "--property=Version"), { cwd: ctx.cwd, capture: true });
      if (result.code === 0) return undefined;
      return "no systemd user manager answers (`systemctl --user`): log in as this user over SSH or a desktop session (not `su`), or use deployment-docker";
    },
    async start() {
      await must(ctx, systemctl("daemon-reload"));
      await must(ctx, systemctl("enable", unit));
      await must(ctx, systemctl("restart", unit));
    },
    async stop() {
      // A unit that is not there is not an error: `down` twice is `down`. A stop that failed must
      // leave its file in place, not orphan a process whose source `pikit remove` might delete.
      if ((await this.state()).installed) await must(ctx, systemctl("disable", "--now", unit));
      await ctx.run(systemctl("reset-failed", unit), { cwd: ctx.cwd, capture: true });
    },
    async forget() {
      await ctx.run(systemctl("daemon-reload"), { cwd: ctx.cwd, capture: true });
    },
    async restart() {
      await must(ctx, systemctl("restart", unit));
    },
    async state() {
      const result = await ctx.run(systemctl("show", unit, "--property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus"), { cwd: ctx.cwd, capture: true });
      return result.code === 0 ? parseSystemdShow(result.stdout) : NOT_INSTALLED;
    },
    async lingers() {
      const result = await ctx.run(["loginctl", "show-user", ctx.user, "--property=Linger"], { cwd: ctx.cwd, capture: true });
      if (result.code !== 0) return undefined;
      const value = /Linger=(\w+)/.exec(result.stdout)?.[1];
      return value === undefined ? undefined : value === "yes";
    },
  };
}

function launchd(ctx: SupervisorContext): Supervisor {
  const domain = `gui/${ctx.uid}`;
  const target = `${domain}/${ctx.names.label}`;
  const sleep = ctx.sleep ?? ((ms: number) => Bun.sleep(ms));
  const loaded = async () => (await ctx.run(["launchctl", "print", target], { cwd: ctx.cwd, capture: true })).code === 0;
  const self: Supervisor = {
    kind: "launchd",
    async check() {
      const result = await ctx.run(["launchctl", "print", domain], { cwd: ctx.cwd, capture: true });
      if (result.code === 0) return undefined;
      return `no launchd session for this user (\`launchctl print ${domain}\`): log in at the Mac (a user agent runs in your login session), or use deployment-docker`;
    },
    async start() {
      // launchd has no "restart with the new file": unload (waiting until it is gone), then load.
      await self.stop();
      // A service disabled by hand (`launchctl disable`) would refuse to load.
      await ctx.run(["launchctl", "enable", target], { cwd: ctx.cwd, capture: true });
      const bootstrap = ["launchctl", "bootstrap", domain, ctx.file];
      const first = await ctx.run(bootstrap, { cwd: ctx.cwd, capture: true });
      if (first.code === 0) return;
      // `bootstrap` right after a `bootout` sometimes fails with an I/O error (5) while launchd settles.
      await sleep(1_000);
      await must(ctx, bootstrap);
    },
    async stop() {
      if (!(await loaded())) return;
      await must(ctx, ["launchctl", "bootout", target]);
      // bootout returns before the process is gone; the next bootstrap needs it gone. ExitTimeOut is
      // 20 s, so 30 s covers a stop that runs to its deadline.
      for (let waited = 0; waited < 30_000 && (await loaded()); waited += 250) await sleep(250);
      if (await loaded()) throw new Error(`launchd has not unloaded ${target} after 30 s: the plist stays; stop it before removing the component`);
    },
    async forget() {},
    async restart() {
      await must(ctx, ["launchctl", "kickstart", "-k", target]);
    },
    async state() {
      const result = await ctx.run(["launchctl", "print", target], { cwd: ctx.cwd, capture: true });
      return parseLaunchctlPrint(result.code, result.stdout);
    },
    async lingers() {
      return undefined;
    },
  };
  return self;
}
