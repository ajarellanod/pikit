/**
 * Log in to Anthropic with a Claude Pro/Max subscription, and store the tokens in this sample's
 * credentials file (`.pikit/credentials.json`, mode 0600):
 *
 *   bun samples/http/scripts/login.ts [browser | copy_code]
 *
 * It runs pi-ai's own OAuth flow (no terminal UI needed). It first asks the login method, unless
 * given as the argument (`copy_code` in a container, whose callback a browser cannot reach):
 * - browser: it prints a URL to open, waits for the browser to come back to a callback on
 *   localhost:53692, and also accepts the final redirect URL pasted here;
 * - copy_code: it prints a URL to open, and Anthropic's page shows a code to paste here.
 * The adapter's `loginInteraction` asks the prompts; a secret is not echoed. pi-ai then writes the tokens
 * through `model.credentials`, which is the same `credentials-file` component the app uses, so the
 * app refreshes them later and writes the new ones back.
 *
 * It never prints a token. It never touches Pi's own `~/.pi/agent/auth.json`: a refresh would rotate
 * the token the Pi CLI holds. `pikit configure` will do this once the CLI exists.
 */

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { defineApp, defineComponent } from "@pikit/core";
import { type CredentialStore, modelsFrom, type Provider } from "@pikit/pi-adapter";
import { type AuthInteraction, type LoginTerminal, loginInteraction } from "@pikit/pi-adapter/durable/credentials";
import credentialsFile from "../../../registry/components/credentials-file/files/src/pikit/credentials-file/index.ts";
import providerAnthropic from "../../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import { config } from "../pikit.config.ts";

// The same two components the app uses, reached through their capabilities.
let found: { credentials: CredentialStore; provider: Provider | undefined } | undefined;
const login = defineComponent({
  name: "login",
  setup(pikit) {
    const credentials = pikit.use("model.credentials");
    const providers = pikit.useKeyed("model.provider");
    return { start: () => void (found = { credentials: credentials.get(), provider: providers.get("anthropic") }) };
  },
});
const app = await defineApp({
  components: [credentialsFile, providerAnthropic, login],
  config: { "credentials-file": config["credentials-file"] },
}).create();
await app.start();
if (found?.provider === undefined) throw new Error("login: provider-anthropic is not installed");

// What is typed is echoed through `echo`, muted while a secret is typed.
let muted = false;
const echo = new Writable({
  write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const lines = createInterface({ input: process.stdin, output: echo, terminal: process.stdin.isTTY === true });
const terminal: LoginTerminal = {
  print: (text) => console.info(text),
  async ask(question, { secret, signal }) {
    process.stdout.write(`${question} `);
    muted = secret;
    try {
      // pi-ai cancels a prompt (its signal) when the browser reaches the callback first.
      return await lines.question("", signal === undefined ? {} : { signal });
    } finally {
      if (muted) process.stdout.write("\n");
      muted = false;
    }
  },
};
const method = process.argv[2];
const asked = loginInteraction(terminal);
const interaction: AuthInteraction = {
  ...asked,
  // The method given as the argument answers the login's choice without asking.
  prompt: async (prompt) => (prompt.type === "select" && prompt.options.some((option) => option.id === method) ? (method as string) : await asked.prompt(prompt)),
};

let code = 0;
try {
  await modelsFrom([found.provider], { credentials: found.credentials }).login("anthropic", "oauth", interaction);
  console.info(`\nLogged in to Anthropic. The tokens are in ${config["credentials-file"].path}.`);
} catch (error) {
  console.error("login failed:", error instanceof Error ? error.message : String(error));
  code = 1;
} finally {
  lines.close();
  await app.stop();
}
process.exit(code);
