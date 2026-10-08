/**
 * The deployer without git, Docker or systemd: a fake host answers each command the way they would
 * (a checkout behind its upstream, a running container, `pikit up` passing or failing), and records
 * the argv of every one.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./commands.ts";
import { deploy, deployOnce, install, probeHealth, serviceName, systemdUnit, watch, type WatchOptions } from "./deploy.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-deployer-"));
  dirs.push(dir);
  return dir;
}

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const NEWER = "c".repeat(40);

/** A fake host: a checkout at `head` whose upstream is at `upstream`, and the app running from OLD's image. */
function fakeHost(options: { head?: string; upstream?: string; running?: boolean; exits?: Record<string, number> } = {}) {
  const host = { head: options.head ?? OLD, upstream: options.upstream ?? OLD, calls: [] as string[], exits: options.exits ?? {} };
  const run: Runner = async (command) => {
    const line = command.join(" ");
    host.calls.push(line);
    const exit = host.exits[line] ?? Object.entries(host.exits).find(([prefix]) => prefix.endsWith(" ") && line.startsWith(prefix))?.[1];
    if (exit !== undefined && exit !== 0) return { code: exit, stdout: "" };
    const answers: Record<string, string> = {
      "git rev-parse @{upstream}": host.upstream,
      "git rev-parse --abbrev-ref @{upstream}": "origin/main",
      "git rev-parse HEAD": host.head,
      "docker compose config --format json": JSON.stringify({ name: "my-agent", services: { app: { build: { context: "." } } } }),
      "docker compose ps --quiet app": options.running === false ? "" : "c0ffee\n",
      "docker inspect --format {{.Image}} c0ffee": "sha256:old-image\n",
    };
    const merge = /^git (?:merge --ff-only --quiet|reset --quiet --keep) ([0-9a-f]{40})$/.exec(line);
    if (merge?.[1] !== undefined) host.head = merge[1];
    return { code: 0, stdout: answers[line] ?? "" };
  };
  return { host, run };
}

function options(cwd: string, run: Runner, extra: Partial<WatchOptions> = {}) {
  const said: string[] = [];
  return { said, options: { cwd, cli: ["pikit"], bun: "bun", run, say: (line: string) => void said.push(line), health: async () => true, ...extra } satisfies WatchOptions };
}

const state = (cwd: string) => JSON.parse(readFileSync(join(cwd, ".pikit", "deployer.json"), "utf8")) as unknown;

test("no new commit: it fetches, and does nothing else", async () => {
  const cwd = project();
  const { host, run } = fakeHost();
  const { options: opts, said } = options(cwd, run);

  expect(await deployOnce(opts)).toBe("unchanged");
  expect(host.calls).toEqual(["git fetch --quiet origin", "git rev-parse @{upstream}", "git rev-parse HEAD"]);
  expect(said).toEqual([]);
});

test("a new commit: the running image kept as pikit-previous, a fast-forward, bun install, pikit up, healthy", async () => {
  const cwd = project();
  const { host, run } = fakeHost({ upstream: NEW });
  const { options: opts, said } = options(cwd, run);

  expect(await deployOnce(opts)).toBe("deployed");
  expect(host.calls).toEqual([
    "git fetch --quiet origin",
    "git rev-parse @{upstream}",
    "git rev-parse HEAD",
    "docker compose config --format json",
    "docker compose ps --quiet app",
    "docker inspect --format {{.Image}} c0ffee",
    "docker tag sha256:old-image my-agent-app:pikit-previous",
    "git rev-parse HEAD",
    `git merge --ff-only --quiet ${NEW}`,
    "bun install --frozen-lockfile",
    "pikit up",
  ]);
  expect(said).toEqual(["pikit: deploying bbbbbbb (running aaaaaaa)", "pikit: deployed bbbbbbb"]);
  expect(state(cwd)).toEqual({ deployed: NEW });

  // Deployed: the next poll does nothing, even if the checkout moved by hand.
  host.calls.length = 0;
  host.head = OLD;
  expect(await deployOnce(opts)).toBe("unchanged");
  expect(host.calls).toEqual(["git fetch --quiet origin", "git rev-parse @{upstream}"]);
});

test("unhealthy after pikit up: the previous image back, the checkout back, and that commit not tried again", async () => {
  const cwd = project();
  const { host, run } = fakeHost({ upstream: NEW });
  const { options: opts, said } = options(cwd, run, { health: async () => false });

  expect(await deployOnce(opts)).toBe("rolled back");
  expect(host.calls.slice(-4)).toEqual([
    "pikit up",
    "docker tag my-agent-app:pikit-previous my-agent-app:latest",
    "docker compose up --detach --no-build --force-recreate --wait",
    `git reset --quiet --keep ${OLD}`,
  ]);
  expect(said.at(-1)).toBe("pikit: bbbbbbb failed /health: rolled back to aaaaaaa");
  expect(host.head).toBe(OLD);
  expect(state(cwd)).toEqual({ deployed: OLD, failed: NEW });

  host.calls.length = 0;
  expect(await deployOnce(opts)).toBe("unchanged");
  expect(host.calls).toEqual(["git fetch --quiet origin", "git rev-parse @{upstream}"]);

  // The next commit is deployed.
  host.upstream = NEWER;
  expect(await deployOnce({ ...opts, health: async () => true })).toBe("deployed");
  expect(host.calls).toContain(`git merge --ff-only --quiet ${NEWER}`);
  expect(state(cwd)).toEqual({ deployed: NEWER });
});

test("pikit up or bun install failing rolls back too, saying which", async () => {
  const up = fakeHost({ upstream: NEW, exits: { "pikit up": 1 } });
  const failedUp = options(project(), up.run);
  expect(await deployOnce(failedUp.options)).toBe("rolled back");
  expect(failedUp.said.at(-1)).toBe("pikit: bbbbbbb failed (pikit up exited with code 1): rolled back to aaaaaaa");

  const bun = fakeHost({ upstream: NEW, exits: { "bun install --frozen-lockfile": 1 } });
  const failedInstall = options(project(), bun.run);
  expect(await deployOnce(failedInstall.options)).toBe("rolled back");
  expect(bun.host.calls).not.toContain("pikit up");
  expect(failedInstall.said.at(-1)).toBe("pikit: bbbbbbb failed (bun install exited with code 1): rolled back to aaaaaaa");
});

test("never rolled back across an irreversible change, nor without a previous image", async () => {
  const marked = fakeHost({ upstream: NEW });
  const irreversible = options(project(), marked.run, { health: async () => false, irreversible: async ({ from, to }) => `${from.slice(0, 1)}→${to.slice(0, 1)} migrates the database` });
  expect(await deployOnce(irreversible.options)).toBe("failed");
  expect(irreversible.said.at(-1)).toBe("pikit: bbbbbbb failed /health: not rolled back, because a→b migrates the database. Roll back by hand");
  expect(marked.host.calls.filter((call) => call.includes("--no-build") || call.includes("reset"))).toEqual([]);

  const first = fakeHost({ upstream: NEW, running: false });
  const nothingRunning = options(project(), first.run, { health: async () => false });
  expect(await deployOnce(nothingRunning.options)).toBe("failed");
  expect(first.host.calls.some((call) => call.startsWith("docker tag"))).toBe(false);
  expect(nothingRunning.said.at(-1)).toBe("pikit: bbbbbbb failed /health: no previous image to roll back to");
});

test("a rollback that fails too says so", async () => {
  const { run } = fakeHost({ upstream: NEW, exits: { "docker compose up --detach --no-build --force-recreate --wait": 1 } });
  const { options: opts, said } = options(project(), run, { health: async () => false });
  expect(await deployOnce(opts)).toBe("failed");
  expect(said.at(-1)).toBe("pikit: bbbbbbb failed /health; rolling back to aaaaaaa failed too: see `pikit status` and `pikit logs`");
});

test("a commit that is not a fast-forward is not deployed; a failed fetch waits for the next poll", async () => {
  const cwd = project();
  const diverged = fakeHost({ upstream: NEW, exits: { [`git merge --ff-only --quiet ${NEW}`]: 128 } });
  const notDeployed = options(cwd, diverged.run);
  expect(await deployOnce(notDeployed.options)).toBe("not deployed");
  expect(diverged.host.calls).not.toContain("pikit up");
  expect(notDeployed.said.at(-1)).toContain("is not a fast-forward of this checkout");

  const offline = fakeHost({ upstream: NEW, exits: { "git fetch --quiet origin": 128 } });
  const fetchFailed = options(project(), offline.run);
  expect(await deployOnce(fetchFailed.options)).toBe("fetch failed");
  expect(offline.host.calls).toEqual(["git fetch --quiet origin"]);
});

test("watch polls until stopped, and a failing poll does not stop it", async () => {
  const cwd = project();
  const { host, run } = fakeHost({ upstream: NEW });
  let polls = 0;
  const controller = new AbortController();
  const failing: Runner = async (command, opts) => {
    if (command.join(" ") === "git fetch --quiet origin" && ++polls === 1) throw new Error("git crashed");
    if (polls === 3) controller.abort();
    return run(command, opts);
  };
  const { options: opts, said } = options(cwd, failing, { intervalMs: 5, signal: controller.signal });

  await watch(opts);

  expect(said[0]).toBe(`pikit: deploying each new commit of origin/main in ${cwd}, polling every 0 s`);
  expect(said).toContain("pikit: git crashed");
  expect(said).toContain("pikit: deployed bbbbbbb");
  expect(said.at(-1)).toBe("pikit: deployer stopped");
  expect(host.calls.filter((call) => call === "pikit up")).toHaveLength(1);
});

test("watch refuses a checkout that follows no branch", async () => {
  const { run } = fakeHost({ exits: { "git rev-parse --abbrev-ref @{upstream}": 128 } });
  await expect(deploy({ cwd: "/srv/my-agent", action: "watch", cli: ["pikit"], run, say: () => {} })).rejects.toThrow("git branch --set-upstream-to origin/main");
});

test("install writes the systemd user unit, enables it, and says how to keep it after logout", async () => {
  const cwd = join(project(), "My Agent");
  const unitDirectory = join(project(), "systemd", "user");
  const { host, run } = fakeHost();
  const said: string[] = [];

  const path = await install({ cwd, cli: ["/usr/local/bin/bun", "/opt/pikit/packages/cli/src/main.ts"], intervalSeconds: 30, run, say: (line) => void said.push(line), unitDirectory, path: "/usr/bin:/bin", user: "pi" });

  expect(serviceName(cwd)).toBe("pikit-deploy-my-agent.service");
  expect(path).toBe(join(unitDirectory, "pikit-deploy-my-agent.service"));
  expect(readFileSync(path, "utf8")).toBe(systemdUnit({ cwd, cli: ["/usr/local/bin/bun", "/opt/pikit/packages/cli/src/main.ts"], intervalSeconds: 30, path: "/usr/bin:/bin" }));
  const unit = readFileSync(path, "utf8");
  expect(unit).toContain(`WorkingDirectory=${cwd}\n`);
  expect(unit).toContain("ExecStart=/usr/local/bin/bun /opt/pikit/packages/cli/src/main.ts deploy watch --interval 30\n");
  expect(unit).toContain("Environment=PATH=/usr/bin:/bin\n");
  expect(unit).toContain("Restart=always\n");
  expect(unit).toContain("KillMode=mixed\n");
  expect(unit).toContain("WantedBy=default.target\n");
  expect(host.calls).toEqual([
    "git rev-parse --abbrev-ref @{upstream}",
    "systemctl --user daemon-reload",
    "systemctl --user enable --now pikit-deploy-my-agent.service",
    "loginctl show-user pi --property=Linger --value",
  ]);
  expect(said.at(-1)).toBe("to keep it running after you log out and start it at boot: sudo loginctl enable-linger pi");
});

test("systemd words are quoted and escaped: spaces, quotes, % and $", () => {
  const unit = systemdUnit({ cwd: "/srv/100%", cli: ["/opt/my bun/bun", 'say "$HOME"'], intervalSeconds: 60, path: "/a b:/c" });
  expect(unit).toContain('ExecStart="/opt/my bun/bun" "say \\"$$HOME\\"" deploy watch --interval 60\n');
  expect(unit).toContain('Environment="PATH=/a b:/c"\n');
  expect(unit).toContain("WorkingDirectory=/srv/100%%\n");
});

test("install without systemd says what to do instead", async () => {
  const { run } = fakeHost();
  const noSystemd: Runner = async (command, opts) => {
    if (command[0] === "systemctl") throw new Error("`systemctl` was not found");
    return run(command, opts);
  };
  await expect(install({ cwd: project(), cli: ["pikit"], intervalSeconds: 60, run: noSystemd, say: () => {}, unitDirectory: join(project(), "units") })).rejects.toThrow(
    "run `pikit deploy watch` under a supervisor of your own",
  );
});

test("probeHealth wants a 200, tries again, and gives up", async () => {
  const answers = [503, 200];
  const probed: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    probed.push(String(input));
    return new Response(null, { status: answers.shift() ?? 503 });
  }) as typeof fetch;
  expect(await probeHealth({ fetch: fakeFetch, delayMs: 1 })).toBe(true);
  expect(probed).toEqual(["http://127.0.0.1:3000/health", "http://127.0.0.1:3000/health"]);

  const refused = (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch;
  expect(await probeHealth({ fetch: refused, attempts: 2, delayMs: 1 })).toBe(false);
});
