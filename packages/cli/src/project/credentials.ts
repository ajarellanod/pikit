/**
 * Run as `bun credentials.ts <project-dir> <output-file> check | login <provider>` in the project's
 * directory. The model-credential half of `pikit configure`, as `samples/http/scripts/login.ts`:
 *
 * - It builds a small app from the project's own components: the one that provides
 *   `model.credentials` (`credentials-file`) and those that provide `model.provider`, with the
 *   config `pikit.config.ts` gives them, so the tokens land exactly where the app reads them.
 * - `check` reports, per provider, whether anything is configured (a stored credential or the
 *   provider's variable in the environment), without a network call or an OAuth refresh.
 * - `login <provider>` runs pi-ai's own OAuth flow through `@pikit/pi-adapter` and pi-ai writes the
 *   tokens through `model.credentials`.
 *
 * It uses the project's `@pikit/core` and `@pikit/pi-adapter`, resolved from its `node_modules`.
 * It never prints a credential, and never reads or writes Pi's own `~/.pi/agent/auth.json`: a
 * refresh here would rotate the token the Pi CLI holds (SPEC §13).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { AppDefinition, ComponentDefinition, defineApp, defineComponent } from "@pikit/core";

/*
 * What this script needs from the project's `@pikit/pi-adapter`, described here instead of imported:
 * the adapter is loaded from the project at run time (`load` below), and the project's version may
 * differ from the one next to the CLI. A type import would also make the CLI package resolve the
 * adapter through its own `node_modules`, which made TypeScript 7 lose the core tests' relative
 * module augmentations (see AGENTS.md, Lessons). Opaque where the script only passes values through.
 */
/** pi-ai's `Provider`, passed through untouched. */
type Provider = { readonly id: string };
/** pi-ai's `CredentialStore`, passed through untouched. */
type CredentialStore = object;
/** The events and prompts pi-ai's login flow uses (pi-ai's `AuthInteraction`). */
interface AuthInteraction {
  notify(
    event:
      | { type: "auth_url"; url: string; instructions?: string }
      | { type: "device_code"; userCode: string; verificationUri: string }
      | { type: "info" | "progress"; message: string },
  ): void;
  prompt(prompt: { message: string; signal?: AbortSignal }): Promise<string>;
}
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

async function openCredentials(projectDir: string): Promise<{ found: Found; stop(): Promise<void>; store: string | undefined; models: ModelsFrom }> {
  const load = async <T>(specifier: string): Promise<T> => (await import(pathToFileURL(Bun.resolveSync(specifier, projectDir)).href)) as T;
  const core = await load<{ defineApp: typeof defineApp; defineComponent: typeof defineComponent }>("@pikit/core");
  const adapter = await load<{ modelsFrom: ModelsFrom }>("@pikit/pi-adapter");
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

async function login(projectDir: string, providerId: string): Promise<CredentialsResult> {
  const { found, stop, store, models } = await openCredentials(projectDir);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const provider = found.providers.get(providerId);
    if (provider === undefined) return { ok: false, error: `no installed component provides the model provider "${providerId}"` };
    if (found.credentials === undefined) {
      return { ok: false, error: "no installed component provides model.credentials, so a login has nowhere to be stored (install credentials-file)" };
    }
    const interaction: AuthInteraction = {
      notify(event) {
        if (event.type === "auth_url") console.info(`\nOpen this URL in a browser to log in:\n\n  ${event.url}\n\n${event.instructions ?? ""}\n`);
        else if (event.type === "device_code") console.info(`\nGo to ${event.verificationUri} and enter ${event.userCode}\n`);
        else console.info(event.message);
      },
      // pi-ai cancels this prompt (its signal) when the browser reaches the callback first.
      prompt: (prompt) => terminal.question(`${prompt.message} `, prompt.signal ? { signal: prompt.signal } : {}),
    };
    await models([provider], { credentials: found.credentials }).login(providerId, "oauth", interaction);
    return { ok: true, providers: { [providerId]: true }, store };
  } finally {
    terminal.close();
    await stop();
  }
}

if (import.meta.main) {
  const [projectDir = ".", output = "", mode, providerId = ""] = process.argv.slice(2);
  let result: CredentialsResult;
  try {
    result = mode === "login" ? await login(projectDir, providerId) : await check(projectDir);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
