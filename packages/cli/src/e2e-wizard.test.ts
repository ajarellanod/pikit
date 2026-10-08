/**
 * The guided path, in a real pseudo-terminal, as the installer runs it: `pikit new` with no
 * arguments asks the agent's name, where it runs, where to talk to it (the registry's channel-*
 * components, several at once) and what it can do (the dashboard and the preset's features), writes
 * the project, then runs the channel's own setup and the model's step, and offers to start it.
 * On Cloudflare, chosen in the menu or with the installer's `--target durable --preset
 * telegram-cloudflare`, it asks only the name and what it can do before writing the bot.
 *
 * Telegram is channel-telegram's `fake-telegram.test-support.ts`. Ctrl-C stops the wizard with nothing written;
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
import { startFakeTelegram } from "../../../registry/components/channel-telegram/files/src/pikit/channel-telegram/fake-telegram.test-support.ts";
import { DEFAULT_REGISTRY } from "./paths.ts";
import { setConfigEntry } from "./project/config-file.ts";
import { openRegistry } from "./project/registry-source.ts";

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
function wizard(env: Record<string, string> = {}, args: string[] = []) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, "new", ...args], {
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

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const SPACE = " ";

/** Answers "Where should it run?" with the target at `down` arrows from the first, the server. */
async function runOn(w: ReturnType<typeof wizard>, down: number): Promise<void> {
  await w.waitFor("Where should it run?");
  await w.waitFor("durable — on Cloudflare (Workers + Durable Objects)");
  expect(w.text()).toContain("server — a long-lived process (Docker on a VPS)");
  await Bun.sleep(100);
  w.type(DOWN.repeat(down));
  await Bun.sleep(100);
  w.type("\r");
}

/** Answers the keys one by one, as a person types them: a prompt redraws between two. */
async function keys(w: ReturnType<typeof wizard>, ...typed: string[]): Promise<void> {
  for (const key of typed) {
    await Bun.sleep(100);
    w.type(key);
  }
}

/**
 * Answers the name and the server, then in the channels (several at once, HTTP checked) unchecks HTTP
 * and checks Telegram, and adds nothing in "What can it do?".
 */
async function nameAndTelegram(w: ReturnType<typeof wizard>): Promise<void> {
  await w.waitFor("Name of your agent");
  w.type("my-bot\r");
  await runOn(w, 0);
  await w.waitFor("Where do you want to talk to your agent?");
  const [channels] = openRegistry(DEFAULT_REGISTRY).slots("http", ["server"]);
  const telegramAt = channels?.options.findIndex((o) => o.name === "channel-telegram") ?? -1;
  expect(telegramAt).toBeGreaterThanOrEqual(0);
  expect(channels?.options[0]?.name).toBe("channel-http"); // the cursor starts on the first, checked: the preset's
  await keys(w, SPACE, DOWN.repeat(telegramAt), SPACE, "\r");
  await w.waitFor("What can it do?");
  await w.waitFor("Dashboard");
  expect(w.text()).toContain("MCP tools");
  await keys(w, "\r");
}

test.skipIf(!E2E)(
  "Ctrl-C stops the wizard with nothing written",
  async () => {
    const w = wizard();
    await w.waitFor("Name of your agent");
    w.type("my-bot\r");
    await runOn(w, 0);
    await w.waitFor("Where do you want to talk to your agent?");
    await w.waitFor("Telegram");
    expect(w.text()).toContain("HTTP API");
    await Bun.sleep(100);
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
    await w.waitFor("Created my-bot in");
    // What was answered, as the command that answers it without a terminal.
    await w.waitFor("The same, in a script: pikit new my-bot --preset http --with channel-telegram");
    await w.waitFor("Configure it now?");
    await Bun.sleep(100);
    w.type(RIGHT);
    await Bun.sleep(100);
    w.type("\r");
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
    await w.waitFor("my-bot already exists. Continue setting it up?");
    await Bun.sleep(100);
    w.type("\r");
    await w.waitFor("Configure it now?");
    await Bun.sleep(100);
    w.type("\r");

    let at = await w.waitFor("open https://t.me/BotFather");
    at = await w.waitFor("TELEGRAM_BOT_TOKEN", at);
    w.type("123456:not-the-token\r");
    at = await w.waitFor("Telegram does not know that token (401). Paste it again:", at);
    at = await w.waitFor("TELEGRAM_BOT_TOKEN", at);
    // What people paste: BotFather's whole message, over several lines, inside the bracketed-paste
    // markers their terminal adds; then Enter.
    w.type(`\x1b[200~Done! Congratulations on your new bot.\nUse this token to access the HTTP API:\n${telegram.token}\nKeep your token secure\x1b[201~`);
    await Bun.sleep(100);
    w.type("\r");
    at = await w.waitFor("send it any message now", at);
    telegram.say(OWNER, "hi");
    at = await w.waitFor("Message from Ada (@ada), id 1001. Allow them to talk to your agent?", at);
    await Bun.sleep(100);
    w.type("\r");
    at = await w.waitFor("Start it?", at);
    await Bun.sleep(100);
    w.type(DOWN.repeat(2));
    await Bun.sleep(100);
    w.type("\r");

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

test.skipIf(!E2E)(
  "several channels and a feature: each is installed, and the same command names them all",
  async () => {
    const w = wizard();
    await w.waitFor("Name of your agent");
    w.type("two-bot\r");
    await runOn(w, 0);
    await w.waitFor("Where do you want to talk to your agent?");
    // HTTP stays checked; Telegram, the next one, is checked too.
    await keys(w, DOWN, SPACE, "\r");
    await w.waitFor("What can it do?");
    const features = openRegistry(DEFAULT_REGISTRY).features("http", ["server"]).map((f) => f.name);
    // After the dashboard, the first option.
    await keys(w, DOWN.repeat(1 + features.indexOf("tool-mcp")), SPACE, "\r");
    await w.waitFor("Created two-bot in");
    await w.waitFor("The same, in a script: pikit new two-bot --preset http --with channel-http --with channel-telegram --with tool-mcp\n");
    await w.waitFor("Configure it now?");
    await keys(w, RIGHT, "\r");
    expect(await w.exited).toBe(0);
    const components = Object.keys(JSON.parse(readFileSync(join(parent, "two-bot", "pikit.json"), "utf8")).components);
    for (const name of ["channel-http", "channel-telegram", "tool-mcp"]) expect(components).toContain(name);
    expect(components).not.toContain("admin-api");
  },
  TIMEOUT,
);

/**
 * Adds the dashboard in "What can it do?", then declines "Configure it now?" once the bot is written;
 * returns what the wizard printed.
 */
async function writtenNotConfigured(w: ReturnType<typeof wizard>, name: string): Promise<string> {
  await w.waitFor("What can it do?");
  await w.waitFor("Dashboard");
  // The cursor starts on the first, the dashboard.
  await keys(w, SPACE, "\r");
  await w.waitFor(`Created ${name} in`, 0, 180_000);
  await w.waitFor("Configure it now?");
  await Bun.sleep(100);
  w.type(RIGHT);
  await Bun.sleep(100);
  w.type("\r");
  expect(await w.exited).toBe(0);
  const pikitJson = JSON.parse(readFileSync(join(parent, name, "pikit.json"), "utf8")) as { targets: string[]; components: Record<string, unknown> };
  expect(pikitJson.targets).toEqual(["durable"]);
  expect(Object.keys(pikitJson.components)).toContain("channel-telegram-webhook");
  expect(Object.keys(pikitJson.components)).toContain("deployment-cloudflare");
  expect(Object.keys(pikitJson.components)).toContain("admin-api");
  return w.text();
}

test.skipIf(!E2E)(
  "Cloudflare, chosen in the menu: the Telegram bot on Cloudflare is written, and the same command is printed",
  async () => {
    const w = wizard();
    await w.waitFor("Name of your agent");
    w.type("cf-bot\r");
    await runOn(w, 1);
    const text = await writtenNotConfigured(w, "cf-bot");
    // One preset runs on Cloudflare and makes an agent you talk to: no question of presets.
    expect(text).not.toContain("Which preset do you start from?");
    expect(text).not.toContain("Where do you want to talk to your agent?"); // Cloudflare's one channel
    expect(text).toContain("The same, in a script: pikit new cf-bot --target durable --preset telegram-cloudflare --ui");
    expect(text).toContain("Later: cd cf-bot && pikit configure && pikit up");
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "the installer's --durable: pikit new --target durable --preset telegram-cloudflare asks only the name and what it can do",
  async () => {
    const w = wizard({}, ["--target", "durable", "--preset", "telegram-cloudflare"]);
    await w.waitFor("Name of your agent");
    w.type("flag-bot\r");
    const text = await writtenNotConfigured(w, "flag-bot");
    expect(text).not.toContain("Where should it run?");
    expect(text).toContain("The same, in a script: pikit new flag-bot --target durable --preset telegram-cloudflare --ui");
  },
  TIMEOUT,
);
