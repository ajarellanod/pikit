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
 * On `durable` there is no `exec`: the app's store (credentials-do) is its own Durable Object, reached
 * through the deployed Worker's operator route (`credentialsRoute`) at the deployment's `url`, with
 * `.env`'s `PIKIT_ADMIN_TOKEN`. A login is made here and uploaded there; nothing of it stays here.
 * This machine's check then reports only its keys (`.env`, which `pikit up` uploads as secrets).
 *
 * The project's `pikit.config.ts` names no target (the deployment's entrypoint gives it), so it is
 * `pikit.json`'s `targets` that says `durable`.
 *
 * Only the providers an agent names in its `model` need credentials: an installed provider no agent
 * uses (the preset's `anthropic` while every agent is on `faux/scripted`) is reported `unused`, and
 * nothing asks for its key.
 */

import { type AppExec, deploymentUrl } from "./deployment-module.ts";
import { type CredentialsResult, credentialsRoute, safeUploadUrl } from "./credentials.ts";
import { modelProvider } from "./references.ts";
import { type ProjectManifest, readProjectManifest } from "./pikit-json.ts";
import type { ProbeResult } from "./probe.ts";
import { probe, projectEnv, runScript, runScriptInApp } from "./run.ts";
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
      ? await runScript<CredentialsResult>("credentials.ts", projectDir, ["check", ...(credentialsAreRemote(projectDir) ? ["--remote"] : [])])
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

/** Whether the project runs on `durable`, where `model.credentials` lives only in the deployed App. */
export function credentialsAreRemote(projectDir: string): boolean {
  return readProjectManifest(projectDir).targets.includes("durable");
}

/** The deployed app a `durable` project's logins go to: its URL and the operators' token, or why there is none. */
export async function deployedApp(projectDir: string): Promise<{ url: string; token: string } | { why: string }> {
  const url = await deploymentUrl(projectDir);
  if (url === undefined) return { why: "the app was not deployed from this machine yet: run `pikit up` first" };
  if (!safeUploadUrl(url)) return { why: `the deployed app answers at ${url}, which is not https: a credential is sent only over https` };
  const token = projectEnv(projectDir).PIKIT_ADMIN_TOKEN;
  if (token === undefined || token === "") return { why: "PIKIT_ADMIN_TOKEN is not set in .env: the deployed app's operator routes need it" };
  return { url, token };
}

/**
 * On `durable`, the providers the deployed app's `store` holds a credential for (each provider id: true),
 * read from its operator route; or why it could not be read. No credential crosses: the route lists
 * ids and types.
 */
export async function deployedCredentials(projectDir: string, store: string, fetcher: typeof fetch = fetch): Promise<{ stored: Record<string, boolean> } | { why: string }> {
  const app = await deployedApp(projectDir);
  if ("why" in app) return app;
  let response: Response;
  try {
    response = await fetcher(credentialsRoute(app.url, store), { headers: { authorization: `Bearer ${app.token}` } });
  } catch (error) {
    return { why: `the deployed app could not be reached at ${app.url} (${error instanceof Error ? error.message : String(error)})` };
  }
  if (response.status === 401) return { why: "the deployed app refused PIKIT_ADMIN_TOKEN: is the one in .env the one deployed?" };
  if (!response.ok) return { why: `the deployed app answered ${response.status} at ${credentialsRoute(app.url, store)}` };
  const { credentials } = (await response.json().catch(() => ({}))) as { credentials?: unknown };
  if (!Array.isArray(credentials)) return { why: "the deployed app answered no list of credentials" };
  const stored: Record<string, boolean> = {};
  for (const each of credentials) if (typeof (each as { providerId?: unknown })?.providerId === "string") stored[(each as { providerId: string }).providerId] = true;
  return { stored };
}

/** How to set a provider's key, for a message: `set ANTHROPIC_API_KEY in .env`, or the component's README. */
export function apiKeyHint(projectDir: string, checked: Pick<CheckedCredentials, "owners">, providerId: string): string {
  const variable = apiKeyVariable(projectDir, checked, providerId);
  const owner = checked.owners[providerId];
  return variable !== undefined ? `set ${variable} in .env` : `set its API key as ${owner ?? "its component"}'s README says`;
}
