// The login's terminal side of `credentials.ts`: the adapter's `loginInteraction` behind `choosing`,
// over a stubbed terminal, and `lineTerminal` over in-memory streams. No network, no pi-ai login.

import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CREDENTIALS_MODULE, type CredentialsModule, choosing, type LoginTerminal, lineTerminal } from "./credentials.ts";

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
