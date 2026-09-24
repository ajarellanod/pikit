/**
 * The sample against Anthropic for real: the composition of `pikit.config.ts`, with a free port and
 * temporary sessions, and the sample's own credentials. It runs only when a credential exists:
 * - the sample's credentials file has an `anthropic` entry (`bun samples/http/scripts/login.ts`), or
 * - `ANTHROPIC_API_KEY` is already exported.
 * Otherwise it is skipped. It never prints a credential.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp } from "@pikit/core";
import { createSecretsEnv } from "../../../registry/components/secrets-env/files/src/pikit/secrets-env/index.ts";
import { createServerBun } from "../../../registry/components/server-bun/files/src/pikit/server-bun/index.ts";
import definition, { config } from "../pikit.config.ts";

function storedAnthropicCredential(): boolean {
  const path = config["credentials-file"].path;
  if (!existsSync(path)) return false;
  try {
    return Object.hasOwn(JSON.parse(readFileSync(path, "utf8")) as object, "anthropic");
  } catch {
    return false;
  }
}

const available = storedAnthropicCredential() || Boolean(process.env.ANTHROPIC_API_KEY);
const TOKEN = "live-test-token-0123456789abcdef";

/** The sample's own app, with the test's token, a free port, and state and workspace in `dataDir`. */
async function liveSample(dataDir: string) {
  let listened!: (url: URL) => void;
  const listening = new Promise<URL>((resolve) => (listened = resolve));
  const components = definition.components.map((component) => {
    if (component.name === "secrets-env") return createSecretsEnv({ env: { ...process.env, PIKIT_HTTP_TOKEN: TOKEN } });
    if (component.name === "server-bun") return createServerBun({ onListening: listened });
    return component;
  });
  const app = await defineApp({
    components,
    config: {
      ...config,
      "sessions-jsonl": { root: join(dataDir, "sessions") },
      "conversations-file": { path: join(dataDir, "conversations.json") },
      "execution-local": { root: join(dataDir, "workspace") },
      "server-bun": { port: 0, hostname: "127.0.0.1" },
    },
  }).create();
  await app.start();
  const say = async (text: string) => {
    const response = await fetch(new URL("/v1/messages", await listening), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "live", text }),
    });
    return { status: response.status, body: (await response.json()) as { text?: string } };
  };
  return { app, say };
}

test.skipIf(!available)(
  "a real Claude answers over HTTP",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pikit-sample-live-"));
    const { app, say } = await liveSample(dataDir);
    try {
      const answer = await say("Reply with the single word: pong");

      expect(answer.status).toBe(200);
      expect(answer.body.text?.toLowerCase()).toContain("pong");
    } finally {
      await app.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(!available)(
  "a real Claude uses its tools in the workspace",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pikit-sample-live-"));
    const { app, say } = await liveSample(dataDir);
    try {
      const answer = await say("Create a file named hello.txt in your workspace whose whole content is exactly: hi from pikit");

      expect(answer.status).toBe(200);
      expect(readFileSync(join(dataDir, "workspace", "hello.txt"), "utf8").trim()).toBe("hi from pikit");
    } finally {
      await app.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  180_000,
);
