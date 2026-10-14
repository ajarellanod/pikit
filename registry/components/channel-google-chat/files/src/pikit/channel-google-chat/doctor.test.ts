// Owner: integration. The check that both halves are configured alike (doctor.ts).
/**
 * channel-google-chat's `pikit doctor` step: on Cloudflare (a `workerConfig` given), the Worker's half
 * and the default export must agree on what both read, defaults included; on a server nothing is
 * compared.
 */

import { expect, test } from "bun:test";
import { doctor } from "./doctor.ts";

const env = () => undefined;

test("on a server (no Worker's App) nothing is compared", async () => {
  expect(await doctor({ config: { instances: ["ops"] }, get: env })).toEqual([]);
});

test("halves that agree, defaults included and keys in any order, pass", async () => {
  expect(await doctor({ config: {}, workerConfig: {}, get: env })).toEqual([]);
  // The default export's own settings (thinkingText, previewEveryMs) are not the Worker's.
  expect(await doctor({ config: { thinkingText: "One moment…", instances: [] }, workerConfig: { conversations: { default: "thread", chats: {} } }, get: env })).toEqual([]);
  const conversations = { default: "chat", chats: { "spaces/AAA": "thread", "spaces/BBB": "chat" } };
  expect(
    await doctor({
      config: { instances: ["ops"], conversations },
      workerConfig: { conversations: { chats: { "spaces/BBB": "chat", "spaces/AAA": "thread" }, default: "chat" }, instances: ["ops"] },
      get: env,
    }),
  ).toEqual([]);
});

test("halves that differ fail, one problem per key, naming both entries and both values", async () => {
  const problems = await doctor({
    config: { instances: ["ops"], conversations: { default: "chat", chats: {} } },
    workerConfig: { apiBase: "https://chat.googleapis.com" },
    get: env,
  });
  expect(problems).toEqual([
    `instances differs between the Worker's half (workerConfig "channel-google-chat-worker": []) and the default export (config "channel-google-chat": ["ops"]), defaults included: both halves must have the same apiBase, jwksUrl, instances, conversations`,
    `conversations differs between the Worker's half (workerConfig "channel-google-chat-worker": {"chats":{},"default":"thread"}) and the default export (config "channel-google-chat": {"chats":{},"default":"chat"}), defaults included: both halves must have the same apiBase, jwksUrl, instances, conversations`,
  ]);
  expect(await doctor({ config: { jwksUrl: "https://keys.test/certs" }, workerConfig: {}, get: env })).toEqual([expect.stringContaining("jwksUrl differs") as never]);
});
