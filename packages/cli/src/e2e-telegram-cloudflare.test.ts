/**
 * A Telegram bot on Cloudflare, end to end on this machine (SPEC §4.1): `pikit new --target cloudflare
 * --preset telegram-cloudflare`, `pikit configure` (without a terminal, then walked through in one),
 * then the Worker and its objects in workerd (`wrangler dev`, as `pikit dev` runs it, on a free port).
 * `pikit up`'s after-deploy step registers the webhook against it, and a person's message posted to
 * `/telegram` is answered in the chat:
 *
 *   Worker (secret, allowed users) → actor.mailbox → the chat's Durable Object → actor.inbox →
 *   runtime-pi, driven in the object's alarm (wakeups) → the model → agent.submissions → delivery
 *   (outbound-durable) → Telegram's sendMessage.
 *
 * Nothing leaves this machine. Telegram is channel-telegram-webhook's fake Bot API and the model is
 * provider-openrouter's fake OpenRouter, both set as the components' `apiBase`; every key is a dummy.
 * No deploy: `up` runs with its `wrangler deploy` replaced by the `wrangler dev` already running.
 *
 * Slow (`bun install`, the project's tests, workerd), so it runs only with `PIKIT_E2E=1`. It needs Node
 * on the PATH (wrangler runs on it).
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e-telegram-cloudflare.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startFakeTelegram } from "../../../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/fake-telegram.test-support.ts";
import { startFakeOpenRouter } from "../../../registry/components/provider-openrouter/files/src/pikit/provider-openrouter/fake-openrouter.test-support.ts";
import { setConfigEntry } from "./project/config-file.ts";

const E2E = process.env.PIKIT_E2E === "1";
const MAIN = join(import.meta.dir, "main.ts");
const TIMEOUT = 600_000;
const NAME = "tg-bot";
const OWNER = { id: 1001, first_name: "Ada", username: "ada" };
const STRANGER = { id: 2002, first_name: "Eve" };
const MODEL_KEY = "sk-or-e2e-dummy-not-a-key";
const BRAVE_KEY = "brave-e2e-dummy-not-a-key";
/** This machine's environment without the variables the project reads: one exported here never leaks into the test. */
const OWN = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_WEBHOOK_SECRET", "OPENROUTER_API_KEY", "BRAVE_API_KEY"];
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !OWN.includes(name))) as Record<string, string>;

const parent = mkdtempSync(join(tmpdir(), "pikit-e2e-telegram-cloudflare-"));
const project = join(parent, NAME);
const telegram = startFakeTelegram();
const openrouter = startFakeOpenRouter();
afterAll(async () => {
  await telegram.stop();
  await openrouter.stop();
  rmSync(parent, { recursive: true, force: true });
});

async function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn(command, { cwd: options.cwd ?? project, env: { ...CLEAN_ENV, ...options.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}
const pikit = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => run([process.execPath, MAIN, ...args], options);

function env(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(project, ".env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

test.skipIf(!E2E)(
  "pikit new --target cloudflare --preset telegram-cloudflare: a bot that composes, bundles, typechecks and passes its tests; doctor asks for Telegram",
  async () => {
    const created = await pikit(["new", NAME, "--target", "cloudflare", "--preset", "telegram-cloudflare"], { cwd: parent });
    expect(created.err).not.toContain("✗");
    expect(created.code).toBe(0);

    const doctor = await pikit(["doctor"]);
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_WEBHOOK_SECRET"]) expect(doctor.err).toContain(`${name} is not set`);
    // The Brave key is optional: the bot starts without it.
    expect(doctor.err).not.toContain("BRAVE_API_KEY");
    expect(doctor.out).toContain("POST /telegram → channel-telegram-webhook-worker");

    const typecheck = await run([process.execPath, "run", "typecheck"]);
    expect(typecheck.err + typecheck.out).not.toContain("error TS");
    expect(typecheck.code).toBe(0);
    const tests = await run([process.execPath, "test"]);
    expect(tests.err).toContain(" 0 fail");
    expect(tests.code).toBe(0);

    // The project's own Worker bundles, QuickJS's WebAssembly included, within the 10 MB budget (SPEC §4).
    const bundle = await run([join(project, "node_modules", ".bin", "wrangler"), "deploy", "--dry-run", "--outdir", join(parent, "bundle"), "--name", NAME], {
      env: { WRANGLER_SEND_METRICS: "false" },
    });
    expect(bundle.code).toBe(0);
    const gzip = /gzip: ([\d.]+) KiB/.exec(bundle.out + bundle.err)?.[1];
    expect(Number(gzip)).toBeGreaterThan(0);
    expect(Number(gzip)).toBeLessThan(10 * 1024);
    console.info(`e2e telegram-cloudflare: the Worker's bundle is ${gzip} KiB gzip`);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "configure without a terminal: it says what is missing, then checks the bot, generates the webhook's secret and saves every key",
  async () => {
    // The only thing a test adds: where the fake Telegram and the fake OpenRouter are, in each App.
    const configPath = join(project, "pikit.config.ts");
    let config = readFileSync(configPath, "utf8");
    config = setConfigEntry(config, "channel-telegram-webhook", `{ apiBase: "${telegram.url}" }`);
    config = setConfigEntry(config, "provider-openrouter", `{ apiBase: "${openrouter.url}" }`);
    config = setConfigEntry(config, "channel-telegram-webhook-worker", `{ apiBase: "${telegram.url}" }`, "workerConfig");
    writeFileSync(configPath, config);

    const missing = await pikit(["configure", "--yes"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("create a bot with @BotFather");
    expect(missing.err).toContain('the model provider "openrouter" has no credentials');
    expect(missing.err).not.toContain("BRAVE_API_KEY");

    const configured = await pikit(["configure", "--yes"], {
      env: { TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: String(OWNER.id), OPENROUTER_API_KEY: MODEL_KEY, BRAVE_API_KEY: BRAVE_KEY },
    });
    expect(configured.err).not.toContain("✗");
    expect(configured.code).toBe(0);
    expect(configured.out).toContain("bot @pikit_test_bot (https://t.me/pikit_test_bot)");
    expect(configured.out).toContain("TELEGRAM_WEBHOOK_SECRET generated");
    const saved = env();
    expect(saved).toMatchObject({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: String(OWNER.id), OPENROUTER_API_KEY: MODEL_KEY, BRAVE_API_KEY: BRAVE_KEY });
    expect(saved.TELEGRAM_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of [telegram.token, MODEL_KEY, BRAVE_KEY, saved.TELEGRAM_WEBHOOK_SECRET as string]) expect(configured.out + configured.err).not.toContain(secret);
    expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600);
    expect((await pikit(["doctor"])).out).toContain("pikit doctor: green");
  },
  TIMEOUT,
);

/** `pikit configure` in a pseudo-terminal: what it printed, without colours, and a way to answer. */
function terminal() {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, "configure"], {
    cwd: project,
    env: CLEAN_ENV,
    terminal: { cols: 160, rows: 50, data: (_terminal, data) => void (output += decoder.decode(data)) },
  });
  const text = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  return {
    text,
    async waitFor(expected: string, from = 0, timeoutMs = 60_000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const at = text().indexOf(expected, from);
        if (at >= 0) return at + expected.length;
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`never printed ${JSON.stringify(expected)}; printed:\n${text()}`);
        await Bun.sleep(20);
      }
    },
    async type(keys: string) {
      await Bun.sleep(100);
      proc.terminal?.write(keys);
    },
    exited: proc.exited,
  };
}

test.skipIf(!E2E)(
  "configure in a terminal walks through it: the token, the owner by writing to the bot (getUpdates), the webhook's secret, the Brave key, the OpenRouter key",
  async () => {
    rmSync(join(project, ".env"));
    const t = terminal();
    let at = await t.waitFor("open https://t.me/BotFather");
    at = await t.waitFor("TELEGRAM_BOT_TOKEN", at);
    await t.type(`${telegram.token}\r`);
    at = await t.waitFor("TELEGRAM_WEBHOOK_SECRET generated", at);
    at = await t.waitFor("send it any message now", at);
    telegram.say(OWNER, "hi");
    at = await t.waitFor("Message from Ada (@ada), id 1001. Allow them to talk to your agent?", at);
    await t.type("\r");
    at = await t.waitFor("TELEGRAM_ALLOWED_USERS set", at);
    at = await t.waitFor("◆  BRAVE_API_KEY (Enter skips)", at);
    await t.type(`${BRAVE_KEY}\r`);
    at = await t.waitFor('The model provider "openrouter" has no credentials', at);
    // A Cloudflare project stores no login (no model.credentials): the key is the first answer.
    await t.waitFor("Paste an API key", at);
    expect(t.text().slice(at)).not.toContain("Log in with your subscription");
    await t.type("\r");
    at = await t.waitFor("◆  OPENROUTER_API_KEY", at);
    await t.type(`${MODEL_KEY}\r`);
    expect(await t.exited).toBe(0);
    expect(t.text()).toContain("configured");

    const saved = env();
    expect(saved).toMatchObject({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: String(OWNER.id), OPENROUTER_API_KEY: MODEL_KEY, BRAVE_API_KEY: BRAVE_KEY });
    expect(saved.TELEGRAM_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of [telegram.token, MODEL_KEY, BRAVE_KEY, saved.TELEGRAM_WEBHOOK_SECRET as string]) expect(t.text()).not.toContain(secret);
    // The owner was told in the chat, and their setup message was confirmed: the agent never gets it.
    expect(telegram.sent).toContainEqual({ chatId: OWNER.id, text: "✓ You can talk to this bot once it is deployed (pikit up).", html: false });
    expect(telegram.pending()).toEqual([]);
  },
  TIMEOUT,
);

/** A port nothing listens on now. */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

test.skipIf(!E2E)(
  "in workerd: up's after-deploy hook sets the webhook, a stranger is told their id, and the owner's message is answered in the chat through the object's alarm",
  async () => {
    telegram.sent.length = 0;
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    // `pikit dev` runs `wrangler dev --name <name>`: the same, on a free port. It reads .env as the Worker's secrets.
    const dev = Bun.spawn(
      [join(project, "node_modules", ".bin", "wrangler"), "dev", "--name", NAME, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(freePort())],
      { cwd: project, env: { ...CLEAN_ENV, WRANGLER_SEND_METRICS: "false" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    let logs = "";
    const decoder = new TextDecoder();
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) logs += decoder.decode(chunk);
    };
    const collected = Promise.all([collect(dev.stdout), collect(dev.stderr)]);
    try {
      let health: { ok?: boolean; version?: string } | undefined;
      for (let i = 0; i < 90 && health?.ok !== true; i++) {
        health = await fetch(`${base}/health`).then(
          (response) => response.json() as Promise<{ ok?: boolean; version?: string }>,
          () => undefined,
        );
        if (health?.ok !== true) {
          if (dev.exitCode !== null) throw new Error(`wrangler dev exited (${dev.exitCode}):\n${logs}`);
          await Bun.sleep(1_000);
        }
      }
      // Read before any matcher: Bun's toMatchObject writes its asymmetric matchers into what it checks.
      const version = health?.version;
      expect(health?.ok).toBe(true);
      expect(typeof version).toBe("string");

      // `pikit up`, with its `wrangler deploy` replaced by the Worker already running here: it waits for
      // /health to answer that version, then runs the components' after-deploy hooks (C8).
      const commands = (await import(join(project, "src", "pikit", "deployment-cloudflare", "commands.ts"))) as typeof import("../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/commands.ts");
      const said: string[] = [];
      const deployed = await commands.up({
        cwd: project,
        url: base,
        intervalMs: 200,
        waitMs: 30_000,
        say: (line) => said.push(line),
        run: async (command, { env: runEnv }) => {
          // A wrangler logged in to an account: the login check passes, and nothing reaches Cloudflare.
          if (command[1] === "whoami") return { code: 0, stdout: JSON.stringify({ loggedIn: true }) };
          const output = runEnv?.WRANGLER_OUTPUT_FILE_PATH;
          if (command[1] !== "deploy" || output === undefined) throw new Error(`unexpected: ${command.join(" ")}`);
          writeFileSync(output, `${JSON.stringify({ type: "deploy", version_id: version, targets: [base] })}\n`);
          return { code: 0, stdout: "" };
        },
      });
      expect(deployed).toEqual({ version: version as string, url: base });
      expect(said).toEqual([`✓ Telegram telegram: webhook ${base}/telegram`]);
      expect([telegram.webhookUrl, telegram.webhookSecret, telegram.allowedUpdates]).toEqual([`${base}/telegram`, env().TELEGRAM_WEBHOOK_SECRET, ["message"]]);

      // Only Telegram reaches the agent: without the secret, 401.
      expect(await telegram.post(telegram.message(OWNER, "no secret"), { secret: null })).toBe(401);
      // A stranger is told their id by the Worker, and reaches no object.
      expect((await telegram.write(STRANGER, "hi")).status).toBe(200);
      // The owner's message: 200 once the chat's object holds it, then the answer arrives in the chat.
      expect((await telegram.write(OWNER, "hello")).status).toBe(200);
      const sent = await telegram.sentCount(2, 60_000);
      expect(sent).toContainEqual(expect.objectContaining({ chatId: STRANGER.id, text: expect.stringContaining(`Your Telegram user id is ${STRANGER.id}`) }));
      expect(sent).toContainEqual(expect.objectContaining({ chatId: OWNER.id, text: "answer: hello" }));

      // The model was asked once, with the starter's model and the key from .env.
      expect(openrouter.requests).toHaveLength(1);
      expect(openrouter.requests[0]).toMatchObject({ model: "z-ai/glm-5.3-flash", apiKey: MODEL_KEY });
      expect(JSON.stringify(openrouter.requests[0]?.messages)).toContain("hello");

      // workerd's own trace of it: the RPC into the object, and the alarm that drove the run and the delivery.
      const traced = await fetch(`${base}/cdn-cgi/local/explorer/api/local/observability/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT name, count(*) AS n FROM spans GROUP BY name" }),
      }).then((response) => response.json() as Promise<{ result?: { rows?: [string, number][] } }>);
      const spans = Object.fromEntries(traced.result?.rows ?? []);
      expect(spans.jsrpc).toBeGreaterThan(0);
      expect(spans.alarm).toBeGreaterThan(0);
    } finally {
      dev.kill("SIGINT");
      const stopped = await Promise.race([dev.exited, Bun.sleep(15_000).then(() => undefined)]);
      if (stopped === undefined) dev.kill("SIGKILL");
      await dev.exited;
      await collected;
    }
    expect(logs).toContain("pikit: Worker started");
    for (const secret of [telegram.token, MODEL_KEY, BRAVE_KEY, env().TELEGRAM_WEBHOOK_SECRET as string]) expect(logs).not.toContain(secret);

    // What the chat's object holds in its SQLite: the message admitted and answered, and the answer delivered.
    const objects = join(project, ".wrangler", "state", "v3", "do", `${NAME}-Conversation`);
    const databases = readdirSync(objects).filter((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
    const holding = (key: string) =>
      databases.filter((file) => {
        const db = new DatabaseSync(join(objects, file), { readOnly: true });
        try {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'submissions_requests'").all();
          return tables.length > 0 && db.prepare("SELECT 1 FROM submissions_requests WHERE conversation_key = ?").all(key).length > 0;
        } finally {
          db.close();
        }
      });
    expect(holding(`telegram:${STRANGER.id}`)).toEqual([]);
    const [chat, ...others] = holding(`telegram:${OWNER.id}`);
    expect(others).toEqual([]);
    expect(chat).toBeDefined();
    const db = new DatabaseSync(join(objects, chat as string), { readOnly: true });
    const answers = db.prepare("SELECT conversation_key, kind, text FROM submissions_answers").all();
    const pieces = db.prepare("SELECT conversation_key, state FROM outbound_pieces").all();
    db.close();
    expect(answers).toEqual([{ conversation_key: `telegram:${OWNER.id}`, kind: "completed", text: "answer: hello" }]);
    expect(pieces).toEqual([{ conversation_key: `telegram:${OWNER.id}`, state: "delivered" }]);
    expect(existsSync(join(project, ".pikit", "deployment-cloudflare.json"))).toBe(true);
  },
  TIMEOUT,
);
