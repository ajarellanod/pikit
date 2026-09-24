/**
 * Log in to Anthropic with a Claude Pro/Max subscription, and store the tokens in this sample's
 * credentials file (`.pikit/credentials.json`, mode 0600):
 *
 *   bun samples/http/scripts/login.ts
 *
 * It runs pi-ai's own OAuth flow (no terminal UI needed): it prints a URL to open in a browser,
 * waits for the browser to come back to a callback on localhost:53692, and also accepts the final
 * redirect URL pasted here when the browser is on another machine. pi-ai then writes the tokens
 * through `model.credentials`, which is the same `credentials-file` component the app uses, so the
 * app refreshes them later and writes the new ones back.
 *
 * It never prints a token. It never touches Pi's own `~/.pi/agent/auth.json`: a refresh would rotate
 * the token the Pi CLI holds. `pikit configure` will do this once the CLI exists.
 */

import { createInterface } from "node:readline/promises";
import { defineApp, defineComponent } from "@pikit/core";
import { type AuthInteraction, type CredentialStore, modelsFrom, type Provider } from "@pikit/pi-adapter";
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

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const interaction: AuthInteraction = {
  notify(event) {
    if (event.type === "auth_url") console.info(`\nOpen this URL in a browser to log in:\n\n  ${event.url}\n\n${event.instructions ?? ""}\n`);
    else if (event.type === "device_code") console.info(`\nGo to ${event.verificationUri} and enter ${event.userCode}\n`);
    else console.info(event.message);
  },
  // pi-ai cancels this prompt (its signal) when the browser reaches the callback first.
  prompt: (prompt) => terminal.question(`${prompt.message} `, prompt.signal ? { signal: prompt.signal } : {}),
};

let code = 0;
try {
  await modelsFrom([found.provider], { credentials: found.credentials }).login("anthropic", "oauth", interaction);
  console.info(`\nLogged in to Anthropic. The tokens are in ${config["credentials-file"].path}.`);
} catch (error) {
  console.error("login failed:", error instanceof Error ? error.message : String(error));
  code = 1;
} finally {
  terminal.close();
  await app.stop();
}
process.exit(code);
