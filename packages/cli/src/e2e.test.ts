/**
 * Five minutes, end to end, as a user runs it (SPEC P2): `pikit new my-agent --preset http`,
 * `pikit configure`, then the agent answers a message sent to `pikit dev`. The model is provider-faux
 * (a fake model for tests only, installed here: no account, no network), so the answer is known:
 * `faux: <the message>`, through channel-http, runtime-pi and pi-durable as a real model's would be.
 * And P3: a component added and removed leaves the project exactly as it was.
 *
 * Slow (it runs `bun install` and the generated project's own tests), so it runs only with
 * `PIKIT_E2E=1`. The Docker half (`pikit up | status | down`) also needs `PIKIT_E2E_DOCKER=1`, a
 * running Docker daemon and port 3000 free; it removes its containers, image and volume.
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIKIT_ROOT } from "./paths.ts";
import { setConfigEntry } from "./project/config-file.ts";

const E2E = process.env.PIKIT_E2E === "1";
const DOCKER = E2E && process.env.PIKIT_E2E_DOCKER === "1";
const MAIN = join(import.meta.dir, "main.ts");
const TIMEOUT = 600_000;

const parent = mkdtempSync(join(tmpdir(), "pikit-e2e-"));
const project = join(parent, "my-agent");
afterAll(() => rmSync(parent, { recursive: true, force: true }));

/** A dummy: the agent's model is provider-faux's, and nothing here reaches Anthropic. */
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

/** A command, run to its end. Async: Bun's spawnSync can lose a child's exit (AGENTS.md). */
async function sh(command: string[], cwd = project) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

const git = (...args: string[]) => sh(["git", "-c", "user.email=e2e@pikit.test", "-c", "user.name=e2e", ...args]);

test.skipIf(!E2E)(
  "pikit new --preset http: a project that composes, with one copy of @pikit/core and one of @pikit/contracts",
  async () => {
    const started = performance.now();
    const created = await pikit(["new", "my-agent", "--preset", "http"], { cwd: parent });
    timings.new = performance.now() - started;
    expect(created.err).not.toContain("✗");
    expect(created.code).toBe(0);

    // One copy of the kernel and one of the contracts: two copies would be two sets of contracts.
    for (const kit of ["core", "contracts"]) {
      const copies = [...new Bun.Glob(`**/@pikit/${kit}/package.json`).scanSync({ cwd: join(project, "node_modules"), followSymlinks: true })];
      expect(copies).toEqual([`@pikit/${kit}/package.json`]);
    }
    const config = readFileSync(join(project, "pikit.config.ts"), "utf8");
    expect(config).toContain("    runtimePi,\n");
    expect(config).not.toContain("deploymentDocker");
    // HTTP answers in the response: nothing offers it durable delivery, so none is installed. The
    // runtime provides its record of submissions itself, over the storage the preset names: nothing
    // is installed for it.
    const manifest = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8"));
    expect(Object.keys(manifest.components)).not.toContain("outbound-durable");
    expect(Object.values(manifest.components as Record<string, { installedFor?: string[] }>).filter((c) => c.installedFor !== undefined)).toEqual([]);
    expect(manifest.components["storage-sqlite"].installedFor).toBeUndefined();
    // The neutral conversation registry, over the key-value store the preset names (SPEC C5).
    expect(manifest.components["conversations-kv"].installedFor).toBeUndefined();
    expect(manifest.components["storage-kv-sql"].installedFor).toBeUndefined();
    expect(Object.keys(manifest.components)).not.toContain("conversations-file");
    // tool-bash is installed, but on a server the starter agent does not name it.
    expect(Object.keys(manifest.components)).toContain("tool-bash");
    expect(readFileSync(join(project, "src", "agents", "assistant", "agent.ts"), "utf8")).toContain('tools: ["read","write","edit"],');
    // The README says where pikit is.
    expect(readFileSync(join(project, "README.md"), "utf8")).toContain(`It runs from the kit's checkout at \`${PIKIT_ROOT}\``);
    // Portable: the registry is this CLI's, by name, not by this machine's path.
    expect(manifest.registries).toEqual({ default: "builtin" });
    // On a server the project is a git repository on main, everything committed: the deployer merges there.
    expect((await git("symbolic-ref", "--short", "HEAD")).out.trim()).toBe("main");
    expect((await git("status", "--porcelain")).out).toBe("");
    expect((await git("log", "--format=%s")).out.trim()).toBe("pikit new my-agent");
    // The skills for the user's AI agent come with every project, saying where the kit is.
    for (const skill of ["pikit-component", "pikit-extension"]) {
      const text = readFileSync(join(project, ".agents", "skills", skill, "SKILL.md"), "utf8");
      expect(text).toContain(`name: ${skill}`);
      expect(text).toContain(`${PIKIT_ROOT}/features/memory.md`);
      expect(text).not.toContain("{{PIKIT_");
    }
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

    // A registry of the project's own is left out of `bun test` and `tsc` from the start: there, a
    // failing test and a type error change nothing.
    const local = join(project, "registry", "components", "tool-mine", "files", "src", "pikit", "tool-mine");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "tool-mine.test.ts"), 'import { test } from "bun:test";\ntest("never runs", () => { throw new Error("ran"); });\n');
    writeFileSync(join(local, "index.ts"), "export const wrong: number = 'a string';\n");
    const tests = await sh([process.execPath, "test"]);
    expect(tests.code).toBe(0);
    expect(tests.err).not.toContain("never runs");
    // The installed components come with their READMEs.
    expect(readFileSync(join(project, "src", "pikit", "channel-http", "README.md"), "utf8")).toStartWith("# channel-http");
    expect((await sh([process.execPath, "run", "typecheck"])).code).toBe(0);
    rmSync(join(project, "registry"), { recursive: true });
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
  "pikit dev answers /health and /ready, 401 without the token, and a message with the agent's answer",
  async () => {
    // The starter's prompt says where it is reached: this preset's channel is the HTTP API.
    const agentPath = join(project, "src", "agents", "assistant", "agent.ts");
    const agentBefore = readFileSync(agentPath, "utf8");
    expect(agentBefore).toContain("reached over an HTTP API");
    // A model with no account: provider-faux (tests only), and the starter agent on it.
    const faux = await pikit(["add", "provider-faux", "--yes"]);
    expect(faux.code).toBe(0);
    writeFileSync(agentPath, agentBefore.replace(/model: "[^"]+"/, 'model: "faux/echo"'));

    const port = freePort();
    const configPath = join(project, "pikit.config.ts");
    const original = readFileSync(configPath, "utf8");
    writeFileSync(configPath, setConfigEntry(original, "server-bun", `{ port: ${port}, hostname: "127.0.0.1" }`));
    const token = /^PIKIT_HTTP_TOKEN=(.*)$/m.exec(readFileSync(join(project, ".env"), "utf8"))?.[1] ?? "";
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

      // A message, and the agent's answer in the response: channel-http → router → runtime-pi → the model.
      const send = (text: string, messageId: string) =>
        fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ conversationId: "e2e-1", messageId, text }),
        });
      const first = await send("hello from the e2e", "m1");
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ requestId: "m1", text: "faux: hello from the e2e" });
      timings.answered = performance.now() - started;
      // The same conversation goes on: the second message is answered in it.
      const second = await send("and again", "m2");
      expect(await second.json()).toMatchObject({ requestId: "m2", text: "faux: and again" });
      // A repeated message is not run again: its outcome is the first one's.
      expect(await (await send("hello from the e2e", "m1")).json()).toMatchObject({ requestId: "m1", text: "faux: hello from the e2e" });
    } finally {
      dev.kill("SIGTERM");
      await dev.exited;
      writeFileSync(configPath, original);
      writeFileSync(agentPath, agentBefore);
    }
    const logs = await new Response(dev.stdout).text();
    expect(logs).toContain('"msg":"pikit: started"');
    expect(logs).toContain('"msg":"pikit: stopped"');
    // Operational logs carry no message text (SPEC §5).
    expect(logs).not.toContain("hello from the e2e");
    expect((await pikit(["remove", "provider-faux"])).code).toBe(0);
    console.info(
      `e2e timings: new ${ms(timings.new)} (bun install and doctor included), configure ${ms(timings.configure)}, dev to /ready ${ms(timings.devReady)}, to the first answer ${ms(timings.answered)}; new → answering ${ms((timings.new ?? 0) + (timings.configure ?? 0) + (timings.answered ?? 0))}`,
    );
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "P3: add then remove leaves no trace, and remove refuses to leave a required capability unprovided",
  async () => {
    // `pikit new` made the repository; what the steps above changed is committed too.
    expect((await git("add", "-A")).code).toBe(0);
    expect((await git("commit", "-qm", "configured", "--allow-empty")).code).toBe(0);

    // server-bun brings an npm dependency only it uses (hono); channel-http brings a variable. server-bun
    // goes with channel-http out first: remove refuses to leave its route with no server.
    for (const names of [["channel-http"], ["channel-http", "server-bun"]]) {
      for (const name of names) {
        expect((await pikit(["remove", name])).code).toBe(0);
        await git("add", "-A");
        await git("commit", "-qm", `without ${name}`);
      }
      const name = names.at(-1) as string;

      const added = await pikit(["add", name, "--yes"]);
      expect(added.code).toBe(0);
      expect(added.out).toContain("`pikit doctor` is green");
      expect((await git("status", "--porcelain")).out).not.toBe("");

      const removed = await pikit(["remove", name]);
      expect(removed.code).toBe(0);
      expect((await git("status", "--porcelain")).out).toBe("");
      expect((await pikit(["doctor"])).code).toBe(0);
      await git("reset", "-q", "--hard", `HEAD~${names.length}`);
      await sh([process.execPath, "install"]);
    }

    const refused = await pikit(["remove", "storage-sqlite"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("runtime-pi requires storage.sql");
    expect((await git("status", "--porcelain")).out).toBe("");

    // A file the user changed is never deleted without --force.
    const edited = join(project, "src/pikit/log-events/fields.ts");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}// mine\n`);
    const kept = await pikit(["remove", "log-events"]);
    expect(kept.code).toBe(1);
    expect(kept.err).toContain("src/pikit/log-events/fields.ts");
    expect((await pikit(["doctor"])).out).toContain("modified: src/pikit/log-events/fields.ts");
    await git("checkout", "--", ".");
    expect((await git("status", "--porcelain")).out).toBe("");

    // A component that brings providers (`offers.ts`): they are installed for it, and leave with it.
    const brought = await pikit(["add", "channel-telegram", "--yes"]);
    expect(brought.code).toBe(0);
    const components = JSON.parse(readFileSync(join(project, "pikit.json"), "utf8")).components;
    expect(components["outbound-durable"].installedFor).toEqual(["channel-telegram"]);
    // The outbox's retries are wakeups: their server provider comes for it.
    expect(components["wakeups-timers"].installedFor).toEqual(["outbound-durable"]);
    // The preset's storage serves the outbox too: nothing brings another.
    expect(components["storage-sqlite"].installedFor).toBeUndefined();
    const removedWith = await pikit(["remove", "channel-telegram"]);
    expect(removedWith.code).toBe(0);
    expect(removedWith.out).toContain("outbound-durable was installed for channel-telegram, and nothing uses it now");
    // The runtime only uses wakeups if present: that does not keep the timers brought for the outbox.
    expect(removedWith.out).toContain("wakeups-timers was installed for outbound-durable, and nothing uses it now");
    expect((await git("status", "--porcelain")).out).toBe("");
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "pikit new with two channels, every feature the preset offers and the dashboard: doctor is green once configured",
  async () => {
    const features = ["router-rules", "agents-live", "tool-mcp", "tool-fetch", "tool-websearch-brave", "health-registry", "admin-proposals"];
    const args = ["new", "many", "--preset", "telegram", "--with", "channel-telegram", "--with", "channel-http", ...features.flatMap((f) => ["--with", f]), "--ui"];
    const created = await pikit(args, { cwd: parent });
    expect(created.err).not.toContain("✗");
    expect(created.code).toBe(0);
    const many = join(parent, "many");
    const components = Object.keys(JSON.parse(readFileSync(join(many, "pikit.json"), "utf8")).components);
    for (const name of ["channel-telegram", "channel-http", "server-bun", "admin-api", ...features]) expect(components).toContain(name);
    // A group: agents from the dashboard brings its routing rules and settings, and its two Settings sections.
    expect(components).toContain("settings-store");
    for (const section of ["agents-live", "router-rules"]) expect(existsSync(join(many, "src/dashboard/src/settings", section, "index.tsx"))).toBe(true);
    // Telegram's durable delivery comes with it, as with `pikit add`.
    expect(components).toContain("outbound-durable");
    // Self-improvement, a group: its provider on a server, its section; the steward gets a shell, the
    // deployer's service is in compose.yaml, and the project is a git repository.
    expect(components).toContain("proposals-local");
    expect(existsSync(join(many, "src/dashboard/src/settings/admin-proposals/index.tsx"))).toBe(true);
    expect(readFileSync(join(many, "src/agents/assistant/agent.ts"), "utf8")).toContain('"bash"');
    expect(readFileSync(join(many, "compose.yaml"), "utf8")).toContain("  deployer:\n");
    expect(existsSync(join(many, ".git"))).toBe(true);

    writeFileSync(
      join(many, ".env"),
      [`PIKIT_HTTP_TOKEN=${"a".repeat(64)}`, `PIKIT_ADMIN_TOKEN=${"b".repeat(64)}`, "TELEGRAM_BOT_TOKEN=123:not-a-token", "TELEGRAM_ALLOWED_USERS=1", `ANTHROPIC_API_KEY=${DUMMY_KEY}`, ""].join("\n"),
    );
    const doctor = await pikit(["doctor"], { cwd: many });
    expect(doctor.err).not.toContain("✗");
    expect(doctor.out).toContain("pikit doctor: green");
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
      expect((await sh(["docker", "compose", "run", "--rm", "-T", "app", "bun", "--eval", store])).code).toBe(0);
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
      await sh(["docker", "compose", "down", "--volumes", "--rmi", "local"]);
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
