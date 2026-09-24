/**
 * `pikit configure`: what a project needs before it runs, and nothing else.
 *
 * 1. The variables the installed components declare (`environment` in their manifests), written to
 *    `.env` with mode 0600. A secret is asked without echo; a required `*_TOKEN` can be generated.
 * 2. Model credentials, for each installed model provider that has none: a login through pi-ai's
 *    own flow, stored by the project's `model.credentials` component (`credentials-file`), or an
 *    API key in `.env`.
 *
 * Without a terminal (or with `--yes`) it asks nothing: a variable comes from the process
 * environment or from `--generate <NAME>`, and a missing required one fails the command. It never
 * prints a value, and never reads or writes Pi's own `~/.pi/agent/auth.json` (SPEC §13).
 */

import type { EnvironmentVariable } from "../registry/manifest.ts";
import type { CredentialsResult } from "../project/credentials.ts";
import { ENV_FILE, readEnv, writeEnv } from "../project/env-file.ts";
import { readProjectManifest } from "../project/pikit-json.ts";
import { runScript } from "../project/run.ts";
import { ask, askSecret, CliError, isInteractive, log } from "../ui.ts";

export interface ConfigureOptions {
  /** Ask nothing, as without a terminal. */
  yes?: boolean;
  /** Variables to fill with a new random value (32 bytes, hex). */
  generate?: string[];
  /** Run this provider's OAuth login (in a terminal: it prints a URL to open). */
  login?: string;
}

export async function configure(projectDir: string, options: ConfigureOptions = {}): Promise<void> {
  const interactive = options.yes !== true && isInteractive();
  const variables = declaredVariables(projectDir);
  const current = readEnv(projectDir);
  const updates = new Map<string, string>();
  const missing: string[] = [];

  for (const v of variables) {
    if ((current.get(v.name) ?? "") !== "") {
      log.info(`  ${v.name}: already set`);
      continue;
    }
    const value = await valueFor(v, options, interactive);
    if (value !== undefined && value !== "") updates.set(v.name, value);
    else if (v.required) missing.push(v.name);
  }
  if (updates.size > 0) {
    writeEnv(projectDir, updates);
    log.ok(`${ENV_FILE} (mode 0600): set ${[...updates.keys()].join(", ")}`);
  }

  const unconfigured = await configureModels(projectDir, options, interactive, variables);

  const problems = [
    ...missing.map((name) => `${name} is required and not set: export it, pass --generate ${name}, or run \`pikit configure\` in a terminal`),
    ...unconfigured.map((id) => `the model provider "${id}" has no credentials: run \`pikit configure --login ${id}\` in a terminal, or set its API key (e.g. ${apiKeyName(id)})`),
  ];
  for (const problem of problems) log.problem(problem);
  if (problems.length > 0) throw new CliError(`pikit configure: ${problems.length} thing(s) left to configure`);
  log.ok("configured");
}

/** Every installed component's variables, once each; required when any component requires it. */
function declaredVariables(projectDir: string): EnvironmentVariable[] {
  const byName = new Map<string, EnvironmentVariable>();
  for (const component of Object.values(readProjectManifest(projectDir).components)) {
    for (const v of component.environment) {
      const seen = byName.get(v.name);
      byName.set(v.name, seen === undefined ? v : { ...seen, required: seen.required || v.required, secret: seen.secret || v.secret });
    }
  }
  return [...byName.values()];
}

async function valueFor(v: EnvironmentVariable, options: ConfigureOptions, interactive: boolean): Promise<string | undefined> {
  if (options.generate?.includes(v.name)) return randomToken();
  const exported = process.env[v.name];
  if (exported !== undefined && exported !== "") {
    log.info(`  ${v.name}: taken from the environment`);
    return exported;
  }
  // Optional variables (a provider's API key) are asked for in the model step, not one by one.
  if (!interactive || !v.required) return undefined;
  const generable = v.secret && /_TOKEN$/.test(v.name);
  const question = `${v.name}${v.description ? ` (${v.description})` : ""}\n  ${generable ? "value, or Enter to generate one" : "value"}: `;
  const answer = v.secret ? await askSecret(question) : await ask(question);
  return answer === "" && generable ? randomToken() : answer;
}

/** Returns the providers still without credentials. */
async function configureModels(
  projectDir: string,
  options: ConfigureOptions,
  interactive: boolean,
  variables: EnvironmentVariable[],
): Promise<string[]> {
  const checked = await credentials(projectDir, ["check"]);
  const unconfigured = Object.entries(checked.providers).filter(([, ok]) => !ok).map(([id]) => id);
  for (const [id, ok] of Object.entries(checked.providers)) if (ok) log.info(`  model provider ${id}: has credentials`);

  if (options.login !== undefined) {
    if (!(options.login in checked.providers)) throw new CliError(`no installed component provides the model provider "${options.login}"`);
    await login(projectDir, options.login, checked.store);
    return unconfigured.filter((id) => id !== options.login);
  }
  if (!interactive) return unconfigured;

  const left: string[] = [];
  for (const id of unconfigured) {
    const keyName = apiKeyName(id);
    const hasKeyVariable = variables.some((v) => v.name === keyName);
    const choice = await ask(
      `\nThe model provider "${id}" has no credentials.\n  1) log in with your subscription (OAuth, opens a URL)\n${hasKeyVariable ? `  2) paste an API key (stored in ${ENV_FILE} as ${keyName})\n` : ""}  s) skip\nChoice: `,
    );
    if (choice === "1") await login(projectDir, id, checked.store);
    else if (choice === "2" && hasKeyVariable) {
      const key = await askSecret(`${keyName}: `);
      if (key === "") left.push(id);
      else {
        writeEnv(projectDir, new Map([[keyName, key]]));
        log.ok(`${ENV_FILE}: set ${keyName}`);
      }
    } else left.push(id);
  }
  return left;
}

async function login(projectDir: string, id: string, store: string | undefined): Promise<void> {
  const result = await runScript<CredentialsResult>("credentials.ts", projectDir, ["login", id], { interactive: true });
  if (!result.ok) throw new CliError(`login to ${id} failed: ${result.error}`);
  log.ok(`logged in to ${id}; the tokens are stored by ${store ?? "model.credentials"} (see its config in pikit.config.ts)`);
}

async function credentials(projectDir: string, args: string[]): Promise<Extract<CredentialsResult, { ok: true }>> {
  const result = await runScript<CredentialsResult>("credentials.ts", projectDir, args);
  if (!result.ok) throw new CliError(`could not read the model credentials: ${result.error}\nRun \`pikit doctor\`.`);
  return result;
}

/** pi-ai's variable for a provider's API key: `ANTHROPIC_API_KEY` for `anthropic`. */
function apiKeyName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}
