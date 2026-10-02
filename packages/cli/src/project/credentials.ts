/**
 * Run as `bun credentials.ts <project-dir> <output-file> check | login <provider> [<option>]` in the project's
 * directory: on this machine for `pikit dev`, or where the app runs for `pikit up` (the deployment's
 * `exec`). The model-credential half of `pikit configure`, as `samples/http/scripts/login.ts`:
 *
 * - It builds a small app from the project's own components: the one that provides
 *   `model.credentials` (`credentials-file`) and those that provide `model.provider`, with the
 *   config `pikit.config.ts` gives them, so the tokens land exactly where the app reads them.
 * - `check` reports, per provider, whether anything is configured (a stored credential or the
 *   provider's variable in the environment), without a network call or an OAuth refresh.
 * - `login <provider> [<option>]` runs pi-ai's own OAuth flow through `@pikit/pi-adapter` and pi-ai
 *   writes the tokens through `model.credentials`. The adapter's `loginInteraction` asks pi-ai's
 *   prompts on this terminal: a choice (Anthropic's login method: browser or copy-code) as a numbered
 *   list, a secret without echo. `<option>` answers a choice that offers it without asking
 *   (`copy_code` where the app runs: its container publishes no port, so a browser cannot reach the
 *   login's callback); without a terminal, a choice takes its first option, pi-ai's default.
 *
 * It uses the project's `@pikit/core` and `@pikit/pi-adapter`, resolved from its `node_modules`.
 * It never prints a credential, and never reads or writes Pi's own `~/.pi/agent/auth.json`: a
 * refresh here would rotate the token the Pi CLI holds.
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { AppDefinition, ComponentDefinition, defineApp, defineComponent } from "@pikit/core";

/*
 * What this script needs from the project's `@pikit/pi-adapter`, described here instead of imported:
 * the adapter is loaded from the project at run time (`load` below), and the project's version may
 * differ from the one next to the CLI. A type import would also make the CLI package resolve the
 * adapter through its own `node_modules`, which made TypeScript 7 lose the core tests' relative
 * module augmentations. Opaque where the script only passes values through.
 */
/** pi-ai's `Provider`, passed through untouched. */
type Provider = { readonly id: string };
/** pi-ai's `CredentialStore`, passed through untouched. */
type CredentialStore = object;
/** pi-ai's `AuthPrompt`: what its login flow asks. */
type AuthPrompt = { message: string; signal?: AbortSignal | undefined } & (
  | { type: "text" | "secret" | "manual_code"; placeholder?: string | undefined }
  | { type: "select"; options: readonly { id: string; label: string; description?: string | undefined }[] }
);
/** pi-ai's `AuthInteraction`; its events are passed through untouched. */
interface AuthInteraction {
  signal?: AbortSignal | undefined;
  notify(event: never): void;
  prompt(prompt: AuthPrompt): Promise<string>;
}
/** The adapter's `LoginTerminal`: what `loginInteraction` asks and shows through. */
export interface LoginTerminal {
  print(text: string): void;
  ask(question: string, options: { secret: boolean; signal?: AbortSignal | undefined }): Promise<string>;
}
/** The adapter's credentials module, reduced to `loginInteraction`. */
export interface CredentialsModule {
  loginInteraction(terminal: LoginTerminal, signal?: AbortSignal): AuthInteraction;
}
/** Where the adapter keeps `loginInteraction`, resolved from the project. */
export const CREDENTIALS_MODULE = "@pikit/pi-adapter/credentials";
/** `modelsFrom` of `@pikit/pi-adapter`, reduced to the two calls made here. */
type ModelsFrom = (
  providers: Provider[],
  options: { credentials: CredentialStore | undefined },
) => {
  checkAuth(providerId: string): Promise<unknown>;
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<unknown>;
};

export type CredentialsResult =
  | { ok: true; providers: Record<string, boolean>; store: string | undefined }
  | { ok: false; error: string };

interface Found {
  credentials: CredentialStore | undefined;
  providers: Map<string, Provider>;
}

/** A module of the project, resolved from its `node_modules`. */
async function load<T>(specifier: string, projectDir: string): Promise<T> {
  return (await import(pathToFileURL(Bun.resolveSync(specifier, projectDir)).href)) as T;
}

async function openCredentials(projectDir: string): Promise<{ found: Found; stop(): Promise<void>; store: string | undefined; models: ModelsFrom }> {
  const core = await load<{ defineApp: typeof defineApp; defineComponent: typeof defineComponent }>("@pikit/core", projectDir);
  const adapter = await load<{ modelsFrom: ModelsFrom }>("@pikit/pi-adapter", projectDir);
  const definition = ((await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default: AppDefinition }).default;

  // Which components provide what, as the app itself resolves it.
  const described = (await definition.create()).describe();
  const store = described.capabilities["model.credentials"];
  const storeName = store?.selected ?? store?.providers[0];
  const providerNames = new Set(Object.values(described.capabilities["model.provider"]?.keys ?? {}));
  const names = new Set([...providerNames, ...(storeName === undefined ? [] : [storeName])]);
  const components = definition.components.filter((c) => names.has(c.name));
  const config = Object.fromEntries(Object.entries(definition.config).filter(([key]) => names.has(key)));

  const found: Found = { credentials: undefined, providers: new Map() };
  const probe: ComponentDefinition = core.defineComponent({
    name: "configure-credentials",
    setup(pikit) {
      const credentials = pikit.useOptional("model.credentials");
      const providers = pikit.useKeyed("model.provider");
      return {
        start() {
          found.credentials = credentials.get();
          for (const key of providers.keys()) {
            const provider = providers.get(key);
            if (provider !== undefined) found.providers.set(key, provider);
          }
        },
      };
    },
  });
  const app = await core.defineApp({ components: [...components, probe], config }).create();
  await app.start();
  return { found, stop: () => app.stop(), store: storeName, models: adapter.modelsFrom };
}

async function check(projectDir: string): Promise<CredentialsResult> {
  const { found, stop, store, models } = await openCredentials(projectDir);
  try {
    const all = models([...found.providers.values()], { credentials: found.credentials });
    const providers: Record<string, boolean> = {};
    for (const id of found.providers.keys()) providers[id] = (await all.checkAuth(id)) !== undefined;
    return { ok: true, providers, store };
  } finally {
    await stop();
  }
}

async function login(projectDir: string, providerId: string, preferred: string | undefined): Promise<CredentialsResult> {
  const { found, stop, store, models } = await openCredentials(projectDir);
  const { loginInteraction } = await load<CredentialsModule>(CREDENTIALS_MODULE, projectDir);
  const terminal = lineTerminal(process.stdin, process.stdout);
  try {
    const provider = found.providers.get(providerId);
    if (provider === undefined) return { ok: false, error: `no installed component provides the model provider "${providerId}"` };
    if (found.credentials === undefined) {
      return { ok: false, error: "no installed component provides model.credentials, so a login has nowhere to be stored (install credentials-file)" };
    }
    const interaction = choosing(loginInteraction(terminal), terminal, { preferred, interactive: process.stdin.isTTY === true });
    await models([provider], { credentials: found.credentials }).login(providerId, "oauth", interaction);
    return { ok: true, providers: { [providerId]: true }, store };
  } finally {
    terminal.close();
    await stop();
  }
}

/**
 * `interaction`, with a choice answered without asking: by its `preferred` option when it offers it,
 * by its first one (pi-ai's default) when nobody can be asked. Any other choice, and every other
 * prompt, is `interaction`'s.
 */
export function choosing(interaction: AuthInteraction, terminal: Pick<LoginTerminal, "print">, options: { preferred: string | undefined; interactive: boolean }): AuthInteraction {
  return {
    ...(interaction.signal !== undefined && { signal: interaction.signal }),
    notify: (event) => interaction.notify(event),
    async prompt(prompt) {
      if (prompt.type === "select") {
        const chosen = prompt.options.find((option) => option.id === options.preferred) ?? (options.interactive ? undefined : prompt.options[0]);
        if (chosen !== undefined) {
          terminal.print(`${prompt.message} ${chosen.label}`);
          return chosen.id;
        }
      }
      return await interaction.prompt(prompt);
    },
  };
}

/**
 * A `LoginTerminal` over `input` and `output`, the one place this script reads the terminal (only this
 * directory is shared where the app runs, so the CLI's own prompts are out of reach). A secret's
 * keystrokes are not echoed. `terminal`: line editing, as on a TTY.
 */
export function lineTerminal(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, terminal = (input as { isTTY?: boolean }).isTTY === true): LoginTerminal & { close(): void } {
  let muted = false;
  // readline echoes what is typed through its output: muted while a secret is typed.
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const lines = createInterface({ input, output: echo, terminal });
  return {
    print: (text) => void output.write(`${text}\n`),
    async ask(question, { secret, signal }) {
      output.write(`${question} `);
      muted = secret;
      try {
        // pi-ai cancels a prompt (its signal) when the browser reaches the callback first.
        return await lines.question("", signal === undefined ? {} : { signal });
      } finally {
        if (muted) output.write("\n");
        muted = false;
      }
    },
    close: () => lines.close(),
  };
}

if (import.meta.main) {
  const [dir = ".", output = "", mode, providerId = "", preferred] = process.argv.slice(2);
  // Where the app runs (`runScriptInApp`), the project is passed as `.`.
  const projectDir = resolve(dir);
  let result: CredentialsResult;
  try {
    result = mode === "login" ? await login(projectDir, providerId, preferred) : await check(projectDir);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
