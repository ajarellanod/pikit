/**
 * The M1 proof, end to end, as a user runs it (ROADMAP M1): `pikit new my-agent --preset http`,
 * `pikit configure`, then the agent answers. And S3: a component added and removed leaves the
 * project exactly as it was.
 *
 * Slow (it runs `bun install` and the generated project's own tests), so it runs only with
 * `PIKIT_E2E=1`. The Docker half (`pikit up | status | down`) also needs `PIKIT_E2E_DOCKER=1`, a
 * running Docker daemon and port 3000 free; it removes its containers, image and volume.
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigEntry } from "./project/config-file.ts";

const E2E = process.env.PIKIT_E2E === "1";
const DOCKER = E2E && process.env.PIKIT_E2E_DOCKER === "1";
const MAIN = join(import.meta.dir, "main.ts");
const TIMEOUT = 600_000;

const parent = mkdtempSync(join(tmpdir(), "pikit-e2e-"));
const project = join(parent, "my-agent");
afterAll(() => rmSync(parent, { recursive: true, force: true }));

/** Dummies: nothing here reaches a model. */
const DUMMY_KEY = "sk-ant-e2e-dummy-not-a-key";
const timings: Record<string, number> = {};

async function pikit(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: options.cwd ?? project,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

function sh(command: string[], cwd = project) {
  const run = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const git = (...args: string[]) => sh(["git", "-c", "user.email=e2e@pikit.test", "-c", "user.name=e2e", ...args]);

test.skipIf(!E2E)(
  "pikit new --preset http: a project that composes, with one copy of @pikit/core",
  async () => {
    const started = performance.now();
    const created = await pikit(["new", "my-agent", "--preset", "http"], { cwd: parent });
    timings.new = performance.now() - started;
    expect(created.err).not.toContain("✗");
    expect(created.code).toBe(0);

    const cores = [...new Bun.Glob("**/@pikit/core/package.json").scanSync({ cwd: join(project, "node_modules"), followSymlinks: true })];
    expect(cores).toEqual(["@pikit/core/package.json"]);
    const config = readFileSync(join(project, "pikit.config.ts"), "utf8");
    expect(config).toContain("createRuntimePi({ extensions: [permissionGate] }),");
    expect(config).not.toContain("deploymentDocker");
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "doctor prints the graph and asks only for configuration; the copied components' tests pass",
  async () => {
    const doctor = await pikit(["doctor"]);
    expect(doctor.out).toContain("Components, in start order:");
    expect(doctor.out).toContain("http.route: POST /v1/messages → channel-http");
    expect(doctor.err).toContain("PIKIT_HTTP_TOKEN is not set");
    expect(doctor.err).not.toContain("✗");

    const tests = sh([process.execPath, "test"]);
    expect(tests.code).toBe(0);
    expect(sh([process.execPath, "run", "typecheck"]).code).toBe(0);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "configure without a terminal: a generated token and a key from the environment, never printed",
  async () => {
    const started = performance.now();
    const configured = await pikit(["configure", "--yes", "--generate", "PIKIT_HTTP_TOKEN"], { env: { ANTHROPIC_API_KEY: DUMMY_KEY } });
    timings.configure = performance.now() - started;
    expect(configured.code).toBe(0);

    const env = readFileSync(join(project, ".env"), "utf8");
    const token = /^PIKIT_HTTP_TOKEN=([0-9a-f]{64})$/m.exec(env)?.[1] ?? "";
    expect(token).toHaveLength(64);
    expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600);
    expect(configured.out + configured.err).not.toContain(token);
    expect(configured.out + configured.err).not.toContain(DUMMY_KEY);

    const doctor = await pikit(["doctor"], { env: { ANTHROPIC_API_KEY: "" } });
    expect(doctor.out).toContain("pikit doctor: green");
    expect(doctor.code).toBe(0);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "pikit dev answers /health and /ready, and 401 without the token",
  async () => {
    const port = freePort();
    const configPath = join(project, "pikit.config.ts");
    const original = readFileSync(configPath, "utf8");
    writeFileSync(configPath, setConfigEntry(original, "server-bun", `{ port: ${port}, hostname: "127.0.0.1" }`));
    const started = performance.now();
    const dev = Bun.spawn([process.execPath, MAIN, "dev"], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const base = `http://127.0.0.1:${port}`;
      await until(async () => (await fetch(`${base}/ready`).catch(() => undefined))?.status === 200, 30_000);
      timings.devReady = performance.now() - started;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      const anonymous = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(anonymous.status).toBe(401);
    } finally {
      dev.kill("SIGTERM");
      await dev.exited;
      writeFileSync(configPath, original);
    }
    const logs = await new Response(dev.stdout).text();
    expect(logs).toContain('"msg":"pikit: started"');
    expect(logs).toContain('"msg":"pikit: stopped"');
    console.info(
      `e2e timings: new ${ms(timings.new)} (bun install and doctor included), configure ${ms(timings.configure)}, dev to /ready ${ms(timings.devReady)}; new → answering ${ms((timings.new ?? 0) + (timings.configure ?? 0) + (timings.devReady ?? 0))}`,
    );
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "S3: add then remove leaves no trace, and remove refuses to leave a required capability unprovided",
  async () => {
    expect(git("init", "-q").code).toBe(0);
    expect(git("add", "-A").code).toBe(0);
    expect(git("commit", "-qm", "new").code).toBe(0);

    // server-bun brings an npm dependency only it uses (hono); channel-http brings a variable.
    for (const name of ["server-bun", "channel-http"]) {
      expect((await pikit(["remove", name])).code).toBe(0);
      git("add", "-A");
      git("commit", "-qm", `without ${name}`);

      const added = await pikit(["add", name, "--yes"]);
      expect(added.code).toBe(0);
      expect(added.out).toContain("`pikit doctor` is green");
      expect(git("status", "--porcelain").out).not.toBe("");

      const removed = await pikit(["remove", name]);
      expect(removed.code).toBe(0);
      expect(git("status", "--porcelain").out).toBe("");
      expect((await pikit(["doctor"])).code).toBe(0);
      git("reset", "-q", "--hard", "HEAD~1");
      sh([process.execPath, "install"]);
    }

    const refused = await pikit(["remove", "sessions-jsonl"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("conversations-file requires sessions.store");
    expect(git("status", "--porcelain").out).toBe("");

    // A file the user changed is never deleted without --force.
    const edited = join(project, "src/pikit/log-events/fields.ts");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}// mine\n`);
    const kept = await pikit(["remove", "log-events"]);
    expect(kept.code).toBe(1);
    expect(kept.err).toContain("src/pikit/log-events/fields.ts");
    expect((await pikit(["doctor"])).out).toContain("modified: src/pikit/log-events/fields.ts");
    git("checkout", "--", ".");
  },
  TIMEOUT,
);

test.skipIf(!DOCKER)(
  "pikit up, status and down delegate to deployment-docker; credentials are checked where the app runs",
  async () => {
    try {
      // Without the key in .env the container has none, even when this shell exports one.
      const envFile = join(project, ".env");
      writeFileSync(envFile, readFileSync(envFile, "utf8").replace(/^ANTHROPIC_API_KEY=.*\n/m, ""));
      const refused = await pikit(["up"], { env: { ANTHROPIC_API_KEY: DUMMY_KEY } });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('the model provider "anthropic" has no credentials where the app runs');

      // A credential stored in the app's volume, where `pikit configure` logs in for `pikit up` (an
      // OAuth login lands in the same file; a stored key needs no browser).
      const store = `require("node:fs").writeFileSync(".pikit/credentials.json", JSON.stringify({ anthropic: { type: "api_key", key: "${DUMMY_KEY}" } }), { mode: 0o600 })`;
      expect(sh(["docker", "compose", "run", "--rm", "-T", "app", "bun", "--eval", store]).code).toBe(0);
      const configured = await pikit(["configure", "--yes"], { env: { ANTHROPIC_API_KEY: "" } });
      expect(configured.code).toBe(0);
      expect(configured.out).toContain("model provider anthropic: has credentials for `pikit up`");
      expect(configured.out + configured.err).not.toContain(DUMMY_KEY);

      const started = performance.now();
      const up = await pikit(["up"], { env: { ANTHROPIC_API_KEY: "" } });
      expect(up.code).toBe(0);
      console.info(`e2e timings: pikit up ${ms(performance.now() - started)} (image build included)`);
      const status = await pikit(["status"]);
      expect(status.out).toContain("GET /health: 200");
      expect(status.out).toContain("GET /ready:  200");
      expect((await fetch("http://127.0.0.1:3000/v1/messages", { method: "POST", body: "{}" })).status).toBe(401);
      expect((await pikit(["down"])).code).toBe(0);
      expect((await pikit(["status"])).out).toContain("no containers");
    } finally {
      sh(["docker", "compose", "down", "--volumes", "--rmi", "local"]);
    }
  },
  TIMEOUT,
);

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

function ms(value: number | undefined): string {
  return `${((value ?? 0) / 1000).toFixed(1)} s`;
}
