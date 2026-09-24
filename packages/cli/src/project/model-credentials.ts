/**
 * Model credentials, in the two places an app can run (SPEC §11):
 * - on this machine, for `pikit dev`: `.pikit/` here and the shell's environment;
 * - where the deployment runs the app, for `pikit up`: through its `exec` (in Docker, the volume
 *   and `.env`). A login made here never reaches it, and one made there never reaches this machine:
 *   there is one copy of each credential, so a refreshed token never leaves another copy stale.
 *
 * Both run `credentials.ts` with the project's own components (`model.credentials`).
 */

import type { AppExec } from "./deployment-module.ts";
import type { CredentialsResult } from "./credentials.ts";
import { runScript, runScriptInApp } from "./run.ts";
import { CliError } from "../ui.ts";

export type CheckedCredentials = Extract<CredentialsResult, { ok: true }>;

/** Per installed model provider, whether anything is configured; no network call, no refresh. */
export async function checkModelCredentials(projectDir: string, exec?: AppExec): Promise<CheckedCredentials> {
  const result =
    exec === undefined
      ? await runScript<CredentialsResult>("credentials.ts", projectDir, ["check"])
      : await runScriptInApp<CredentialsResult>(exec, "credentials.ts", ["check"]);
  if (!result.ok) throw new CliError(`could not read the model credentials${exec === undefined ? "" : " where the app runs"}: ${result.error}\nRun \`pikit doctor\`.`);
  return result;
}

/** pi-ai's OAuth login for `providerId`, stored by the project's `model.credentials` where it runs. */
export async function loginModel(projectDir: string, providerId: string, exec?: AppExec): Promise<void> {
  const result =
    exec === undefined
      ? await runScript<CredentialsResult>("credentials.ts", projectDir, ["login", providerId], { interactive: true })
      : await runScriptInApp<CredentialsResult>(exec, "credentials.ts", ["login", providerId], { interactive: true });
  if (!result.ok) throw new CliError(`login to ${providerId} failed: ${result.error}`);
}

/** pi-ai's variable for a provider's API key: `ANTHROPIC_API_KEY` for `anthropic`. */
export function apiKeyName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
