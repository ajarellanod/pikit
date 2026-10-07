/**
 * Model credentials, in the two places an app can run:
 * - on this machine, for `pikit dev`: `.pikit/` here and the shell's environment;
 * - where the deployment runs the app, for `pikit up`: through its `exec` (in Docker, the volume
 *   and `.env`). A login made here never reaches it, and one made there never reaches this machine:
 *   there is one copy of each credential, so a refreshed token never leaves another copy stale.
 *
 * Both run `credentials.ts` with the project's own components (`model.credentials`). The login
 * itself is `pikit configure --login` (`commands/configure.ts`).
 *
 * Only the providers an agent names in its `model` need credentials: an installed provider no agent
 * uses (the preset's `anthropic` while every agent is on `faux/scripted`) is reported `unused`, and
 * nothing asks for its key.
 */

import type { AppExec } from "./deployment-module.ts";
import type { CredentialsResult } from "./credentials.ts";
import { modelProvider } from "./references.ts";
import { type ProjectManifest, readProjectManifest } from "./pikit-json.ts";
import type { ProbeResult } from "./probe.ts";
import { probe, runScript, runScriptInApp } from "./run.ts";
import { CliError } from "../ui.ts";

export type CheckedCredentials = Extract<CredentialsResult, { ok: true }> & {
  /** Installed model providers no agent names in its `model`: not checked, and not in `providers`. */
  unused: string[];
};

/**
 * Per model provider the agents use, whether anything is configured; no network call, no refresh.
 * `used` is `providersInUse`'s answer, when the caller has it already.
 */
export async function checkModelCredentials(projectDir: string, exec?: AppExec, used?: Set<string> | undefined): Promise<CheckedCredentials> {
  const inUse = used ?? (await providersInUse(projectDir));
  const result =
    exec === undefined
      ? await runScript<CredentialsResult>("credentials.ts", projectDir, ["check"])
      : await runScriptInApp<CredentialsResult>(exec, "credentials.ts", ["check"]);
  if (!result.ok) throw new CliError(`could not read the model credentials${exec === undefined ? "" : " where the app runs"}: ${result.error}\nRun \`pikit doctor\`.`);
  return usedOnly(result, inUse);
}

/** `checked`, its providers split by `used`: everything is used when that is not known. */
export function usedOnly(checked: Extract<CredentialsResult, { ok: true }>, used: Set<string> | undefined): CheckedCredentials {
  if (used === undefined) return { ...checked, unused: [] };
  const entries = Object.entries(checked.providers);
  return {
    ...checked,
    providers: Object.fromEntries(entries.filter(([id]) => used.has(id))),
    unused: entries.filter(([id]) => !used.has(id)).map(([id]) => id),
  };
}

/**
 * The model providers the project's agents name (`<provider>/<model>`), as `pikit doctor` reads them;
 * `undefined` when that is not known (the app does not compose, or an agent names no model), and then
 * every installed provider counts. A model `prepare(state)` picks per run cannot be seen.
 */
export async function providersInUse(projectDir: string): Promise<Set<string> | undefined> {
  return providersNamed(await probe(projectDir));
}

/** `providersInUse`, from a probe the caller has already. */
export function providersNamed(result: ProbeResult): Set<string> | undefined {
  if (!result.ok) return undefined;
  const providers = result.agents.map((agent) => modelProvider(agent.model));
  return providers.includes(undefined) ? undefined : new Set(providers as string[]);
}

/**
 * The variable holding a provider's API key, from the manifest of the component that provides it
 * (`checked.owners`), as `pikit.json` recorded it: its first secret variable (`ANTHROPIC_API_KEY` for
 * provider-anthropic, the manifest's `environment` lists it first). `undefined` when that component
 * declares none (its key's variable is config, as provider-openai-compatible's; or it needs no key),
 * and when it provides several providers, whose variables one list cannot tell apart.
 */
export function apiKeyVariable(projectDir: string, checked: Pick<CheckedCredentials, "owners">, providerId: string): string | undefined {
  return keyVariableOf(readProjectManifest(projectDir).components, checked, providerId);
}

/** `apiKeyVariable`, from the installed components' records (`pikit.json`'s `components`). */
export function keyVariableOf(components: ProjectManifest["components"], checked: Pick<CheckedCredentials, "owners">, providerId: string): string | undefined {
  const owner = checked.owners[providerId];
  if (owner === undefined || Object.values(checked.owners).filter((o) => o === owner).length > 1) return undefined;
  return components[owner]?.environment.find((variable) => variable.secret)?.name;
}

/**
 * Whether `pikit configure --login <id>` can work: pi-ai has an OAuth login for it
 * (`provider.auth.oauth`), and the project has a `model.credentials` component to store it in (on
 * Cloudflare there is none: a key only).
 */
export function canLogIn(checked: Pick<CheckedCredentials, "store" | "oauth">, providerId: string): boolean {
  return checked.store !== undefined && checked.oauth.includes(providerId);
}

/** How to set a provider's key, for a message: `set ANTHROPIC_API_KEY in .env`, or the component's README. */
export function apiKeyHint(projectDir: string, checked: Pick<CheckedCredentials, "owners">, providerId: string): string {
  const variable = apiKeyVariable(projectDir, checked, providerId);
  const owner = checked.owners[providerId];
  return variable !== undefined ? `set ${variable} in .env` : `set its API key as ${owner ?? "its component"}'s README says`;
}
