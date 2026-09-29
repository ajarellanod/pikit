/**
 * `pikit up` on Cloudflare registers the Telegram webhook once the new version answers (SPEC §4.1, C8):
 * deployment-cloudflare's `up`, with a fake wrangler and a fake `/health`, runs the `afterDeploy` hook
 * that channel-telegram-webhook's `component.json` names and `pikit add` records in `pikit.json`,
 * against the channel's fake Telegram. No Cloudflare account, no Telegram.
 *
 * The project is the smallest one that holds both: the channel's installed files (linked from the
 * registry), a two-App `pikit.config.ts` on the repository's `@pikit/core`, `pikit.json` and `.env`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, up } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/commands.ts";
import {
  type FakeTelegram,
  startFakeTelegram,
} from "../../../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/fake-telegram.test-support.ts";
import { PACKAGES_DIR, PIKIT_ROOT } from "./paths.ts";

const CHANNEL = "channel-telegram-webhook";
const SECRET = "a-good-webhook-secret-0123456789";
const URL = "https://edge-bot.acme.workers.dev";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

function project(telegram: FakeTelegram, env: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-deploy-hooks-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "edge-bot" }));
  writeFileSync(join(dir, ".env"), env);
  // As `pikit add channel-telegram-webhook` records it (the manifest's hooks.afterDeploy, by project path).
  const manifest = JSON.parse(readFileSync(join(PIKIT_ROOT, "registry", "components", CHANNEL, "component.json"), "utf8")) as { hooks: { afterDeploy: string } };
  const components = { [CHANNEL]: { hooks: { afterDeploy: `src/pikit/${CHANNEL}/${manifest.hooks.afterDeploy}` } }, "storage-do": {} };
  writeFileSync(join(dir, "pikit.json"), JSON.stringify({ version: 2, targets: ["cloudflare"], registries: { default: "builtin" }, components }));
  mkdirSync(join(dir, "src", "pikit"), { recursive: true });
  symlinkSync(join(PIKIT_ROOT, "registry", "components", CHANNEL, "files", "src", "pikit", CHANNEL), join(dir, "src", "pikit", CHANNEL));
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(PACKAGES_DIR, "core"), join(dir, "node_modules", "@pikit", "core"));
  writeFileSync(
    join(dir, "pikit.config.ts"),
    `import { defineApp } from "@pikit/core";
import channelTelegramWebhook, { worker as channelTelegramWebhookWorker } from "./src/pikit/${CHANNEL}/index.ts";

export const config = {
  "${CHANNEL}": { apiBase: "${telegram.url}" },
};

export default defineApp({
  components: [
    channelTelegramWebhook,
  ],
  config,
});

export const workerConfig = {
  "${CHANNEL}-worker": { apiBase: "${telegram.url}" },
};

export const worker = defineApp({
  components: [
    channelTelegramWebhookWorker,
  ],
  config: workerConfig,
});
`,
  );
  return dir;
}

/** Logged in; `wrangler deploy` succeeds with version v2 at URL; nothing else runs. */
const wrangler: Runner = async (command, { env }) => {
  if (command[1] === "whoami") return { code: 0, stdout: JSON.stringify({ loggedIn: true }) };
  const output = env?.WRANGLER_OUTPUT_FILE_PATH;
  if (command[1] === "deploy" && output !== undefined) writeFileSync(output, `${JSON.stringify({ type: "deploy", version_id: "v2", targets: [URL] })}\n`);
  return { code: 0, stdout: "" };
};

/** `/health` answers the previous version first, then v2; notes whether a webhook was set by each answer. */
function health(telegram: FakeTelegram) {
  const answers = [{ ok: true, version: "v1" }, { ok: true, version: "v2" }];
  const webhooksSetBefore: number[] = [];
  const fetcher = (async () => {
    webhooksSetBefore.push(telegram.webhooksSet);
    return Response.json(answers.length > 1 ? answers.shift() : answers[0]);
  }) as unknown as typeof fetch;
  return { fetcher, webhooksSetBefore };
}

test("pikit up registers the bot's webhook at the deployed URL, with its secret, once the new version answers", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const cwd = project(telegram, `TELEGRAM_BOT_TOKEN=${telegram.token}\nTELEGRAM_ALLOWED_USERS=1001\nTELEGRAM_WEBHOOK_SECRET=${SECRET}\n`);
  const probe = health(telegram);
  const said: string[] = [];

  const deployed = await up({ cwd, run: wrangler, fetch: probe.fetcher, intervalMs: 1, say: (line) => said.push(line) });

  expect(deployed).toEqual({ version: "v2", url: URL });
  // Nothing was registered while the previous version answered (C8).
  expect(probe.webhooksSetBefore).toEqual([0, 0]);
  expect([telegram.webhookUrl, telegram.webhookSecret, telegram.allowedUpdates, telegram.webhooksSet]).toEqual([`${URL}/telegram`, SECRET, ["message"], 1]);
  expect(said).toEqual([`✓ Telegram telegram: webhook ${URL}/telegram`]);
});

test("pikit up fails with what the webhook's registration reports, and names the component", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const cwd = project(telegram, `TELEGRAM_BOT_TOKEN=${telegram.token}\nTELEGRAM_ALLOWED_USERS=1001\n`);

  await expect(up({ cwd, run: wrangler, fetch: health(telegram).fetcher, intervalMs: 1, say: () => {} })).rejects.toThrow(
    `the new version v2 answers at ${URL}, but what runs after a deploy failed:\n  ${CHANNEL}: telegram: TELEGRAM_WEBHOOK_SECRET is not set; run \`pikit configure\`, then \`pikit up\` again\n`,
  );
  expect(telegram.webhookUrl).toBe("");
});
