/**
 * `up`, `down`, `restart`, `logs`, `status`, `exec`, `dev` and `doctor` without a supervisor: a fake
 * `Runner` plays systemd or launchd and records every argv, a fake `fetch` answers `/health`, and a
 * temporary home receives the unit or the plist.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dev, doctor, down, exec, logs, restart, type Runner, type RunResult, status, type UpOptions, up } from "./commands.ts";
import { serviceNames } from "./supervisor.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const BUN = "/opt/bun/bin/bun";

/** A project: pikit.json's components, and server-bun on `port` (none: no server-bun). */
function project(options: { components?: Record<string, unknown>; port?: number; env?: string } = {}): string {
  const cwd = tempDir("pikit-local-project-");
  writeFileSync(join(cwd, "pikit.json"), JSON.stringify({ version: 1, targets: ["server"], registries: {}, components: { "deployment-local": {}, ...options.components } }));
  const config = options.port === undefined ? {} : { "server-bun": { port: options.port, hostname: "0.0.0.0" } };
  writeFileSync(join(cwd, "pikit.config.ts"), `export default { config: ${JSON.stringify(config)} };\n`);
  if (options.env !== undefined) writeFileSync(join(cwd, ".env"), options.env);
  return cwd;
}

interface Call {
  command: readonly string[];
  cwd: string;
  env?: Record<string, string>;
}

/**
 * A supervisor that answers as systemd or launchd would: the service is loaded once `up` started it
 * and until `down` stopped it. `answer` overrides any command's result.
 */
function fakeSupervisor(kind: "systemd" | "launchd", options: { loaded?: boolean; answer?: (command: readonly string[]) => RunResult | undefined } = {}) {
  const calls: Call[] = [];
  let loaded = options.loaded ?? false;
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const run: Runner = async (command, { cwd, env }) => {
    calls.push({ command, cwd, ...(env !== undefined && { env }) });
    const answered = options.answer?.(command);
    if (answered !== undefined) return answered;
    const line = command.join(" ");
    if (kind === "systemd") {
      if (line.includes("--property=LoadState")) {
        return ok(loaded ? "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=0\nExecMainStatus=0\n" : "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n");
      }
      if (line.startsWith("systemctl --user restart")) loaded = true;
      if (line.startsWith("systemctl --user disable --now")) loaded = false;
      if (line.startsWith("loginctl")) return ok("Linger=yes\n");
      return ok();
    }
    if (line.startsWith("launchctl print gui/501/")) return loaded ? ok("\tstate = running\n\truns = 1\n\tpid = 777\n") : { code: 113, stdout: "", stderr: "Could not find service" };
    if (line.startsWith("launchctl bootstrap")) loaded = true;
    if (line.startsWith("launchctl bootout")) loaded = false;
    return ok();
  };
  return { calls, run, lines: () => calls.map((call) => call.command.join(" ")) };
}

/** `/health` answers `status` only while the fake supervisor has the service loaded (`up` started it). */
function health(answer: () => number | "refused"): typeof fetch {
  return (async () => {
    const status = answer();
    if (status === "refused") throw new TypeError("connection refused");
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

function options(cwd: string, platform: "linux" | "darwin", run: Runner, extra: Partial<UpOptions> = {}): UpOptions {
  return {
    cwd,
    run,
    platform,
    home: tempDir("pikit-local-home-"),
    uid: 501,
    user: "ada",
    env: { PATH: "/opt/bun/bin:/usr/bin:/bin", HOME: "/home/ada" },
    bun: BUN,
    sleep: async () => {},
    say: () => {},
    ...extra,
  };
}

test("up on Linux: install, write the unit, reload, enable, restart, then wait for /health from the new process", async () => {
  const cwd = project({ port: 3999 });
  const systemd = fakeSupervisor("systemd");
  const said: string[] = [];
  let probed = 0;
  const opts = options(cwd, "linux", systemd.run, {
    say: (line) => said.push(line),
    fetch: health(() => (systemd.lines().some((line) => line.startsWith("systemctl --user restart")) ? (++probed > 1 ? 200 : "refused") : "refused")),
  });

  await up(opts);

  const unit = `${serviceNames(cwd).unit}.service`;
  expect(systemd.lines()).toEqual([
    "systemctl --user show --property=Version",
    `${BUN} install --frozen-lockfile`,
    `systemctl --user show ${unit} --property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus`,
    "systemctl --user daemon-reload",
    `systemctl --user enable ${unit}`,
    `systemctl --user restart ${unit}`,
    // Polled until /health answers: refused once, then 200.
    `systemctl --user show ${unit} --property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus`,
    `systemctl --user show ${unit} --property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus`,
    "loginctl show-user ada --property=Linger",
  ]);
  const written = readFileSync(join(opts.home as string, ".config", "systemd", "user", unit), "utf8");
  expect(written).toContain(`WorkingDirectory=${cwd}\n`);
  expect(written).toContain(`ExecStart="${BUN}" --env-file=.env src/pikit/deployment-local/main.ts\n`);
  expect(written).toContain('Environment="PATH=/opt/bun/bin:/usr/bin:/bin"\n');
  expect(existsSync(join(cwd, ".pikit", "logs"))).toBe(true);
  expect(said).toEqual([]);
});

test("up on macOS: the plist written, unloaded if it was loaded, bootstrapped in the user's session", async () => {
  const cwd = project({ port: 3999 });
  const launchd = fakeSupervisor("launchd", { loaded: true });
  const opts = options(cwd, "darwin", launchd.run, { fetch: health(() => 200) });

  await up(opts);

  const { label } = serviceNames(cwd);
  const plist = join(opts.home as string, "Library", "LaunchAgents", `${label}.plist`);
  expect(launchd.lines()).toEqual([
    "launchctl print gui/501",
    `${BUN} install --frozen-lockfile`,
    `launchctl print gui/501/${label}`,
    // It ran: unloaded first, and waited for until gone, so the new file is the one loaded.
    `launchctl print gui/501/${label}`,
    `launchctl bootout gui/501/${label}`,
    `launchctl print gui/501/${label}`,
    `launchctl print gui/501/${label}`,
    `launchctl enable gui/501/${label}`,
    `launchctl bootstrap gui/501 ${plist}`,
    `launchctl print gui/501/${label}`,
  ]);
  expect(readFileSync(plist, "utf8")).toContain(`<string>${label}</string>`);
});

test("up builds each UI project, every folder of src/ with a package.json but src/pikit/, before the restart", async () => {
  const cwd = project({ port: 3999 });
  for (const dir of ["dashboard", "chat", "pikit", "agents"]) mkdirSync(join(cwd, "src", dir), { recursive: true });
  for (const dir of ["dashboard", "chat", "pikit"]) writeFileSync(join(cwd, "src", dir, "package.json"), "{}");
  const systemd = fakeSupervisor("systemd");
  await up(options(cwd, "linux", systemd.run, { fetch: health(() => (systemd.lines().some((line) => line.startsWith("systemctl --user restart")) ? 200 : "refused")) }));
  const builds = systemd.calls.filter((call) => call.command[0] === BUN).map((call) => `${call.command.slice(1).join(" ")} @ ${call.cwd.slice(cwd.length) || "."}`);
  expect(builds).toEqual([
    "install --frozen-lockfile @ .",
    "install --frozen-lockfile @ /src/chat",
    "--bun run build @ /src/chat",
    "install --frozen-lockfile @ /src/dashboard",
    "--bun run build @ /src/dashboard",
  ]);
});

test("a failed install or build stops up before the running service is touched", async () => {
  const cwd = project({ port: 3999 });
  const systemd = fakeSupervisor("systemd", { answer: (command) => (command[1] === "install" ? { code: 1, stdout: "", stderr: "lockfile had changes" } : undefined) });
  await expect(up(options(cwd, "linux", systemd.run, { fetch: health(() => 200) }))).rejects.toThrow("so the service was not restarted:\nlockfile had changes");
  expect(systemd.lines().some((line) => line.includes("restart"))).toBe(false);
});

test("a beforeDeploy problem stops up before the install, naming the component", async () => {
  const cwd = project({ port: 3999, components: { "tool-a": { hooks: { beforeDeploy: "src/pikit/tool-a/deploy.ts" } } } });
  mkdirSync(join(cwd, "src", "pikit", "tool-a"), { recursive: true });
  writeFileSync(join(cwd, "src", "pikit", "tool-a", "deploy.ts"), 'export async function beforeDeploy() { return ["the MCP server is down"]; }\n');
  const systemd = fakeSupervisor("systemd");
  await expect(up(options(cwd, "linux", systemd.run, { fetch: health(() => 200) }))).rejects.toThrow("what runs before a deploy failed, so nothing was restarted:\n  tool-a: the MCP server is down\n");
  expect(systemd.lines()).toEqual(["systemctl --user show --property=Version"]);
});

test("up runs afterDeploy only once the new service answers, with its public URL", async () => {
  const cwd = project({
    port: 3999,
    env: "PIKIT_PUBLIC_URL=https://agent.example.com\n",
    components: { "channel-a": { hooks: { afterDeploy: "src/pikit/channel-a/deploy.ts" } } },
  });
  mkdirSync(join(cwd, "src", "pikit", "channel-a"), { recursive: true });
  writeFileSync(join(cwd, "src", "pikit", "channel-a", "deploy.ts"), 'export async function afterDeploy(io) { io.say(`hook: ${io.url}`); return []; }\n');
  const systemd = fakeSupervisor("systemd");
  const said: string[] = [];
  await up(options(cwd, "linux", systemd.run, {
    say: (line) => said.push(line),
    fetch: health(() => (systemd.lines().some((line) => line.startsWith("systemctl --user restart")) ? 200 : "refused")),
  }));
  expect(said).toEqual(["hook: https://agent.example.com"]);
  // Without a public URL the service still starts; no webhook is registered.
  writeFileSync(join(cwd, ".env"), "");
  await up(options(cwd, "linux", systemd.run, { say: (line) => said.push(line), fetch: health(() => 200) }));
  expect(said.at(-1)).toContain("no public URL (PIKIT_PUBLIC_URL)");
});

test("up refuses a required variable exported in the CLI shell but absent in the service's .env", async () => {
  const cwd = project({ port: 3999, components: { "channel-http": { environment: [{ name: "PIKIT_HTTP_TOKEN", required: true }] } } });
  const systemd = fakeSupervisor("systemd");
  await expect(up(options(cwd, "linux", systemd.run, { env: { PIKIT_HTTP_TOKEN: "only-in-the-cli" } }))).rejects.toThrow(
    "PIKIT_HTTP_TOKEN is required by channel-http but is not in .env",
  );
  expect(systemd.lines()).toEqual(["systemctl --user show --property=Version"]);
});

test("up refuses a component that runs beside the app in Docker, before anything runs", async () => {
  const cwd = project({ port: 3999, components: { "proposals-local": { compose: "src/pikit/proposals-local/compose.yaml" } } });
  const systemd = fakeSupervisor("systemd");
  await expect(up(options(cwd, "linux", systemd.run))).rejects.toThrow("proposals-local runs beside the app in Docker");
  expect(systemd.lines()).toEqual(["systemctl --user show --property=Version"]);
});

test("up refuses when something else answers on the app's port while the service is not running (pikit dev)", async () => {
  const cwd = project({ port: 3999 });
  const systemd = fakeSupervisor("systemd");
  await expect(up(options(cwd, "linux", systemd.run, { fetch: health(() => 200) }))).rejects.toThrow("something else answers at http://127.0.0.1:3999");
  expect(systemd.lines().some((line) => line.includes("restart"))).toBe(false);
});

test("up fails when /health never answers, with the last lines of both logs; the service stays installed", async () => {
  const cwd = project({ port: 3999 });
  mkdirSync(join(cwd, ".pikit", "logs"), { recursive: true });
  writeFileSync(join(cwd, ".pikit", "logs", "stdio.log"), "error: Cannot find module './missing.ts'\n");
  const systemd = fakeSupervisor("systemd");
  const error = await up(options(cwd, "linux", systemd.run, { fetch: health(() => "refused"), timeoutMs: 50 })).catch((e: Error) => e);
  expect(String(error)).toContain("the app did not answer /health within 0 s (GET /health: unreachable");
  expect(String(error)).toContain("It stays installed and keeps restarting");
  expect(String(error)).toContain("--- the last lines of .pikit/logs/stdio.log:\nerror: Cannot find module './missing.ts'");
  expect(systemd.lines().some((line) => line.startsWith("systemctl --user disable"))).toBe(false);
});

test("up without server-bun waits a moment, then checks the process stayed up", async () => {
  const cwd = project();
  const systemd = fakeSupervisor("systemd");
  const said: string[] = [];
  await up(options(cwd, "linux", systemd.run, { say: (line) => said.push(line) }));
  expect(said[0]).toContain("no server-bun in pikit.config.ts");
});

test("up refuses without a user manager to talk to, and on a platform with neither supervisor", async () => {
  const systemd = fakeSupervisor("systemd", { answer: (command) => (command.includes("--property=Version") ? { code: 1, stdout: "", stderr: "Failed to connect to bus" } : undefined) });
  await expect(up(options(project(), "linux", systemd.run))).rejects.toThrow("no systemd user manager answers");
  await expect(up(options(project(), "win32" as "linux", systemd.run))).rejects.toThrow("win32 has neither: use deployment-docker");
});

test("up says linger is off on Linux, and that the agent's shell runs as you with tool-bash", async () => {
  const cwd = project({ port: 3999, components: { "tool-bash": {}, "execution-local": {} } });
  const systemd = fakeSupervisor("systemd", { answer: (command) => (command[0] === "loginctl" ? { code: 0, stdout: "Linger=no\n", stderr: "" } : undefined) });
  const said: string[] = [];
  await up(
    options(cwd, "linux", systemd.run, {
      say: (line) => said.push(line),
      fetch: health(() => (systemd.lines().some((line) => line.startsWith("systemctl --user restart")) ? 200 : "refused")),
    }),
  );
  expect(said).toEqual([
    "it stops when you log out: `sudo loginctl enable-linger ada` keeps it running (and starts it at boot)",
    "the agent's shell (tool-bash on execution-local) runs as you, with your files: deployment-local's README, \"Isolation\"",
  ]);
});

test("down stops and unloads the service and removes its unit; .pikit/ stays", async () => {
  const cwd = project({ port: 3999 });
  mkdirSync(join(cwd, ".pikit"), { recursive: true });
  writeFileSync(join(cwd, ".pikit", "pikit.db"), "conversations");
  const systemd = fakeSupervisor("systemd", { loaded: true });
  const opts = options(cwd, "linux", systemd.run);
  const unit = `${serviceNames(cwd).unit}.service`;
  const file = join(opts.home as string, ".config", "systemd", "user", unit);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "[Unit]\n");

  await down(opts);

  expect(systemd.lines()).toEqual([`systemctl --user show ${unit} --property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus`, `systemctl --user disable --now ${unit}`, `systemctl --user reset-failed ${unit}`, "systemctl --user daemon-reload"]);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(join(cwd, ".pikit", "pikit.db"), "utf8")).toBe("conversations");
});

test("down leaves the unit in place when systemd fails to stop the app", async () => {
  const cwd = project();
  const unit = `${serviceNames(cwd).unit}.service`;
  const systemd = fakeSupervisor("systemd", {
    loaded: true,
    answer: (command) =>
      command.join(" ").startsWith("systemctl --user disable --now")
        ? { code: 1, stdout: "", stderr: "Failed to stop service" }
        : undefined,
  });
  const opts = options(cwd, "linux", systemd.run);
  const file = join(opts.home as string, ".config", "systemd", "user", unit);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "[Unit]\n");
  await expect(down(opts)).rejects.toThrow("Failed to stop service");
  expect(existsSync(file)).toBe(true);
  expect(systemd.lines()).not.toContain("systemctl --user daemon-reload");
});

test("down on macOS boots the agent out and removes its plist; twice is fine", async () => {
  const cwd = project();
  const launchd = fakeSupervisor("launchd", { loaded: true });
  const opts = options(cwd, "darwin", launchd.run);
  await down(opts);
  await down(opts);
  const { label } = serviceNames(cwd);
  expect(launchd.lines().filter((line) => !line.startsWith("launchctl print"))).toEqual([`launchctl bootout gui/501/${label}`]);
});

test("down leaves the plist in place when launchd fails to unload the agent", async () => {
  const cwd = project();
  const { label } = serviceNames(cwd);
  const launchd = fakeSupervisor("launchd", {
    loaded: true,
    answer: (command) => (command[1] === "bootout" ? { code: 5, stdout: "", stderr: "Input/output error" } : undefined),
  });
  const opts = options(cwd, "darwin", launchd.run);
  const file = join(opts.home as string, "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "<plist/>");
  await expect(down(opts)).rejects.toThrow("Input/output error");
  expect(existsSync(file)).toBe(true);
});

test("restart restarts an installed service, and refuses one that is not", async () => {
  const cwd = project();
  await expect(restart(options(cwd, "linux", fakeSupervisor("systemd").run))).rejects.toThrow("not installed: `pikit up` first");
  const launchd = fakeSupervisor("launchd", { loaded: true });
  await restart(options(cwd, "darwin", launchd.run));
  expect(launchd.lines().at(-1)).toBe(`launchctl kickstart -k gui/501/${serviceNames(cwd).label}`);
});

test("status: the supervisor's view, then /health and /ready", async () => {
  const cwd = project({ port: 3999 });
  const result = await status(options(cwd, "linux", fakeSupervisor("systemd", { loaded: true }).run, { fetch: health(() => 200) }));
  expect(result.lines).toEqual([`systemd ${serviceNames(cwd).unit}.service: active (running) · pid 4242 · 0 restarts`, "GET /health: 200", "GET /ready:  200"]);
  const down = await status(options(cwd, "darwin", fakeSupervisor("launchd").run, { fetch: health(() => "refused") }));
  expect(down.lines[0]).toBe(`launchd ${serviceNames(cwd).label}: not installed (\`pikit up\` installs it)`);
  expect(down.health).toBe("unreachable");
});

test("logs: the rotated files oldest first, then the current one; --tail keeps the last lines", async () => {
  const cwd = project();
  const dir = join(cwd, ".pikit", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.log.2"), "a\nb\n");
  writeFileSync(join(dir, "app.log.1"), "c\n");
  writeFileSync(join(dir, "app.log"), "d\ne\n");
  writeFileSync(join(dir, "stdio.log"), "not the app's\n");
  const all: string[] = [];
  await logs({ cwd, write: (line) => all.push(line) });
  expect(all).toEqual(["a", "b", "c", "d", "e"]);
  const last: string[] = [];
  await logs({ cwd, tail: 2, write: (line) => last.push(line) });
  expect(last).toEqual(["d", "e"]);
});

test("logs --follow prints new lines as they come, and follows the file across a rotation", async () => {
  const cwd = project();
  const dir = join(cwd, ".pikit", "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "app.log");
  writeFileSync(file, "old\n");
  const seen: string[] = [];
  const stop = new AbortController();
  let tick = 0;
  // Each poll of the follow loop: new lines, half a line, the rest, a rotation, then stop.
  const steps = [
    () => writeFileSync(file, "old\nnew 1\nnew", { flag: "w" }),
    () => writeFileSync(file, "old\nnew 1\nnew 2\n"),
    () => {
      rmSync(file);
      writeFileSync(file, "after rotation\n");
    },
    () => stop.abort(),
  ];
  await logs({ cwd, follow: true, tail: 0, signal: stop.signal, write: (line) => seen.push(line), sleep: async () => steps[tick++]?.() });
  expect(seen).toEqual(["new 1", "new 2", "after rotation"]);
});

test("exec runs the command here, in the project, with .env, and the service's Bun for `bun`", async () => {
  const cwd = project({ env: "ANTHROPIC_API_KEY=k\n" });
  const systemd = fakeSupervisor("systemd");
  const code = await exec({ ...options(cwd, "linux", systemd.run), command: ["bun", "/kit/check-credentials.ts", ".", "/tmp/out.json"], share: [{ path: "/kit" }] });
  expect(code).toBe(0);
  expect(systemd.calls[0]?.command).toEqual([BUN, "--env-file=.env", "/kit/check-credentials.ts", ".", "/tmp/out.json"]);
  expect(systemd.calls[0]?.cwd).toBe(cwd);
  expect(systemd.calls[0]?.env?.ANTHROPIC_API_KEY).toBe("k");
});

test("exec does not mistake a key in the CLI shell for one available to the service", async () => {
  const cwd = project({ env: "PIKIT_HTTP_TOKEN=t\n" });
  const systemd = fakeSupervisor("systemd");
  await exec({
    ...options(cwd, "linux", systemd.run, { env: { PATH: "/bin", HOME: "/home/ada", ANTHROPIC_API_KEY: "only-in-the-cli" } }),
    command: ["bun", "/kit/check-credentials.ts"],
  });
  expect(systemd.calls[0]?.env).toEqual({ PATH: "/bin", HOME: "/home/ada", NODE_ENV: "production", PIKIT_HTTP_TOKEN: "t" });
});

test("dev refuses while the service runs: they would share .pikit/ and the port", async () => {
  const cwd = project();
  await expect(dev(options(cwd, "linux", fakeSupervisor("systemd", { loaded: true }).run))).rejects.toThrow("`pikit down` first");
  await expect(dev(options(cwd, "darwin", fakeSupervisor("launchd", { loaded: true }).run))).rejects.toThrow("`pikit down` first");
});

test("doctor: only notes, so `pikit dev` is never blocked; each says what `pikit up` needs", async () => {
  const linux = project({ components: { "expose-cloudflare-tunnel": { compose: "src/pikit/expose-cloudflare-tunnel/compose.yaml" } }, env: "A=1\n" });
  chmodSync(join(linux, ".env"), 0o644);
  const noLinger = fakeSupervisor("systemd", { answer: (command) => (command[0] === "loginctl" ? { code: 0, stdout: "Linger=no\n", stderr: "" } : undefined) });
  const report = await doctor({ config: {}, get: () => undefined }, options(linux, "linux", noLinger.run));
  expect(report.problems).toEqual([]);
  expect(report.notes).toEqual([
    "linger is off: the service stops when you log out (`sudo loginctl enable-linger ada`)",
    "`pikit up` refuses this: expose-cloudflare-tunnel runs beside the app in Docker (`compose` in its component.json), which deployment-local cannot run: `pikit remove` it, or use deployment-docker",
    ".env is readable by other users of this machine: `chmod 600 .env`",
  ]);

  const windows = await doctor({ config: {}, get: () => undefined }, options(project(), "win32" as "linux", noLinger.run));
  expect(windows).toEqual({ problems: [], notes: ["`pikit up` needs systemd (Linux) or launchd (macOS), and win32 has neither: `pikit dev` runs here, `pikit up` does not (use deployment-docker)"] });

  const home = tempDir("pikit-local-home-");
  const documents = join(home, "Documents", "my-bot");
  mkdirSync(documents, { recursive: true });
  writeFileSync(join(documents, "pikit.json"), JSON.stringify({ components: {} }));
  const mac = await doctor({ config: {}, get: () => undefined }, { ...options(documents, "darwin", fakeSupervisor("launchd").run), home });
  expect(mac.notes).toEqual(["the project is under ~/Documents, which macOS keeps from background processes without Full Disk Access: move it (~/agents/…) before `pikit up`"]);
});
