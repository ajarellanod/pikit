/**
 * `up`, `dev`, `status`, `logs`, `down` and `doctor` as the CLI calls them, through the real runner,
 * against a fake `celld` and `ssh` on the PATH, a fake bucket and a fake `/health`
 * (`fake-fleet.test-support.ts`): what celld is given, what stays on this machine, the wait for the
 * new deployment, the rollback of one that fails, and what each command says. No celld, no fleet.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_CONFIG, parseJsonc } from "./celld-config.mjs";
import { compareVersions, DEV_VARS, dev, doctor, down, logs, machineEnv, sshNodes, status, up, type UpOptions, url } from "./commands.ts";
import { type FakeFleet, fakeFleet, KEY } from "./fake-fleet.test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((done) => done()));

function fleet(): FakeFleet {
  const made = fakeFleet();
  cleanup.push(() => made.stop());
  return made;
}

const SHIPPED = readFileSync(join(import.meta.dir, "..", "..", "..", "wrangler.jsonc"), "utf8");

/** A project: package.json named my-bot, this component's wrangler.jsonc (or `wrangler`), `.env`, a project esbuild. */
function project(options: { env?: string; wrangler?: string; files?: Record<string, string>; esbuild?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-celld-project-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-bot" }));
  writeFileSync(join(dir, "wrangler.jsonc"), options.wrangler ?? SHIPPED);
  writeFileSync(join(dir, ".env"), options.env ?? "TELEGRAM_BOT_TOKEN=123:abc\nBRAVE_API_KEY=\n");
  if (options.esbuild !== false) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "esbuild"), "#!/bin/sh\n");
  }
  for (const [name, text] of Object.entries(options.files ?? {})) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function upOptions(f: FakeFleet, cwd: string, extra: Partial<UpOptions> = {}): UpOptions & { said: string[] } {
  const said: string[] = [];
  return { cwd, env: f.env(), waitMs: 3_000, intervalMs: 10, say: (line) => void said.push(line), said, ...extra };
}

/** What `promise` rejected with; it fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("it resolved");
}

const deploys = (f: FakeFleet) => f.calls().filter((call) => call.command === "celld" && call.args[0] === "deploy");

async function sh(cwd: string, ...command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
}

test("up deploys the config derived from wrangler.jsonc, .env's secrets as its vars and the bucket's settings kept here, waits for /health from it, and records it", async () => {
  const f = fleet();
  f.seed("my-bot", "old");
  const dir = project({ env: "TELEGRAM_BOT_TOKEN=123:abc\nBRAVE_API_KEY=\nAWS_SECRET_ACCESS_KEY=from-dotenv\n" });
  const options = upOptions(f, dir, { deployment: "d-new" });
  const deployed = await up(options);

  expect(deployed).toMatchObject({ version: "d-new", worker: "my-bot", url: f.url });
  expect(deployed.celldVersion).toMatch(/^[0-9a-f]{16}$/);
  const [call] = deploys(f);
  expect(call?.args).toEqual(["deploy", "--config", GENERATED_CONFIG, "--json"]);
  // Readable by its owner only while it exists, and gone after.
  expect(call?.mode).toBe(0o600);
  expect(existsSync(join(dir, GENERATED_CONFIG))).toBe(false);
  const config = parseJsonc(call?.config ?? "") as Record<string, unknown>;
  expect(config.name).toBe("my-bot");
  expect(config.vars).toEqual({ TELEGRAM_BOT_TOKEN: "123:abc", PIKIT_DEPLOYMENT: "d-new" });
  expect("build" in config).toBe(false);
  // celld's process gets the bucket's settings (the exported key wins over .env's) and the project's esbuild, never the app's secrets.
  expect(call?.env).toEqual({ CELLD_ESBUILD: join(dir, "node_modules", ".bin", "esbuild"), CELLD_BUCKET: "s3://fleet", AWS_ACCESS_KEY_ID: KEY.id });
  expect(f.serving()).toBe("d-new");
  expect(JSON.parse(readFileSync(join(dir, ".pikit", "deployment-celld.json"), "utf8"))).toMatchObject({ version: "d-new", worker: "my-bot", url: f.url });
  expect(await url({ cwd: dir, env: { PIKIT_CELLD_URL: "https://changed.example" } })).toBe(f.url);
  expect(options.said).toEqual([`celld deployed my-bot (celld version ${deployed.celldVersion}) as PIKIT_DEPLOYMENT=d-new; waiting for ${f.url}/health to answer from it`]);
});

test("url returns the configured fleet URL before an up, and undefined without one", async () => {
  const dir = project({ env: "PIKIT_CELLD_URL=https://fleet.example\n" });
  expect(await url({ cwd: dir, env: {} })).toBe("https://fleet.example");
  expect(await url({ cwd: dir, env: { PIKIT_CELLD_URL: "https://exported.example" } })).toBe("https://exported.example");
  expect(await url({ cwd: project(), env: {} })).toBeUndefined();
});

test("the bucket's settings in .env reach celld when they are not exported; the app's never do", () => {
  const dir = project({ env: "CELLD_BUCKET=s3://from-dotenv\nAWS_REGION=auto\nTELEGRAM_BOT_TOKEN=t\nPIKIT_CELLD_URL=\n" });
  expect(machineEnv(dir, { PATH: "/bin" })).toEqual({ CELLD_BUCKET: "s3://from-dotenv", AWS_REGION: "auto", PATH: "/bin" });
  expect(machineEnv(dir, { CELLD_BUCKET: "s3://exported", EMPTY: "" })).toEqual({ CELLD_BUCKET: "s3://exported", AWS_REGION: "auto" });
});

test("up refuses without the fleet's bucket or URL, before anything runs", async () => {
  const f = fleet();
  const dir = project();
  const env = f.env();
  delete (env as Record<string, string | undefined>).CELLD_BUCKET;
  delete (env as Record<string, string | undefined>).PIKIT_CELLD_URL;
  await expect(up({ ...upOptions(f, dir), env })).rejects.toThrow(/needs CELLD_BUCKET .* and PIKIT_CELLD_URL/);
  expect(f.calls()).toEqual([]);
});

test("a deploy whose App does not start is rolled back: the previous pointers are written back over its own, and up says so", async () => {
  const f = fleet();
  const previous = f.seed("my-bot", "old");
  f.unhealthy = true;
  const dir = project();
  const failure = await rejected(up(upOptions(f, dir, { deployment: "d-bad" })));
  // `status` never says this machine deployed what does not serve.
  expect(existsSync(join(dir, ".pikit", "deployment-celld.json"))).toBe(false);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain(`the deployment d-bad answers ${f.url}/health that its App does not start (the object's App did not start)`);
  expect(failure.message).toContain(`failed /health: rolled back to celld version ${previous}`);
  expect(f.serving()).toBe("old");
  const writes = f.requests.filter((r) => r.method === "PUT");
  expect(writes.map((r) => r.key)).toEqual(["deploy/my-bot/current.json", "deploy/current.json"]);
  expect(writes.every((r) => r.ifMatch !== null)).toBe(true);
});

test("a deploy the fleet never answers from is rolled back too", async () => {
  const f = fleet();
  f.seed("my-bot", "old");
  f.frozen = "old";
  const failure = await rejected(up(upOptions(f, project(), { deployment: "d-late", waitMs: 200 })));
  expect(failure.message).toContain(`the deployment d-late did not answer ${f.url}/health within 0 s (last: HTTP 200 from version old)`);
  expect(failure.message).toContain("rolled back to celld version");
  f.frozen = undefined;
  expect(f.serving()).toBe("old");
});

test("a deploy that changed the Durable Object classes is not rolled back: it fails saying why, and stays", async () => {
  const f = fleet();
  f.seed("my-bot", "old", ["Conversation", "Retired"]);
  f.unhealthy = true;
  const failure = await rejected(up(upOptions(f, project(), { deployment: "d-mig" })));
  expect(failure.message).toContain("was NOT rolled back: this deploy changed the Durable Object classes (Conversation|sqlite:Conversation; the previous deployment");
  expect(f.serving()).toBe("d-mig");
});

test("a first deploy has nothing to go back to; rollback: false leaves a failing deploy; a bucket pikit cannot write is said", async () => {
  const first = fleet();
  first.unhealthy = true;
  const none = await rejected(up(upOptions(first, project(), { deployment: "d1" })));
  expect(none.message).toContain("was not rolled back: there is no earlier deployment in the bucket");

  const kept = fleet();
  kept.seed("my-bot", "old");
  kept.unhealthy = true;
  const left = await rejected(up(upOptions(kept, project(), { deployment: "d2", rollback: false })));
  expect(left.message).toEndWith("; it is still deployed");
  expect(kept.serving()).toBe("d2");

  const gcs = fleet();
  gcs.unhealthy = true;
  const other = await rejected(up({ ...upOptions(gcs, project(), { deployment: "d3" }), env: gcs.env({ CELLD_BUCKET: "gs://fleet" }) }));
  // The fake celld deployed to the fake bucket anyway; pikit could not have rolled a gs:// bucket back.
  expect(other.message).toContain("was not rolled back: pikit restores a deployment only on an S3-compatible bucket, not gs://");
});

test("a failed celld deploy fails up with nothing probed and the derived config gone; a missing celld is named", async () => {
  const f = fleet();
  const dir = project();
  await expect(up({ ...upOptions(f, dir), env: f.env({ FAKE_DEPLOY_CODE: "3" }) })).rejects.toThrow("`celld deploy` exited with code 3");
  expect(existsSync(join(dir, GENERATED_CONFIG))).toBe(false);
  expect(f.serving()).toBeUndefined();
  await expect(up({ ...upOptions(f, dir), env: f.env({ PIKIT_CELLD_BIN: join(f.dir, "no-celld") }) })).rejects.toThrow(/celld is not installed here/);
});

test("up runs wrangler.jsonc's UI build first; a build that fails deploys nothing", async () => {
  const f = fleet();
  const built = project({ wrangler: `{ "main": "w.ts", "build": { "command": "echo built > build.log" }, "durable_objects": { "bindings": [] }, "migrations": [] }` });
  await up(upOptions(f, built));
  expect(readFileSync(join(built, "build.log"), "utf8")).toBe("built\n");

  const broken = project({ wrangler: `{ "main": "w.ts", "build": { "command": "exit 4" }, "durable_objects": { "bindings": [] }, "migrations": [] }` });
  await expect(up(upOptions(f, broken))).rejects.toThrow("the UI build (wrangler.jsonc's build.command) exited with code 4, so nothing was deployed");
  expect(deploys(f)).toHaveLength(1);
});

test("in a git repository, up refuses until the derived config is ignored: it holds the secrets while celld deploys", async () => {
  const f = fleet();
  const dir = project();
  await sh(dir, "git", "init", "-q");
  await expect(up(upOptions(f, dir))).rejects.toThrow(`${GENERATED_CONFIG} is not ignored by git`);
  expect(f.calls()).toEqual([]);
  writeFileSync(join(dir, ".gitignore"), `${GENERATED_CONFIG}\n.celld/\n.dev.vars*\n`);
  await up(upOptions(f, dir));
  expect(deploys(f)).toHaveLength(1);
});

const HOOK = `import { appendFileSync } from "node:fs";
const log = import.meta.dir + "/../../../hooks.log";
export async function beforeDeploy(io) {
  appendFileSync(log, "before\\n");
  io.write("seed.ts", "export const seed = 1;\\n");
  return io.get("HOOK_FAILS") ? ["the MCP server is down"] : [];
}
export async function afterDeploy(io) {
  appendFileSync(log, "after " + io.url + " " + io.get("TELEGRAM_BOT_TOKEN") + "\\n");
  io.say("webhook set");
  return [];
}
`;

test("up runs each component's beforeDeploy before the build, and afterDeploy once the deployment answers, with its URL and the secrets", async () => {
  const f = fleet();
  const hooks = { components: { "channel-x": { hooks: { beforeDeploy: "src/pikit/channel-x/deploy.ts", afterDeploy: "src/pikit/channel-x/deploy.ts" } } } };
  const dir = project({ files: { "pikit.json": JSON.stringify(hooks), "src/pikit/channel-x/deploy.ts": HOOK } });
  const options = upOptions(f, dir);
  await up(options);
  expect(readFileSync(join(dir, "hooks.log"), "utf8")).toBe(`before\nafter ${f.url} 123:abc\n`);
  expect(readFileSync(join(dir, "src/pikit/channel-x/seed.ts"), "utf8")).toBe("export const seed = 1;\n");
  expect(options.said.at(-1)).toBe("webhook set");

  const stopped = fleet();
  await expect(up({ ...upOptions(stopped, dir), env: stopped.env({ HOOK_FAILS: "1" }) })).rejects.toThrow("channel-x: the MCP server is down");
  expect(deploys(stopped)).toEqual([]);
});

test("dev runs celld dev on the derived config, with no secret in it: .env's (not the machine's) go in .dev.vars, 0600; both are gone after", async () => {
  const f = fleet();
  const dir = project({ env: "TELEGRAM_BOT_TOKEN=123:abc\nCELLD_BUCKET=s3://fleet\nAWS_SECRET_ACCESS_KEY=s\n" });
  writeFileSync(join(dir, DEV_VARS), "STALE=1\n");
  const code = await dev({ cwd: dir, env: f.env({ FAKE_DEV_CODE: "3" }) });
  expect(code).toBe(3);
  const [call] = f.calls().filter((c) => c.args[0] === "dev");
  expect(call?.args).toEqual(["dev", GENERATED_CONFIG, "--watch-ignore", ".pikit/**", "--watch-ignore", "src/*/dist/**"]);
  expect(call?.env.CELLD_ESBUILD).toBe(join(dir, "node_modules", ".bin", "esbuild"));
  expect((parseJsonc(call?.config ?? "") as { vars: unknown }).vars).toEqual({ PIKIT_DEPLOYMENT: "dev" });
  expect(call?.devVars).toBe('# Written by `pikit dev` from .env (without the deploy settings) for celld dev; deleted when it exits.\nTELEGRAM_BOT_TOKEN="123:abc"\n');
  expect(existsSync(join(dir, GENERATED_CONFIG))).toBe(false);
  expect(existsSync(join(dir, DEV_VARS))).toBe(false);
  await expect(dev({ cwd: dir, env: f.env({ PIKIT_CELLD_BIN: join(f.dir, "none") }) })).rejects.toThrow(/celld is not installed here/);
});

test("dev stops celld when its signal aborts (a SIGTERM to pikit dev), and deletes the derived config and .dev.vars", async () => {
  const f = fleet();
  const dir = project({ env: "TELEGRAM_BOT_TOKEN=123:abc\n" });
  const stop = new AbortController();
  const running = dev({ cwd: dir, env: f.env({ FAKE_DEV_UNTIL_SIGTERM: "1", FAKE_DEV_CODE: "5" }), signal: stop.signal });
  for (let i = 0; i < 200 && !f.calls().some((c) => c.args[0] === "dev"); i++) await Bun.sleep(25);
  expect(existsSync(join(dir, DEV_VARS))).toBe(true);
  stop.abort();
  expect(await running).toBe(5);
  expect(existsSync(join(dir, GENERATED_CONFIG))).toBe(false);
  expect(existsSync(join(dir, DEV_VARS))).toBe(false);
});

test("dev writes .dev.vars readable by its owner only", async () => {
  const f = fleet();
  const dir = project();
  const modes: number[] = [];
  // A runner that looks at the files while celld would run.
  const commands: string[] = [];
  await dev({
    cwd: dir,
    env: f.env(),
    run: async (command) => {
      commands.push(command.slice(0, 2).join(" "));
      if (command[1] === "dev") modes.push(statSync(join(dir, DEV_VARS)).mode & 0o777, statSync(join(dir, GENERATED_CONFIG)).mode & 0o777);
      return { code: 0, stdout: "" };
    },
  });
  // The UI build first (wrangler.jsonc's build.command), then celld.
  expect(commands).toEqual(["sh -c", "celld dev"]);
  expect(modes).toEqual([0o600, 0o600]);
});

const DIAGNOSE = '{"verdict":"ok","check":"listen 127.0.0.1:8080","detail":"bind check; diagnose does not serve"}\n{"verdict":"ok","check":"bucket s3://fleet","detail":""}\n{"verdict":"skip","check":"bucket write probe","detail":"--read-only"}\n{"verdict":"ok","check":"fleet","detail":"2 node lease(s) enumerated"}\n';

test("status: what this machine deployed, the fleet as `celld diagnose --read-only` sees it, and /health", async () => {
  const f = fleet();
  const dir = project();
  const deployed = await up(upOptions(f, dir, { deployment: "d-now" }));
  const seen = await status({ cwd: dir, env: f.env({ FAKE_DIAGNOSE: DIAGNOSE }) });
  expect(seen.lines).toEqual([
    expect.stringMatching(new RegExp(`^deployed from here: d-now \\(celld version ${deployed.celldVersion}\\) of my-bot, \\d{4}-`)),
    "fleet: ok bucket s3://fleet",
    "fleet: skip bucket write probe: --read-only",
    "fleet: ok fleet: 2 node lease(s) enumerated",
    `GET /health at ${f.url}: 200 from version d-now`,
  ]);
  expect(f.calls().at(-1)?.args).toEqual(["diagnose", "--read-only", "--json"]);
  expect(seen).toMatchObject({ health: 200, version: "d-now", url: f.url });

  const bare = await status({ cwd: project(), env: { PATH: f.env().PATH as string } });
  expect(bare.lines).toEqual(["no deploy from this machine yet", "fleet: CELLD_BUCKET is not set", "GET /health: no URL (PIKIT_CELLD_URL)"]);
  const failing = await status({ cwd: project(), env: f.env({ FAKE_DIAGNOSE_CODE: "1", PIKIT_CELLD_URL: "http://127.0.0.1:9" }) });
  expect(failing.lines.slice(1)).toEqual(["fleet: fail celld diagnose: exited with code 1", "GET /health at http://127.0.0.1:9: unreachable"]);
  // celld's error (what it prints to stderr, kept off the terminal) says why, by its innermost cause.
  const error = "Error: build s3 client\n\nCaused by:\n    0: Generic S3 error: Missing AccessKeyId\n    1: Missing AccessKeyId\n";
  const unsigned = await status({ cwd: project(), env: f.env({ FAKE_DIAGNOSE_CODE: "1", FAKE_DIAGNOSE_ERR: error, PIKIT_CELLD_URL: "http://127.0.0.1:9" }) });
  expect(unsigned.lines[1]).toBe("fleet: fail celld diagnose: Missing AccessKeyId");
});

test("logs: journalctl of the celld unit on every node over SSH, each line led by its node; without PIKIT_CELLD_SSH, where to look", async () => {
  const f = fleet();
  const lines: string[] = [];
  await logs({ cwd: project(), env: f.env({ PIKIT_CELLD_SSH: "deploy@a, deploy@b" }), follow: true, say: (line) => void lines.push(line) });
  expect(lines.sort()).toEqual(["deploy@a | serving deploy@a", "deploy@a | started deploy@a", "deploy@b | serving deploy@b", "deploy@b | started deploy@b"]);
  expect(f.calls().map((c) => c.args)).toContainEqual(["-o", "BatchMode=yes", "deploy@a", "journalctl", "--unit=celld.service", "--output=cat", "--no-pager", "--lines=10", "--follow"]);
  await logs({ cwd: project(), env: f.env({ PIKIT_CELLD_SSH: "deploy@a", PIKIT_CELLD_UNIT: "pikit.service" }), tail: 5, say: () => {} });
  expect(f.calls().at(-1)?.args).toEqual(["-o", "BatchMode=yes", "deploy@a", "journalctl", "--unit=pikit.service", "--output=cat", "--no-pager", "--lines=5"]);
  await expect(logs({ cwd: project(), env: f.env() })).rejects.toThrow(/set PIKIT_CELLD_SSH .* `journalctl -u celld -f`/);
  await expect(logs({ cwd: project(), env: f.env({ PIKIT_CELLD_SSH: "deploy@a", FAKE_SSH_CODE: "255" }), say: () => {} })).rejects.toThrow("ssh to deploy@a failed (exit code 255)");
});

test("down stops celld on each node over SSH, one after the other, and deletes nothing; without SSH it refuses, saying so", async () => {
  const f = fleet();
  const said: string[] = [];
  await down({ cwd: project(), env: f.env({ PIKIT_CELLD_SSH: "deploy@a,deploy@b" }), say: (line) => void said.push(line) });
  expect(f.calls().map((c) => c.args)).toEqual([
    ["-o", "BatchMode=yes", "deploy@a", "sudo", "systemctl", "stop", "celld.service"],
    ["-o", "BatchMode=yes", "deploy@b", "sudo", "systemctl", "stop", "celld.service"],
  ]);
  expect(said.at(-1)).toContain("stopped 2 node(s). Nothing was deleted: the deployment and every conversation stay in s3://fleet");
  await expect(down({ cwd: project(), env: f.env() })).rejects.toThrow(/It deletes nothing either way/);
  await expect(down({ cwd: project(), env: f.env({ PIKIT_CELLD_SSH: "deploy@a,deploy@b", FAKE_SSH_CODE: "1" }), say: () => {} })).rejects.toThrow("on deploy@a failed (exit code 1)");
  expect(sshNodes({ PIKIT_CELLD_SSH: " a ,b  c" })).toEqual(["a", "b", "c"]);
});

test("doctor: celld present and recent, esbuild, a config celld takes; the bucket and its nodes, and whether a rollback can run, as notes", async () => {
  const f = fleet();
  const io = { config: {}, get: () => undefined };
  const dir = project();
  expect(await doctor(io, { cwd: dir, env: f.env({ FAKE_DIAGNOSE: DIAGNOSE }) })).toEqual({ problems: [], notes: ["fleet: 2 node lease(s) enumerated"] });
  expect(f.calls().map((c) => c.args)).toEqual([["--version"], ["diagnose", "--read-only", "--json"]]);

  const empty = await doctor(io, { cwd: dir, env: f.env({ FAKE_DIAGNOSE: '{"verdict":"ok","check":"fleet","detail":"0 node lease(s) enumerated"}\n', CELLD_BUCKET: "gs://fleet" }) });
  expect(empty.notes).toEqual([
    'no node serves gs://fleet yet: `pikit up` deploys, but nothing answers until one runs (README, "Running a fleet")',
    "a deploy that fails /health cannot be rolled back from here: pikit restores a deployment only on an S3-compatible bucket, not gs://",
  ]);
  const down = await doctor(io, { cwd: dir, env: f.env({ FAKE_DIAGNOSE: '{"verdict":"fail","check":"bucket s3://fleet","detail":"403 Forbidden"}\n', FAKE_DIAGNOSE_CODE: "1" }) });
  expect(down.notes).toEqual(["the bucket s3://fleet does not answer `celld diagnose --read-only`: bucket s3://fleet: 403 Forbidden"]);

  const settings = f.env();
  for (const name of ["CELLD_BUCKET", "PIKIT_CELLD_URL"]) delete (settings as Record<string, string | undefined>)[name];
  expect((await doctor(io, { cwd: dir, env: settings })).notes).toEqual(['`pikit up` needs CELLD_BUCKET and PIKIT_CELLD_URL (README, "Running a fleet"); `pikit dev` does not']);

  const missing = await doctor(io, { cwd: project({ esbuild: false, env: "CONVERSATION=x\n" }), env: { ...settings, PIKIT_CELLD_BIN: join(f.dir, "none"), PATH: `${f.bin}:/usr/bin:/bin` } });
  expect(missing.problems).toEqual([
    expect.stringContaining("celld is not installed (or not on the PATH)"),
    expect.stringContaining("esbuild is not installed"),
    "CONVERSATION is a secret and the name of another binding of wrangler.jsonc: rename one",
  ]);
  const old = await doctor(io, { cwd: dir, env: { ...settings, FAKE_CELLD_VERSION: "0.5.1" } });
  expect(old.problems).toEqual(["celld 0.5.1 is older than 0.6.1, the oldest deployment-celld runs on: install a newer one (CELLD_VERSION=v0.6.1 or later)"]);
  expect([compareVersions("0.10.0", "0.6.1") > 0, compareVersions("0.6.1", "0.6.1"), compareVersions("0.6.0", "0.6.1") < 0]).toEqual([true, 0, true]);
});
