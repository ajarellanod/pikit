/**
 * The sample with `channel-telegram` instead of `channel-http`, as `pikit new --preset telegram` makes
 * it: the same runtime, sessions and registry, the storage and submissions `runtime-pi` brings, and
 * the outbox and the key-value store (for its cursor) the channel brings. Telegram is the channel's own fake Bot API (`fake-telegram.ts`), and
 * the model Pi's faux provider, scripted.
 *
 * For `answers.test.ts`, in the test's process and in `telegram-worker.ts`, a process it kills.
 */

import { join } from "node:path";
import { type ComponentDefinition, defineApp, type Logger, silentLogger } from "@pikit/core";
import { holdTool, scriptedAgent, testComponents } from "@pikit/pi-adapter/testing";
import channelTelegram from "../../../registry/components/channel-telegram/files/src/pikit/channel-telegram/index.ts";
import conversationsFile from "../../../registry/components/conversations-file/files/src/pikit/conversations-file/index.ts";
import outboundDurable from "../../../registry/components/outbound-durable/files/src/pikit/outbound-durable/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import { createRuntimePi } from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { createSecretsEnv } from "../../../registry/components/secrets-env/files/src/pikit/secrets-env/index.ts";
import sessionsJsonl from "../../../registry/components/sessions-jsonl/files/src/pikit/sessions-jsonl/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import storageSqlite from "../../../registry/components/storage-sqlite/files/src/pikit/storage-sqlite/index.ts";
import submissionsSql from "../../../registry/components/submissions-sql/files/src/pikit/submissions-sql/index.ts";

/** The fake Bot API's default bot, and who may talk to it. */
export const BOT_TOKEN = "123456789:fake-token-for-tests";
export const OWNER = { id: 1001, first_name: "Ada", username: "ada" };

export interface TelegramAppOptions {
  dataDir: string;
  /** The fake Bot API's URL. */
  apiBase: string;
  /** What the agent's `hold` tool does when a message is exactly `hold`. */
  hold: () => Promise<string>;
  /** Components between the runtime and the channel in start order (so they stop between them). */
  between?: ComponentDefinition[];
  logger?: Logger;
}

export function telegramApp(options: TelegramAppOptions) {
  // `never`: a resumed run does not run the tool again; Pi tells the model it was interrupted.
  const agent = scriptedAgent(holdTool(options.hold, "never"));
  const { agents, provider } = testComponents({ agents: [agent] });
  return defineApp({
    components: [
      createSecretsEnv({ env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: String(OWNER.id) } }),
      sessionsJsonl,
      conversationsFile,
      provider,
      agents,
      storageSqlite,
      submissionsSql,
      createRuntimePi(),
      routerBasic,
      ...(options.between ?? []),
      outboundDurable,
      storageKvSql,
      channelTelegram,
    ],
    config: {
      "sessions-jsonl": { root: join(options.dataDir, "sessions") },
      "conversations-file": { path: join(options.dataDir, "conversations.json") },
      "storage-sqlite": { path: join(options.dataDir, "pikit.db") },
      "router-basic": { defaultAgent: agent.name },
      "channel-telegram": { apiBase: options.apiBase, pollTimeoutSeconds: 1 },
    },
    logger: options.logger ?? silentLogger,
  });
}
