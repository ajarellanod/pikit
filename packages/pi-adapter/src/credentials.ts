/**
 * `model.credentials` on pi-ai 1.0. See README.md, "pi-ai 1.0".
 *
 * The `CredentialStore` contract is pi-ai's: one credential per provider id, `modify` the only,
 * serialized write path, OAuth refresh run by `Models.getAuth()` inside `modify` so the new tokens are
 * written back through the store, a failed refresh leaving the stored credential as it was. A store
 * (credentials-file) keeps pi-ai's `Credential` shapes as they are.
 *
 * The login: pi-ai's Anthropic OAuth login first asks a `select` prompt (browser or copy-code login). A prompt answered with free text fails it ("Unknown Anthropic login method").
 * `loginInteraction` answers every prompt type over a line-based terminal, for `pikit configure`'s
 * login script and the samples' login scripts.
 *
 * Neutral: no node-only import; the terminal is the caller's.
 */

import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export type {
  ApiKeyCredential,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";

/** A line-based terminal: what `loginInteraction` needs. */
export interface LoginTerminal {
  /** Show text to the person logging in. */
  print(text: string): void;
  /**
   * Ask for one line. `secret`: do not echo it. Rejects when `signal` aborts: pi-ai cancels a
   * prompt that something else answered (the browser reaching the callback first).
   */
  ask(question: string, options: { secret: boolean; signal?: AbortSignal | undefined }): Promise<string>;
}

/** pi-ai's `AuthInteraction` over `terminal`; `signal` cancels the whole login. */
export function loginInteraction(terminal: LoginTerminal, signal?: AbortSignal): AuthInteraction {
  return {
    ...(signal !== undefined && { signal }),
    notify(event) {
      if (event.type === "auth_url") terminal.print(`\nOpen this URL in a browser to log in:\n\n  ${event.url}\n${event.instructions === undefined ? "" : `\n${event.instructions}\n`}`);
      else if (event.type === "device_code") terminal.print(`\nGo to ${event.verificationUri} and enter ${event.userCode}\n`);
      else if (event.type === "info") terminal.print([event.message, ...(event.links ?? []).map((link) => `  ${link.label ?? link.url}: ${link.url}`)].join("\n"));
      else terminal.print(event.message);
    },
    prompt: (prompt) => answer(terminal, prompt),
  };
}

async function answer(terminal: LoginTerminal, prompt: AuthPrompt): Promise<string> {
  if (prompt.type !== "select") {
    const hint = prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`;
    return (await terminal.ask(`${prompt.message}${hint}`, { secret: prompt.type === "secret", signal: prompt.signal })).trim();
  }
  const { options } = prompt;
  if (options.length === 0) throw new Error(`login: "${prompt.message}" offers no option`);
  terminal.print([prompt.message, ...options.map((option, index) => `  ${index + 1}. ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`)].join("\n"));
  for (;;) {
    // pi-ai wants the option's id; a person types its number (Enter: the first, pi-ai's default).
    const typed = (await terminal.ask(`Choose 1-${options.length} (Enter: 1)`, { secret: false, signal: prompt.signal })).trim();
    const chosen = typed === "" ? options[0] : /^\d+$/.test(typed) ? options[Number(typed) - 1] : options.find((option) => option.id === typed);
    if (chosen !== undefined) return chosen.id;
    terminal.print(`"${typed}" is not one of the options.`);
  }
}
