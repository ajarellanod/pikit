/**
 * The guided path, in a real pseudo-terminal, as the installer runs it: `pikit new` with no
 * arguments asks the agent's name, where it runs, where to talk to it (the registry's channel-*
 * components, several at once) and what it can do (the dashboard and the preset's features), writes
 * the project, then runs the channel's own setup and the model's step, and offers to start it.
 * On Cloudflare, chosen in the menu or with the installer's `--target durable --preset
 * telegram-cloudflare`, it writes the Telegram bot.
 *
 * The registry decides what each menu lists, and in which order: the test reads each menu as the
 * wizard draws it and goes to an option by its label (a component's or preset's title), never by its
 * position, and answers whichever questions the registry makes the wizard ask.
 *
 * Telegram is channel-telegram's `fake-telegram.test-support.ts`. Ctrl-C stops the wizard with nothing written;
 * `pikit new` with the same name continues with the project already there. The model key is a
 * dummy exported in the environment, so the model step asks nothing and no Docker is needed.
 * Slow (`bun install`), so it runs only with `PIKIT_E2E=1`.
 *
 *   PIKIT_E2E=1 bun test packages/cli/src/e2e-wizard.test.ts
 */

import { afterAll, afterEach, expect, test } from "bun:test";
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

/** A wizard a failed test left waiting at a question: stopped, so it does not outlive its test. */
const running = new Set<{ kill: () => void }>();
afterEach(() => {
  for (const proc of running) proc.kill();
  running.clear();
});

const registry = openRegistry(DEFAULT_REGISTRY);
const CHANNELS = "Where do you want to talk to your agent?";
const PRESETS = "Which preset do you start from?";
const FEATURES = "What can it do?";

/** What a menu shows of a title: the part before ": ", as the wizard's `option` (the rest is the hint). */
const label = (title: string): string => title.split(": ")[0] as string;
const componentLabel = (name: string): string => label(registry.manifest(name).title ?? name);
const presetLabel = (name: string): string => label(registry.presets().find((preset) => preset.name === name)?.title ?? name);

/** `pikit new` in a pseudo-terminal: what it printed, without colours, and a way to answer. */
function wizard(env: Record<string, string> = {}, args: string[] = []) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, "new", ...args], {
    cwd: parent,
    env: { ...process.env, ...env },
    terminal: { cols: 160, rows: 50, data: (_terminal, data) => void (output += decoder.decode(data)) },
  });
  running.add(proc);
  void proc.exited.then(() => running.delete(proc));
  const text = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  return {
    text,
    /**
     * Waits until `expected` appears after `from` characters of output; returns where it ends. Fails
     * at once when `failOn` appears there instead.
     */
    async waitFor(expected: string, from = 0, timeoutMs = 60_000, failOn?: string): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const shown = text();
        const at = shown.indexOf(expected, from);
        if (at >= 0) return at + expected.length;
        const failed = failOn !== undefined && shown.includes(failOn, from);
        if (failed || proc.exitCode !== null || Date.now() > deadline) throw new Error(`never printed ${JSON.stringify(expected)}; printed:\n${shown}`);
        await Bun.sleep(20);
      }
    },
    /** Waits until one of `questions` is asked after `from`; returns the first asked. */
    async nextQuestion(questions: readonly string[], from = 0, timeoutMs = 60_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const shown = text();
        const asked = questions
          .map((question) => ({ question, at: shown.indexOf(`◆  ${question}`, from) }))
          .filter(({ at }) => at >= 0)
          .sort((a, b) => a.at - b.at)[0];
        if (asked !== undefined) return asked.question;
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`asked none of ${JSON.stringify(questions)}; printed:\n${shown}`);
        await Bun.sleep(20);
      }
    },
    type: (keys: string) => proc.terminal?.write(keys),
    exited: proc.exited,
  };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const SPACE = " ";

/** Answers "Where should it run?" with `target`; returns where the answer is printed. */
async function runOn(w: ReturnType<typeof wizard>, target: "server" | "durable"): Promise<number> {
  await w.waitFor("durable — on Cloudflare (Workers + Durable Objects)");
  expect(w.text()).toContain("server — a long-lived process (Docker on a VPS)");
  return await answer(w, "Where should it run?", [target]);
}

/**
 * The menu `question` as first drawn after `from`: each option's line after its marker (◻ unchecked,
 * ◼ checked; or ○, and ● under the cursor, when one is picked), in order; and where the drawing ends.
 */
async function menu(w: ReturnType<typeof wizard>, question: string, from = 0): Promise<{ options: { marker: string; text: string }[]; end: number }> {
  const start = await w.waitFor(`◆  ${question}`, from);
  const end = await w.waitFor("Enter: confirm", start);
  const options = w
    .text()
    .slice(start, end)
    .split("\n")
    .flatMap((line) => {
      const match = /^│  ([◻◼○●]) (.*)$/.exec(line);
      return match === null ? [] : [{ marker: match[1] as string, text: (match[2] as string).trimEnd() }];
    });
  return { options, end };
}

/** Whether an option's line is the label's: the label alone, or followed by its hint or its description. */
const shows = (text: string, wanted: string): boolean => text === wanted || text.startsWith(`${wanted} (`) || text.startsWith(`${wanted} — `);

/**
 * Answers the menu `question` drawn after `from` with the options labelled `wanted`, found by label:
 * one, reached with the arrows from the cursor (●); or several, going down from the first option (where
 * clack's cursor starts) and pressing Space on each whose check differs from what is wanted. Returns
 * where the answered question is printed; a refused answer ("Please select at least one option.")
 * fails at once.
 */
async function answer(w: ReturnType<typeof wizard>, question: string, wanted: readonly string[], from = 0): Promise<number> {
  const { options, end } = await menu(w, question, from);
  const listed = options.map((option) => option.text);
  const missing = wanted.filter((each) => !listed.some((text) => shows(text, each)));
  if (missing.length > 0) throw new Error(`"${question}" does not list ${missing.join(", ")}: ${listed.join(" | ")}`);
  if (options.some((option) => option.marker === "◻" || option.marker === "◼")) {
    let cursor = 0;
    for (const [at, option] of options.entries()) {
      if ((option.marker === "◼") === wanted.some((each) => shows(option.text, each))) continue;
      await keys(w, DOWN.repeat(at - cursor), SPACE);
      cursor = at;
    }
  } else {
    if (wanted.length !== 1) throw new Error(`"${question}" takes one answer, not ${wanted.length}`);
    const cursor = options.findIndex((option) => option.marker === "●");
    const to = options.findIndex((option) => shows(option.text, wanted[0] as string));
    await keys(w, to > cursor ? DOWN.repeat(to - cursor) : UP.repeat(cursor - to));
  }
  await keys(w, "\r");
  return await w.waitFor(`◇  ${question}`, end, 10_000, `▲  ${question}`);
}

/** Answers the keys one by one, as a person types them: a prompt redraws between two. */
async function keys(w: ReturnType<typeof wizard>, ...typed: string[]): Promise<void> {
  for (const key of typed) {
    await Bun.sleep(100);
    w.type(key);
  }
}

/**
 * Answers the name and the server, then in the channels (several at once, the preset's HTTP checked)
 * unchecks HTTP and checks Telegram, and adds nothing in "What can it do?".
 */
async function nameAndTelegram(w: ReturnType<typeof wizard>): Promise<void> {
  await w.waitFor("Name of your agent");
  w.type("my-bot\r");
  const at = await runOn(w, "server");
  // Every channel of the registry that runs on a server, in the registry's order; the preset's checked.
  const [channels] = registry.slots("http", ["server"]);
  expect(channels?.defaults).toEqual(["channel-http"]);
  expect(channels?.options.map((o) => o.name)).toContain("channel-telegram");
  const { options } = await menu(w, CHANNELS, at);
  expect(options.length).toBe(channels?.options.length ?? -1);
  for (const [i, channel] of (channels?.options ?? []).entries()) {
    expect(shows(options[i]?.text ?? "", componentLabel(channel.name))).toBe(true);
    expect(options[i]?.marker).toBe(channels?.defaults.includes(channel.name) ? "◼" : "◻");
  }
  const answered = await answer(w, CHANNELS, [componentLabel("channel-telegram")], at);
  await w.waitFor(FEATURES, answered);
  await w.waitFor("Dashboard", answered);
  expect(w.text()).toContain("MCP tools");
  await keys(w, "\r");
}

test.skipIf(!E2E)(
  "Ctrl-C stops the wizard with nothing written",
  async () => {
    const w = wizard();
    await w.waitFor("Name of your agent");
    w.type("my-bot\r");
    await runOn(w, "server");
    await w.waitFor(CHANNELS);
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
    // The preset's websearch tool asks for its optional key: Enter skips it.
    at = await w.waitFor("BRAVE_API_KEY (Enter skips)", at);
    await Bun.sleep(100);
    w.type("\r");
    await answer(w, "Start it?", ["Not now"], at);

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
    let at = await runOn(w, "server");
    // HTTP stays checked; Telegram is checked too.
    at = await answer(w, CHANNELS, [componentLabel("channel-http"), componentLabel("channel-telegram")], at);
    await answer(w, FEATURES, [componentLabel("tool-mcp")], at);
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
 * Answers what the registry makes the wizard ask after `from` for the Telegram bot on Cloudflare: the
 * preset (when several run there), its channels (when several do: the preset's own, kept), and the
 * dashboard in "What can it do?"; then declines "Configure it now?" once the bot is written. Returns
 * what the wizard printed.
 */
async function writtenNotConfigured(w: ReturnType<typeof wizard>, name: string, from = 0): Promise<string> {
  expect(registry.slots("telegram-cloudflare", ["durable"])[0]?.defaults).toEqual(["channel-telegram-webhook"]);
  let at = from;
  for (;;) {
    const question = await w.nextQuestion([PRESETS, CHANNELS, FEATURES], at);
    if (question === FEATURES) break;
    at = await answer(w, question, [question === PRESETS ? presetLabel("telegram-cloudflare") : componentLabel("channel-telegram-webhook")], at);
  }
  await answer(w, FEATURES, ["Dashboard"], at);
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
    const text = await writtenNotConfigured(w, "cf-bot", await runOn(w, "durable"));
    // The preset's own channel, kept: nothing to add to the command.
    expect(text).toContain("The same, in a script: pikit new cf-bot --target durable --preset telegram-cloudflare --ui");
    expect(text).toContain("Later: cd cf-bot && pikit configure && pikit up");
  },
  TIMEOUT,
);

test.skipIf(!E2E)(
  "the installer's --durable: pikit new --target durable --preset telegram-cloudflare asks neither where it runs nor which preset",
  async () => {
    const w = wizard({}, ["--target", "durable", "--preset", "telegram-cloudflare"]);
    await w.waitFor("Name of your agent");
    w.type("flag-bot\r");
    const text = await writtenNotConfigured(w, "flag-bot");
    expect(text).not.toContain("Where should it run?");
    expect(text).not.toContain(PRESETS);
    expect(text).toContain("The same, in a script: pikit new flag-bot --target durable --preset telegram-cloudflare --ui");
  },
  TIMEOUT,
);
