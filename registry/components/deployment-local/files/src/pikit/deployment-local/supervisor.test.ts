/**
 * The supervisor's side without a supervisor: the service's names, the unit and the plist as `up`
 * writes them (their promises: the stop budget above the stop deadline, restart always, `.env` only,
 * no secret), the escaping of what fills them in, and the parsing of `systemctl show` and
 * `launchctl print`. On macOS, `plutil -lint` checks the plist; on Linux with systemd,
 * `systemd-analyze verify` checks the unit.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_DEADLINE_MS } from "./entrypoint.ts";
import { ENTRY, parseLaunchctlPrint, parseSystemdShow, readTemplate, render, STDIO_LOG, STOP_BUDGET_S, serviceFile, serviceNames, supervisorKind } from "./supervisor.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const settings = { project: "/srv/agents/my-bot", bun: "/home/ada/.bun/bin/bun", path: "/home/ada/.bun/bin:/usr/bin:/bin", home: "/home/ada" };
const names = serviceNames(settings.project);

test("a service is named after its project's folder and path: two projects of one name never share one", () => {
  expect(names.unit).toMatch(/^pikit-my-bot-[0-9a-f]{8}$/);
  expect(names.label).toMatch(/^dev\.pikit\.my-bot\.[0-9a-f]{8}$/);
  expect(serviceNames(settings.project)).toEqual(names);
  expect(serviceNames("/srv/other/my-bot").unit).not.toBe(names.unit);
  expect(serviceNames("/Users/ada/My Agent!").unit).toMatch(/^pikit-my-agent-[0-9a-f]{8}$/);
  expect(serviceNames("/").unit).toMatch(/^pikit-project-[0-9a-f]{8}$/);
});

test("the supervisor of each platform, and where its file goes", () => {
  expect(supervisorKind("linux")).toBe("systemd");
  expect(supervisorKind("darwin")).toBe("launchd");
  expect(supervisorKind("win32")).toBeUndefined();
  expect(serviceFile("systemd", "/home/ada", names)).toBe(`/home/ada/.config/systemd/user/${names.unit}.service`);
  expect(serviceFile("launchd", "/Users/ada", names)).toBe(`/Users/ada/Library/LaunchAgents/${names.label}.plist`);
});

test("the unit: Bun runs main.ts in the project with .env only, restarts always, and stops within its budget", () => {
  const unit = render("systemd", readTemplate("systemd"), settings, names);
  const lines = unit.split("\n");
  expect(lines).toContain(`WorkingDirectory=${settings.project}`);
  expect(lines).toContain(`ExecStart="${settings.bun}" --env-file=.env ${ENTRY}`);
  expect(lines).toContain("Environment=PIKIT_SERVICE=1");
  expect(lines).toContain(`Environment="PATH=${settings.path}"`);
  expect(lines).toContain(`Environment="HOME=${settings.home}"`);
  expect(lines).toContain("Restart=always");
  expect(lines).toContain("StartLimitIntervalSec=0");
  expect(lines).toContain("KillMode=mixed");
  expect(lines).toContain(`TimeoutStopSec=${STOP_BUDGET_S}`);
  expect(lines).toContain(`StandardOutput=append:${join(settings.project, STDIO_LOG)}`);
  expect(lines).toContain("WantedBy=default.target");
  expect(unit).not.toContain("{{");
});

test("the plist: the same program, environment, restart and stop budget", () => {
  const plist = render("launchd", readTemplate("launchd"), settings, names);
  const compact = plist.replace(/\s+/g, "");
  expect(compact).toContain(`<key>Label</key><string>${names.label}</string>`);
  expect(compact).toContain(`<key>ProgramArguments</key><array><string>${settings.bun}</string><string>--env-file=.env</string><string>${ENTRY}</string></array>`);
  expect(compact).toContain(`<key>WorkingDirectory</key><string>${settings.project}</string>`);
  expect(compact).toContain("<key>PIKIT_SERVICE</key><string>1</string>");
  expect(compact).toContain("<key>KeepAlive</key><true/>");
  expect(compact).toContain("<key>RunAtLoad</key><true/>");
  expect(compact).toContain(`<key>ExitTimeOut</key><integer>${STOP_BUDGET_S}</integer>`);
  expect(compact).toContain(`<key>StandardErrorPath</key><string>${join(settings.project, STDIO_LOG)}</string>`);
  expect(plist).not.toContain("{{");
});

test("the supervisor's stop budget leaves the entrypoint's stop deadline room to finish", () => {
  expect(STOP_BUDGET_S * 1000).toBeGreaterThan(STOP_DEADLINE_MS + 5_000);
  expect(readTemplate("systemd")).toContain(`TimeoutStopSec=${STOP_BUDGET_S}\n`);
  expect(readTemplate("launchd").replace(/\s+/g, "")).toContain(`<key>ExitTimeOut</key><integer>${STOP_BUDGET_S}</integer>`);
});

test("what fills them in is escaped: a unit's specifiers and quotes, ExecStart's variables, a plist's XML", () => {
  const odd = { ...settings, bun: '/opt/b"u$n%/bun', path: '/a%b:/c"d:/e$f' };
  const unit = render("systemd", readTemplate("systemd"), odd, names);
  expect(unit).toContain('ExecStart="/opt/b\\"u$$n%%/bun" --env-file=.env');
  // `Environment=` takes `$` literally: only `%` and quotes are escaped there.
  expect(unit).toContain('Environment="PATH=/a%%b:/c\\"d:/e$f"');
  const plist = render("launchd", readTemplate("launchd"), { ...settings, project: "/Users/ada/R&D <agents>" }, names);
  expect(plist).toContain("<string>/Users/ada/R&amp;D &lt;agents&gt;</string>");
});

test("a project path a unit cannot hold is refused, naming it; a plist holds it", () => {
  expect(() => render("systemd", readTemplate("systemd"), { ...settings, project: "/srv/my agents/bot" }, names)).toThrow("/srv/my agents/bot");
  expect(() => render("launchd", readTemplate("launchd"), { ...settings, project: "/Users/ada/my agents/bot" }, names)).not.toThrow();
});

test("a placeholder the template names but render does not know is an error, not a blank", () => {
  expect(() => render("systemd", "Description={{NOPE}}\n", settings, names)).toThrow("{{NOPE}}");
});

test("systemctl show: installed, running, restarts, the last exit", () => {
  expect(parseSystemdShow("LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n")).toEqual({
    installed: false,
    active: false,
    summary: "not installed (`pikit up` installs it)",
  });
  const running = parseSystemdShow("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=2\nExecMainStatus=0\n");
  expect(running).toEqual({ installed: true, active: true, pid: 4242, restarts: 2, summary: "active (running) · pid 4242 · 2 restarts" });
  // Waiting to be restarted still holds the storage and the port: `pikit dev` must wait.
  const restarting = parseSystemdShow("LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nNRestarts=5\nExecMainStatus=1\n");
  expect(restarting.active).toBe(true);
  expect(restarting.summary).toBe("activating (auto-restart) · 5 restarts · last exit 1");
  expect(parseSystemdShow("LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nExecMainStatus=0\n").active).toBe(false);
});

test("launchctl print: not loaded is 113; a loaded agent's own keys, not its nested ones", () => {
  expect(parseLaunchctlPrint(113, "").installed).toBe(false);
  const printed = [
    `gui/501/${names.label} = {`,
    "\tactive count = 1",
    "\tstate = running",
    "\tprogram = /Users/ada/.bun/bin/bun",
    "\truns = 3",
    "\tpid = 777",
    "\tlast exit code = 1",
    "\tendpoints = {",
    "\t\tstate = active",
    "\t}",
    "}",
  ].join("\n");
  expect(parseLaunchctlPrint(0, printed)).toEqual({ installed: true, active: true, pid: 777, restarts: 2, lastExit: 1, summary: "running · pid 777 · 2 restarts · last exit 1" });
  expect(parseLaunchctlPrint(0, "\tstate = not running\n\truns = 1\n\tlast exit code = (never exited)\n").summary).toBe("not running · 0 restarts");
});

test.skipIf(process.platform !== "darwin")("the plist is one launchd reads (plutil -lint)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-local-plist-"));
  dirs.push(dir);
  const file = join(dir, "service.plist");
  writeFileSync(file, render("launchd", readTemplate("launchd"), { ...settings, project: "/Users/ada/R&D agents" }, names));
  const lint = Bun.spawn(["plutil", "-lint", file], { stdout: "pipe", stderr: "pipe" });
  expect(await lint.exited).toBe(0);
});

test.skipIf(process.platform !== "linux" || Bun.which("systemd-analyze") === null)("the unit is one systemd reads (systemd-analyze verify)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-local-unit-"));
  dirs.push(dir);
  const project = join(dir, "project");
  const file = join(dir, `${names.unit}.service`);
  writeFileSync(file, render("systemd", readTemplate("systemd"), { ...settings, project, bun: process.execPath }, names));
  const verify = Bun.spawn(["systemd-analyze", "--user", "verify", file], { stdout: "pipe", stderr: "pipe" });
  const code = await verify.exited;
  const said = await new Response(verify.stderr).text();
  // The working directory need not exist yet; anything else it says is a problem.
  expect(said.split("\n").filter((line) => line.trim() !== "" && !line.includes("WorkingDirectory"))).toEqual([]);
  expect(code === 0 || said.includes("WorkingDirectory")).toBe(true);
});
