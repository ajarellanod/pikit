/**
 * The channel's step of `pikit configure`, against the fake Bot API, with a scripted person at the
 * terminal.
 */

import { afterEach, expect, test } from "bun:test";
import { type ConfigureIO, configure } from "./configure.ts";
import { type FakeTelegram, startFakeTelegram } from "./fake-telegram.ts";

const OWNER = { id: 1001, first_name: "Ada", username: "ada" };
const STRANGER = { id: 2002, first_name: "Eve" };

const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

/** A terminal where a person gives `answers` in order, and a `.env` in memory. */
function terminal(telegram: FakeTelegram, options: { interactive?: boolean; env?: Record<string, string>; answers?: (string | (() => string))[] } = {}) {
  const env = new Map(Object.entries(options.env ?? {}));
  const answers = [...(options.answers ?? [])];
  const said: string[] = [];
  const asked: string[] = [];
  const next = async (question: string) => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected question: ${question}`);
    return typeof answer === "function" ? answer() : answer;
  };
  const io: ConfigureIO = {
    interactive: options.interactive ?? true,
    config: { apiBase: telegram.url },
    get: (name) => env.get(name),
    set: (name, value) => void env.set(name, value),
    ask: next,
    askSecret: next,
    say: (line) => void said.push(line),
  };
  return { io, env, said, asked };
}

function fake(): FakeTelegram {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  return telegram;
}

test("from nothing: it explains BotFather, checks the token, and allows whoever messages the bot", async () => {
  const telegram = fake();
  const t = terminal(telegram, { answers: [telegram.token, "y"] });
  // The person opens the bot and says hi a moment after being asked.
  setTimeout(() => telegram.say(OWNER, "hi"), 100);

  const missing = await configure(t.io);

  expect(missing).toEqual([]);
  expect(t.said.join("\n")).toContain("https://t.me/BotFather");
  expect(t.said.join("\n")).toContain("bot @pikit_test_bot (https://t.me/pikit_test_bot)");
  expect(t.asked.at(-1)).toContain("Message from Ada (@ada), id 1001. Allow them");
  expect(Object.fromEntries(t.env)).toEqual({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: "1001" });
  // The person sees it worked, in Telegram; and the setup message will not reach the agent later.
  expect(telegram.sent).toEqual([{ chatId: OWNER.id, text: "✓ You can talk to this bot once it runs (pikit up).", html: false }]);
  expect(telegram.pending()).toEqual([]);
  expect(t.said.join("\n")).not.toContain(telegram.token);
});

test("a mistyped token is caught at once and asked again", async () => {
  const telegram = fake();
  const t = terminal(telegram, { env: { TELEGRAM_ALLOWED_USERS: "1001" }, answers: ["123:typo", telegram.token] });

  expect(await configure(t.io)).toEqual([]);
  expect(t.said.join("\n")).toContain("Telegram does not know that token (401)");
  expect(t.env.get("TELEGRAM_BOT_TOKEN")).toBe(telegram.token);
});

test("someone who is not you can be refused, and the next person allowed", async () => {
  const telegram = fake();
  const t = terminal(telegram, { env: { TELEGRAM_BOT_TOKEN: telegram.token }, answers: ["n", "y"] });
  setTimeout(() => {
    telegram.say(STRANGER, "hello?");
    telegram.say(OWNER, "it's me");
  }, 50);

  expect(await configure(t.io)).toEqual([]);
  expect(t.env.get("TELEGRAM_ALLOWED_USERS")).toBe("1001");
});

test("without a terminal it asks nothing: it checks what the environment gives, or says what is missing", async () => {
  const telegram = fake();
  const complete = terminal(telegram, { interactive: false, env: { TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: "1001, 1002" } });
  const empty = terminal(telegram, { interactive: false });
  const noUsers = terminal(telegram, { interactive: false, env: { TELEGRAM_BOT_TOKEN: telegram.token } });
  const badToken = terminal(telegram, { interactive: false, env: { TELEGRAM_BOT_TOKEN: "1:bad", TELEGRAM_ALLOWED_USERS: "1" } });

  expect(await configure(complete.io)).toEqual([]);
  expect(complete.said.join("\n")).toContain("TELEGRAM_ALLOWED_USERS: 2 user(s) allowed");
  // What the environment gave is saved to .env, which the app reads.
  expect(Object.fromEntries(complete.env)).toEqual({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: "1001, 1002" });
  expect((await configure(empty.io))[0]).toContain("TELEGRAM_BOT_TOKEN");
  expect((await configure(noUsers.io))[0]).toContain("TELEGRAM_ALLOWED_USERS");
  expect((await configure(badToken.io))[0]).toContain("TELEGRAM_BOT_TOKEN");
});

test("a bot with a webhook is explained, not waited on", async () => {
  const telegram = fake();
  telegram.webhookUrl = "https://example.com/hook";
  const t = terminal(telegram, { env: { TELEGRAM_BOT_TOKEN: telegram.token } });

  expect((await configure(t.io))[0]).toContain("TELEGRAM_ALLOWED_USERS");
  expect(t.said.join("\n")).toContain("The bot has a webhook");
});
