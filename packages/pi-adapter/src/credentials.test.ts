// `model.credentials` on pi-ai 1.0: today's credentials-file component, over a file in today's format,
// behind 1.0 `Models` (`models.ts`). No network: the OAuth provider is a local stub, Anthropic's
// login is stopped before its token exchange, and environment variables come from a stub AuthContext.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AuthContext, AuthPrompt } from "@earendil-works/pi-ai";
import { createProvider, ModelsError, type Provider } from "@earendil-works/pi-ai/models";
import credentialsFile from "../../../registry/components/credentials-file/files/src/pikit/credentials-file/index.ts";
import { type CredentialStore, type LoginTerminal, loginInteraction, type OAuthCredential } from "./credentials.ts";
import { modelsFrom } from "./models.ts";
import { anthropicProvider } from "./providers/anthropic.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

const env = (values: Record<string, string>): AuthContext => ({ env: async (name) => values[name], fileExists: async () => false });

/** A credentials file as credentials-file (on pi-ai 0.99) writes it today, and the started component over it. */
async function fileStore(contents: Record<string, unknown> | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "pikit-durable-credentials-"));
  directories.push(dir);
  const path = join(dir, "credentials.json");
  if (contents !== undefined) writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  let store: CredentialStore | undefined;
  const reader = defineComponent({
    name: "credentials-reader",
    setup(pikit) {
      const handle = pikit.use("model.credentials");
      return { start: () => void (store = handle.get()) };
    },
  });
  const app = await defineApp({ components: [credentialsFile, reader], config: { "credentials-file": { path } }, logger: silentLogger }).create();
  await app.start();
  if (store === undefined) throw new Error("model.credentials was not resolved");
  return { store, path, file: () => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, stop: () => app.stop() };
}

const PROVIDER = "stub-oauth";

/** An OAuth-only provider whose login and refresh are local, counting refreshes. */
function stubOAuthProvider(refresh: (credential: OAuthCredential) => Promise<OAuthCredential>): Provider & { refreshes: () => number } {
  let refreshes = 0;
  const never = (): never => {
    throw new Error("the stub provider does not stream");
  };
  const provider = createProvider({
    id: PROVIDER,
    auth: {
      oauth: {
        name: "Stub OAuth",
        login: async () => ({ type: "oauth", access: "logged-in", refresh: "refresh-login", expires: Date.now() + 3_600_000 }),
        refresh: async (credential) => {
          refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return refresh(credential);
        },
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: [],
    api: { stream: never, streamSimple: never },
  });
  return Object.assign(provider, { refreshes: () => refreshes });
}

test("a 0.99 credentials file serves 1.0 as it is: the stored key wins, an expired token is refreshed once and written back", async () => {
  const before = {
    anthropic: { type: "api_key", key: "sk-stored" },
    [PROVIDER]: { type: "oauth", access: "expired", refresh: "refresh-1", expires: 0 },
  };
  const { store, path, file, stop } = await fileStore(before);
  try {
    const stub = stubOAuthProvider(async (credential) => ({ ...credential, access: "refreshed", refresh: "refresh-2", expires: Date.now() + 3_600_000 }));
    const models = modelsFrom([anthropicProvider(), stub], { credentials: store, authContext: env({ ANTHROPIC_API_KEY: "sk-env" }) });

    expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-stored");
    // Concurrent requests: one refresh, inside the store's modify, and every request gets its token.
    const auths = await Promise.all(Array.from({ length: 5 }, () => models.getAuth(PROVIDER)));
    expect(auths.map((auth) => auth?.auth.apiKey)).toEqual(Array(5).fill("refreshed"));
    expect(stub.refreshes()).toBe(1);

    const after = file();
    expect(after.anthropic).toEqual(before.anthropic);
    expect(after[PROVIDER]).toMatchObject({ type: "oauth", access: "refreshed", refresh: "refresh-2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    await stop();
  }
});

test("a failed refresh rejects with ModelsError code oauth and leaves the stored tokens for a retry", async () => {
  const stored = { type: "oauth", access: "expired", refresh: "refresh-1", expires: 0 };
  const { store, file, stop } = await fileStore({ [PROVIDER]: stored });
  try {
    const stub = stubOAuthProvider(async () => {
      throw new Error("invalid_grant");
    });
    const models = modelsFrom([stub], { credentials: store });

    const error = await models.getAuth(PROVIDER).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ModelsError);
    expect((error as ModelsError).code).toBe("oauth");
    expect(file()[PROVIDER]).toEqual(stored);
  } finally {
    await stop();
  }
});

test("a 1.0 login is written to the file, and a logout removes it", async () => {
  const { store, file, stop } = await fileStore(undefined);
  try {
    const models = modelsFrom([stubOAuthProvider(async (credential) => credential)], { credentials: store });

    await models.login(PROVIDER, "oauth", loginInteraction(silentTerminal()));
    expect(file()[PROVIDER]).toMatchObject({ type: "oauth", access: "logged-in", refresh: "refresh-login" });

    await models.logout(PROVIDER);
    expect(file()).toEqual({});
  } finally {
    await stop();
  }
});

test("Anthropic's 1.0 login asks the login method first; loginInteraction answers with the option's id", async () => {
  const { store, file, stop } = await fileStore(undefined);
  const printed: string[] = [];
  const asked: string[] = [];
  const terminal: LoginTerminal = {
    print: (text) => void printed.push(text),
    ask: async (question) => {
      asked.push(question);
      // 2: copy-code login, which starts no callback server. Then stop before the token exchange.
      if (asked.length === 1) return "2";
      throw new Error("stopped by the test");
    },
  };
  try {
    const models = modelsFrom([anthropicProvider()], { credentials: store });

    const error = await models.login("anthropic", "oauth", loginInteraction(terminal)).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect((error as Error).message).toContain("stopped by the test");
    expect(printed[0]).toContain("Select Anthropic login method:\n  1. Browser login (default)\n  2. Copy code login (headless)");
    expect(asked[0]).toBe("Choose 1-2 (Enter: 1)");
    expect(printed.join("\n")).toContain(encodeURIComponent("https://platform.claude.com/oauth/code/callback"));
    expect(asked[1]).toBe("Paste the code Anthropic shows after you sign in: (code#state)");
    expect(file()).toEqual({});
  } finally {
    await stop();
  }
});

test("loginInteraction: a select takes a number, an id or Enter, and asks again otherwise; text and secret prompts are asked as they are", async () => {
  const select: AuthPrompt = {
    type: "select",
    message: "Pick",
    options: [
      { id: "browser", label: "Browser" },
      { id: "copy_code", label: "Copy code", description: "headless" },
    ],
  };
  const answers = (lines: string[]) => {
    const asks: { question: string; secret: boolean }[] = [];
    const printed: string[] = [];
    const terminal: LoginTerminal = {
      print: (text) => void printed.push(text),
      ask: async (question, options) => {
        asks.push({ question, secret: options.secret });
        return lines.shift() ?? "";
      },
    };
    return { interaction: loginInteraction(terminal), asks, printed };
  };

  expect(await answers(["2"]).interaction.prompt(select)).toBe("copy_code");
  expect(await answers([" browser "]).interaction.prompt(select)).toBe("browser");
  expect(await answers([""]).interaction.prompt(select)).toBe("browser");
  const retried = answers(["3", "copy", "2"]);
  expect(await retried.interaction.prompt(select)).toBe("copy_code");
  expect(retried.asks).toHaveLength(3);
  expect(retried.printed).toEqual(["Pick\n  1. Browser\n  2. Copy code — headless", '"3" is not one of the options.', '"copy" is not one of the options.']);

  const text = answers([" sk-typed \n"]);
  expect(await text.interaction.prompt({ type: "secret", message: "API key:", placeholder: "sk-..." })).toBe("sk-typed");
  expect(text.asks).toEqual([{ question: "API key: (sk-...)", secret: true }]);
  await text.interaction.prompt({ type: "manual_code", message: "Paste:" });
  expect(text.asks[1]).toEqual({ question: "Paste:", secret: false });

  const shown = answers([]);
  shown.interaction.notify({ type: "device_code", userCode: "AB-CD", verificationUri: "https://example.test/device" });
  shown.interaction.notify({ type: "info", message: "Note", links: [{ url: "https://example.test/usage", label: "Usage" }] });
  expect(shown.printed).toEqual(["\nGo to https://example.test/device and enter AB-CD\n", "Note\n  Usage: https://example.test/usage"]);
});

function silentTerminal(): LoginTerminal {
  return {
    print: () => {},
    ask: async () => {
      throw new Error("the stub login asks nothing");
    },
  };
}
