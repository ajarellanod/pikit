// The login's terminal side of `credentials.ts`: the adapter's `loginInteraction` behind `choosing`,
// over a stubbed terminal, and `lineTerminal` over in-memory streams; the upload of a login to a
// deployed app (`durable`), against a local `Bun.serve` fake of its route. No network, no pi-ai login.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CREDENTIALS_MODULE, type CredentialsModule, choosing, credentialsRoute, deviceId, type LoginTerminal, lineTerminal, safeUploadUrl, uploadCredential } from "./credentials.ts";

// As the script does at run time: the adapter's module, not a type import (see credentials.ts).
const { loginInteraction } = (await import(CREDENTIALS_MODULE)) as CredentialsModule;

const METHOD = {
  type: "select",
  message: "Select Anthropic login method:",
  options: [
    { id: "browser", label: "Browser login (default)" },
    { id: "copy_code", label: "Copy code login (headless)" },
  ],
} as const;

/** A terminal answering `lines` in turn, recording what it was asked and shown. */
function stubTerminal(lines: string[]) {
  const asked: { question: string; secret: boolean }[] = [];
  const printed: string[] = [];
  const terminal: LoginTerminal = {
    print: (text) => void printed.push(text),
    ask: async (question, options) => {
      asked.push({ question, secret: options.secret });
      return lines.shift() ?? "";
    },
  };
  return { terminal, asked, printed };
}

function interaction(lines: string[], options: { preferred?: string; interactive: boolean }) {
  const stub = stubTerminal(lines);
  return { ...stub, interaction: choosing(loginInteraction(stub.terminal), stub.terminal, { preferred: options.preferred, interactive: options.interactive }) };
}

test("a choice that offers the preferred option is answered with it, without asking (copy-code where the app runs)", async () => {
  const { interaction: login, asked, printed } = interaction([], { preferred: "copy_code", interactive: true });

  expect(await login.prompt(METHOD)).toBe("copy_code");
  expect(asked).toEqual([]);
  expect(printed).toEqual(["Select Anthropic login method: Copy code login (headless)"]);
});

test("on a terminal, a choice is asked as a numbered list and answered with the option's id", async () => {
  const { interaction: login, asked, printed } = interaction(["2"], { preferred: "device", interactive: true });

  expect(await login.prompt(METHOD)).toBe("copy_code");
  expect(printed[0]).toBe("Select Anthropic login method:\n  1. Browser login (default)\n  2. Copy code login (headless)");
  expect(asked).toEqual([{ question: "Choose 1-2 (Enter: 1)", secret: false }]);
});

test("without a terminal, a choice takes its first option, pi-ai's default", async () => {
  const { interaction: login, asked } = interaction([], { interactive: false });

  expect(await login.prompt(METHOD)).toBe("browser");
  expect(asked).toEqual([]);
});

test("text, secret and code prompts are asked as they are, a secret without echo", async () => {
  const { interaction: login, asked } = interaction([" sk-typed \n", "code#state", "name"], { preferred: "copy_code", interactive: true });

  expect(await login.prompt({ type: "secret", message: "API key:", placeholder: "sk-..." })).toBe("sk-typed");
  expect(await login.prompt({ type: "manual_code", message: "Paste the code:", placeholder: "code#state" })).toBe("code#state");
  expect(await login.prompt({ type: "text", message: "Account:" })).toBe("name");
  expect(asked).toEqual([
    { question: "API key: (sk-...)", secret: true },
    { question: "Paste the code: (code#state)", secret: false },
    { question: "Account:", secret: false },
  ]);
});

test("the login's events and signal are the adapter's", () => {
  const controller = new AbortController();
  const stub = stubTerminal([]);
  const login = choosing(loginInteraction(stub.terminal, controller.signal), stub.terminal, { preferred: undefined, interactive: true });

  (login.notify as (event: unknown) => void)({ type: "device_code", userCode: "AB-CD", verificationUri: "https://example.test/device" });
  expect(stub.printed).toEqual(["\nGo to https://example.test/device and enter AB-CD\n"]);
  expect(login.signal).toBe(controller.signal);
});

/** `lineTerminal` over in-memory streams, in line-editing mode (as on a TTY): it echoes what is typed. */
function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => void (written += chunk.toString()));
  const terminal = lineTerminal(input, output, true);
  return { input, terminal, written: () => written };
}

test("lineTerminal echoes a text answer and not a secret one", async () => {
  const { input, terminal, written } = streams();
  try {
    const text = terminal.ask("Account:", { secret: false });
    input.write("visible-name\r");
    expect(await text).toBe("visible-name");

    const secret = terminal.ask("API key:", { secret: true });
    input.write("sk-hidden\r");
    expect(await secret).toBe("sk-hidden");

    terminal.print("done");
    expect(written()).toContain("Account: ");
    expect(written()).toContain("visible-name");
    expect(written()).toContain("API key: ");
    expect(written()).not.toContain("sk-hidden");
    expect(written()).toEndWith("done\n");
  } finally {
    terminal.close();
  }
});

test("lineTerminal gives up a question its signal aborts (the browser came back first), and echoes again after", async () => {
  const { input, terminal, written } = streams();
  try {
    const controller = new AbortController();
    const pending = terminal.ask("Paste the code:", { secret: true, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();

    const next = terminal.ask("Account:", { secret: false });
    input.write("shown\r");
    expect(await next).toBe("shown");
    expect(written()).toContain("shown");
  } finally {
    terminal.close();
  }
});

test("the installation's device id is a UUID made at the first login, the same at every later one, in .pikit/device-id", () => {
  const project = mkdtempSync(join(tmpdir(), "pikit-device-id-"));
  try {
    const first = deviceId(project);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deviceId(project)).toBe(first);
    expect(readFileSync(join(project, ".pikit", "device-id"), "utf8").trim()).toBe(first);
    expect(statSync(join(project, ".pikit")).mode & 0o777).toBe(0o700);

    // A file that holds no UUID is replaced, never passed to pi-ai (which refuses it).
    writeFileSync(join(project, ".pikit", "device-id"), "not a uuid\n");
    const replaced = deviceId(project);
    expect(replaced).not.toBe(first);
    expect(deviceId(project)).toBe(replaced);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

const SECRET = { type: "oauth", access: "sk-ant-oat-secret-access", refresh: "sk-ant-ort-secret-refresh", expires: 1 };
const TOKEN = "an-admin-token-of-at-least-32-characters";

test("a durable store's route is /admin/api/<store>, a provider's under it; a credential goes only over https or to this machine", () => {
  expect(credentialsRoute("https://bot.ana.workers.dev/", "credentials-do")).toBe("https://bot.ana.workers.dev/admin/api/credentials-do");
  expect(credentialsRoute("https://bot.ana.workers.dev", "credentials-do", "openai-codex")).toBe("https://bot.ana.workers.dev/admin/api/credentials-do/openai-codex");
  expect(["https://bot.ana.workers.dev/x", "http://127.0.0.1:8787/x", "http://localhost:8787/x"].map(safeUploadUrl)).toEqual([true, true, true]);
  expect(["http://bot.ana.workers.dev/x", "ftp://x/y", "not a url"].map(safeUploadUrl)).toEqual([false, false, false]);
});

test("uploadCredential PUTs the credential with the operators' bearer token; what it reports on failure holds neither", async () => {
  const seen: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
  let status = 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push({ method: request.method, path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() });
      return status === 200 ? Response.json({ providerId: "anthropic", type: "oauth" }) : Response.json({ error: "invalid_request", message: "The body is a credential" }, { status });
    },
  });
  try {
    const url = credentialsRoute(`http://127.0.0.1:${server.port}`, "credentials-do", "anthropic");
    expect(await uploadCredential(url, TOKEN, SECRET)).toBeUndefined();
    expect(seen).toEqual([{ method: "PUT", path: "/admin/api/credentials-do/anthropic", authorization: `Bearer ${TOKEN}`, body: SECRET }]);

    const reported: string[] = [];
    for (status of [401, 404, 400]) reported.push((await uploadCredential(url, TOKEN, SECRET)) as string);
    expect(reported[0]).toContain("refused PIKIT_ADMIN_TOKEN");
    expect(reported[1]).toContain("`pikit up`");
    expect(reported[2]).toBe("the deployed app answered 400: The body is a credential");
    // Not https: refused before anything is sent.
    const before = seen.length;
    expect(await uploadCredential(`http://bot.ana.workers.dev/admin/api/credentials-do/anthropic`, TOKEN, SECRET)).toContain("not https");
    expect(seen).toHaveLength(before);
    reported.push((await uploadCredential(`http://127.0.0.1:1/admin/api/credentials-do/anthropic`, TOKEN, SECRET)) as string);
    for (const line of reported) for (const secret of [TOKEN, SECRET.access, SECRET.refresh]) expect(line).not.toContain(secret);
  } finally {
    await server.stop(true);
  }
});
