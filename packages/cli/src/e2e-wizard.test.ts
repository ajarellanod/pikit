/**
 * The guided path, in a real pseudo-terminal, as the installer runs it: `pikit new` with no
 * arguments asks the agent's name and where to talk to it (the registry's presets), writes the
 * project, then runs the channel's own setup and the model's step, and offers to start it.
 *
 * Telegram is channel-telegram's `fake-telegram.ts`. Ctrl-C stops the wizard with nothing written;
 * `pikit new` with the same name continues with the project already there. The model key is a
 * dummy exported in the environment, so the model step asks nothing and no Docker is needed.
 * Slow (`bun install`), so it runs only with `PIKIT_E2E=1`.
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e-wizard.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTelegram } from "../../../registry/components/channel-telegram/files/src/pikit/channel-telegram/fake-telegram.ts";
import { setConfigEntry } from "./project/config-file.ts";

const E2E = process.env.PIKIT_E2E === "1";
const MAIN = join(import.meta.dir, "main.ts");
const TIMEOUT = 300_000;
const OWNER = { id: 1001, first_name: "Ada", username: "ada" };
const DUMMY_KEY = "sk-ant-e2e-dummy-not-a-key";

const parent = mkdtempSync(join(tmpdir(), "pikit-e2e-wizard-"));
const project = join(parent, "my-bot");
const telegram = startFakeTelegram();
afterAll(async () => {
  await telegram.stop();
  rmSync(parent, { recursive: true, force: true });
});

/** `pikit new` in a pseudo-terminal: what it printed, without colours, and a way to answer. */
function wizard(env: Record<string, string> = {}) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, "new"], {
    cwd: parent,
    env: { ...process.env, ...env },
    terminal: { cols: 160, rows: 50, data: (_terminal, data) => void (output += decoder.decode(data)) },
  });
  const text = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  return {
    text,
    /** Waits until `expected` appears after `from` characters of output; returns where it ends. */
    async waitFor(expected: string, from = 0, timeoutMs = 60_000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const at = text().indexOf(expected, from);
        if (at >= 0) return at + expected.length;
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`never printed ${JSON.stringify(expected)}; printed:\n${text()}`);
        await Bun.sleep(20);
      }
    },
    type: (keys: string) => proc.terminal?.write(keys),
    exited: proc.exited,
  };
}

/** Answers the first two questions and returns what the preset menu offered for Telegram. */
async function nameAndTelegram(w: ReturnType<typeof wizard>): Promise<void> {
  await w.waitFor("Name of your agent");
  w.type("my-bot\r");
  const menu = await w.waitFor("Choice: ");
  const telegramChoice = /(\d+)\) Telegram/.exec(w.text().slice(0, menu))?.[1];
  expect(telegramChoice).toBeDefined();
  w.type(`${telegramChoice}\r`);
}

test.skipIf(!E2E)(
  "Ctrl-C stops the wizard with nothing written",
  async () => {
    const w = wizard();
    await w.waitFor("Name of your agent");
    w.type("my-bot\r");
    await w.waitFor("Where do you want to talk to your agent?");
    expect(w.text()).toContain("Telegram: chat with your agent from the Telegram app");
    expect(w.text()).toContain("HTTP API");
    await w.waitFor("Choice: ");
    w.type("\x03");
    expect(await w.exited).toBe(130);
    expect(w.text()).toContain('Stopped. Run `pikit new` again and answer "my-bot" to continue.');
    expect(existsSync(project)).toBe(false);
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "the project is written, and configuring can wait",
  async () => {
    const w = wizard();
    await nameAndTelegram(w);
    await w.waitFor("Configure it now");
    w.type("n\r");
    expect(await w.exited).toBe(0);
    expect(w.text()).toContain("Later: cd my-bot && pikit configure && pikit up");
    expect(readFileSync(join(project, "pikit.json"), "utf8")).toContain('"channel-telegram"');
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "pikit new again continues: the bot's token is checked, the owner is allowed by writing to it",
  async () => {
    // The only thing a test must add: where the fake Bot API is.
    const configPath = join(project, "pikit.config.ts");
    writeFileSync(configPath, setConfigEntry(readFileSync(configPath, "utf8"), "channel-telegram", `{ apiBase: "${telegram.url}", pollTimeoutSeconds: 1 }`));

    const w = wizard({ ANTHROPIC_API_KEY: DUMMY_KEY });
    await w.waitFor("Name of your agent");
    w.type("my-bot\r");
    await w.waitFor("my-bot already exists. Continue setting it up? [Y/n]");
    w.type("\r");
    await w.waitFor("Configure it now");
    w.type("\r");

    let at = await w.waitFor("open https://t.me/BotFather");
    at = await w.waitFor("TELEGRAM_BOT_TOKEN: ", at);
    w.type("123456:not-the-token\r");
    at = await w.waitFor("Telegram does not know that token (401). Paste it again:", at);
    at = await w.waitFor("TELEGRAM_BOT_TOKEN: ", at);
    w.type(`${telegram.token}\r`);
    at = await w.waitFor("send it any message now", at);
    telegram.say(OWNER, "hi");
    at = await w.waitFor("Message from Ada (@ada), id 1001. Allow them to talk to your agent? [Y/n]", at);
    w.type("\r");
    at = await w.waitFor("Start it:", at);
    await w.waitFor("Choice [1]: ", at);
    w.type("s\r");

    expect(await w.exited).toBe(0);
    expect(w.text()).toContain("Later: cd my-bot && pikit up");
    expect(w.text()).not.toContain(telegram.token);
    expect(w.text()).not.toContain(DUMMY_KEY);
    const env = readFileSync(join(project, ".env"), "utf8");
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${telegram.token}`);
    expect(env).toContain(`TELEGRAM_ALLOWED_USERS=${OWNER.id}`);
    // The bot told the owner, in the chat, that they can talk to it now.
    expect(telegram.sent.some((m) => m.chatId === OWNER.id)).toBe(true);
  },
  TIMEOUT,
);
