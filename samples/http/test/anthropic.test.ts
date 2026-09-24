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

test.skipIf(!available)(
  "a real Claude answers over HTTP",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pikit-sample-live-"));
    let listened!: (url: URL) => void;
    const listening = new Promise<URL>((resolve) => (listened = resolve));
    // The sample's own components, with the test's token and a free port swapped in.
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
        "server-bun": { port: 0, hostname: "127.0.0.1" },
      },
    }).create();
    await app.start();
    try {
      const response = await fetch(new URL("/v1/messages", await listening), {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "live", text: "Reply with the single word: pong" }),
      });
      const body = (await response.json()) as { text?: string };

      expect(response.status).toBe(200);
      expect(body.text?.toLowerCase()).toContain("pong");
    } finally {
      await app.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);
