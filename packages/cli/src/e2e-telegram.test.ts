/**
 * The Telegram path, end to end, as a user runs it: `pikit new my-bot --preset telegram`,
 * `pikit configure`, `pikit dev`, then a person writes to the bot and the answer arrives in the chat.
 *
 * Telegram is channel-telegram's own `fake-telegram.ts`, a local stand-in of the Bot API, set as the
 * channel's `apiBase`. The model key is a dummy, so the agent's run fails at the provider, and the
 * chat receives the channel's "something went wrong" answer: the whole path runs, no model is
 * called. Slow (`bun install`, the project's own tests), so it runs only with `PIKIT_E2E=1`.
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e-telegram.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTelegram } from "../../../registry/components/channel-telegram/files/src/pikit/channel-telegram/fake-telegram.ts";
import { setConfigEntry } from "./project/config-file.ts";

const E2E = process.env.PIKIT_E2E === "1";
const MAIN = join(import.meta.dir, "main.ts");
const TIMEOUT = 600_000;
const OWNER = { id: 1001, first_name: "Ada", username: "ada" };
const STRANGER = { id: 2002, first_name: "Eve" };
const DUMMY_KEY = "sk-ant-e2e-dummy-not-a-key";

const parent = mkdtempSync(join(tmpdir(), "pikit-e2e-telegram-"));
const project = join(parent, "my-bot");
const telegram = startFakeTelegram();
afterAll(async () => {
  await telegram.stop();
  rmSync(parent, { recursive: true, force: true });
});
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

test.skipIf(!E2E)(
  "pikit new --preset telegram: the project composes, and doctor asks for the bot",
  async () => {
    const started = performance.now();
    const created = await pikit(["new", "my-bot", "--preset", "telegram"], { cwd: parent });
    timings.new = performance.now() - started;
    expect(created.code).toBe(0);
    expect(created.err).not.toContain("✗");

    const doctor = await pikit(["doctor"]);
    expect(doctor.err).toContain("TELEGRAM_BOT_TOKEN is not set");
    expect(doctor.err).toContain("TELEGRAM_ALLOWED_USERS is not set");
    // The project's own copy of the channel's tests runs there, against the fake Bot API.
    const tests = Bun.spawnSync([process.execPath, "test", "src/pikit/channel-telegram"], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(tests.exitCode).toBe(0);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "configure without a terminal says what is missing, then checks the bot and saves it",
  async () => {
    const configPath = join(project, "pikit.config.ts");
    writeFileSync(configPath, setConfigEntry(readFileSync(configPath, "utf8"), "channel-telegram", `{ apiBase: "${telegram.url}", pollTimeoutSeconds: 1 }`));

    const missing = await pikit(["configure", "--yes"], { env: { ANTHROPIC_API_KEY: DUMMY_KEY } });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("create a bot with @BotFather");
    // The channel owns its variables: nothing offered to generate a random bot token.
    expect(readFileSync(join(project, ".env"), "utf8")).not.toContain("TELEGRAM_BOT_TOKEN=");

    const started = performance.now();
    const configured = await pikit(["configure", "--yes"], {
      env: { ANTHROPIC_API_KEY: DUMMY_KEY, TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: String(OWNER.id) },
    });
    timings.configure = performance.now() - started;
    expect(configured.code).toBe(0);
    expect(configured.out).toContain("bot @pikit_test_bot (https://t.me/pikit_test_bot)");
    expect(configured.out + configured.err).not.toContain(telegram.token);
    const env = readFileSync(join(project, ".env"), "utf8");
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${telegram.token}`);
    expect(env).toContain(`TELEGRAM_ALLOWED_USERS=${OWNER.id}`);
    expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600);
    expect((await pikit(["doctor"], { env: { ANTHROPIC_API_KEY: "" } })).code).toBe(0);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "pikit dev: the owner's message is answered in the chat, with typing; a stranger gets only their id",
  async () => {
    const configPath = join(project, "pikit.config.ts");
    writeFileSync(configPath, setConfigEntry(readFileSync(configPath, "utf8"), "server-bun", `{ port: 0, hostname: "127.0.0.1" }`));
    const started = performance.now();
    const dev = Bun.spawn([process.execPath, MAIN, "dev"], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      // The bot is polling once it asked Telegram for updates.
      const deadline = Date.now() + 30_000;
      while (telegram.offsets.length === 0) {
        if (dev.exitCode !== null || Date.now() > deadline) throw new Error(`pikit dev did not start polling: ${await new Response(dev.stderr).text()}`);
        await Bun.sleep(50);
      }
      timings.polling = performance.now() - started;

      telegram.say(STRANGER, "hi");
      telegram.say(OWNER, "hello");
      const sent = await telegram.sentCount(2, 30_000);
      timings.answered = performance.now() - started;

      expect(sent[0]).toMatchObject({ chatId: STRANGER.id, text: expect.stringContaining(`Your Telegram user id is ${STRANGER.id}`) });
      // The dummy key fails at the provider: the channel says so, which proves the whole path.
      expect(sent[1]).toMatchObject({ chatId: OWNER.id, text: expect.stringContaining("something went wrong while answering") });
      expect(telegram.actions).toContainEqual({ chatId: OWNER.id, action: "typing" });
    } finally {
      dev.kill("SIGTERM");
      await dev.exited;
    }
    // Warnings and errors go to stderr (deployment-docker's JSON logger), the rest to stdout.
    const logs = (await new Response(dev.stdout).text()) + (await new Response(dev.stderr).text());
    expect(logs).toContain('"msg":"channel-telegram: receiving messages"');
    expect(logs).toContain('"msg":"agent.failed"');
    expect(logs).not.toContain(telegram.token);
    console.info(
      `e2e telegram timings: new ${ms(timings.new)}, configure ${ms(timings.configure)}, dev to polling ${ms(timings.polling)}, to the answer in the chat ${ms(timings.answered)}`,
    );
  },
  TIMEOUT,
);

function ms(value: number | undefined): string {
  return `${((value ?? 0) / 1000).toFixed(1)} s`;
}
