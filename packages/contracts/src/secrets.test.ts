import { expect, test } from "bun:test";
import { REDACTED, redactSecrets, secretLikePaths } from "./secrets.ts";

const CONFIG = {
  "channel-telegram": { botToken: "123456789:AAEabcdefghijklmnopqrstuvwxyz012345", tokenSecret: "TELEGRAM_BOT_TOKEN", maxTokens: 4096, pollMs: 1000 },
  "tool-mcp": { servers: [{ url: "https://user:hunter2@mcp.example.com/sse", headers: { Authorization: "Bearer abcdefghijklmnop" } }] },
  "provider-openrouter": { model: "openrouter/z-ai/glm-5.3-flash", apiKey: "whatever-it-is" },
  "health-registry": { essential: ["channel-telegram"], graceMs: 30000 },
  other: { id: "6f1c1b2e-58a4-4b5f-9e38-2b5d9c0e7a11", note: "a plain sentence with words", leaked: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", random: "a8F3kq9Zx72LmP0vB4nT6yW1cD5hJ8sQ" },
};

test("secretLikePaths: values under secret-like keys (not a secret's name) and credential-shaped values anywhere", () => {
  expect(secretLikePaths(CONFIG).sort()).toEqual(
    [
      "channel-telegram.botToken",
      "tool-mcp.servers[0].url",
      "tool-mcp.servers[0].headers.Authorization",
      "provider-openrouter.apiKey",
      "other.leaked",
      "other.random",
    ].sort(),
  );
});

test("redactSecrets: a copy with those values replaced; names of secrets, numbers, models and ids stay", () => {
  const redacted = redactSecrets(CONFIG);

  expect(redacted["channel-telegram"]).toEqual({ botToken: REDACTED, tokenSecret: "TELEGRAM_BOT_TOKEN", maxTokens: 4096, pollMs: 1000 });
  expect(redacted["tool-mcp"].servers[0]).toEqual({ url: REDACTED, headers: { Authorization: REDACTED } });
  expect(redacted["provider-openrouter"]).toEqual({ model: "openrouter/z-ai/glm-5.3-flash", apiKey: REDACTED });
  expect(redacted["health-registry"]).toEqual(CONFIG["health-registry"]);
  expect(redacted.other).toEqual({ id: CONFIG.other.id, note: CONFIG.other.note, leaked: REDACTED, random: REDACTED });
  expect(JSON.stringify(redacted)).not.toContain("hunter2");
  expect(CONFIG["channel-telegram"].botToken).toStartWith("123456789:");
});
