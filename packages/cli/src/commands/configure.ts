/**
 * `pikit configure`: what a project needs before it runs, and nothing else.
 *
 * 1. The components' own steps: a component that ships `src/pikit/<name>/configure.ts` sets up
 *    its own variables there (checking a token, discovering an id), and the CLI only calls it.
 * 2. The other variables the installed components declare (`environment` in their manifests),
 *    written to `.env` with mode 0600. A secret is asked without echo; a required `*_TOKEN` can be
 *    generated.
 * 3. Model credentials, for each installed model provider that has none: a login through pi-ai's
 *    own flow, stored by the project's `model.credentials` component (`credentials-file`), or an
 *    API key in `.env`. The login runs where the app will run: through the deployment's `exec` for
 *    `pikit up` (in Docker, its volume), or on this machine for `pikit dev`. Each place keeps its
 *    own copy; nothing is copied between them (SPEC §11).
 *
 * Without a terminal (or with `--yes`) it asks nothing: a variable comes from the process
 * environment or from `--generate <NAME>`, and a missing required one fails the command. It never
 * prints a value, and never reads or writes Pi's own `~/.pi/agent/auth.json` (SPEC §13).
 */

import type { EnvironmentVariable } from "../registry/manifest.ts";
import { type ComponentConfigureResult, componentsWithSteps } from "../project/component-configure.ts";
import { type AppExec, deploymentExec } from "../project/deployment-module.ts";
import { ENV_FILE, readEnv, writeEnv } from "../project/env-file.ts";
import { apiKeyName, checkModelCredentials, loginModel } from "../project/model-credentials.ts";
import { readProjectManifest } from "../project/pikit-json.ts";
import { runScript } from "../project/run.ts";
import { ask, askSecret, Cancelled, CliError, isInteractive, log } from "../ui.ts";

export interface ConfigureOptions {
  /** Ask nothing, as without a terminal. */
  yes?: boolean;
  /** Variables to fill with a new random value (32 bytes, hex). */
  generate?: string[];
  /**
   * Run this provider's OAuth login (in a terminal: it prints a URL to open). It logs in where the app
   * runs for `pikit up` when the deployment can run a command there (`exec`), else on this machine.
   */
  login?: string;
  /** Log in on this machine, for `pikit dev`, even when the deployment could run the login. */
  local?: boolean;
}

export async function configure(projectDir: string, options: ConfigureOptions = {}): Promise<void> {
  const interactive = options.yes !== true && isInteractive();
  const variables = declaredVariables(projectDir);
  const stepMissing = await componentSteps(projectDir, interactive);
  // A component with a step of its own owns its variables: they are not asked for again here.
  const owned = new Set(componentsWithSteps(projectDir).flatMap((name) => readProjectManifest(projectDir).components[name]?.environment.map((v) => v.name) ?? []));
  const current = readEnv(projectDir);
  const updates = new Map<string, string>();
  const missing: string[] = [];

  for (const v of variables) {
    if (owned.has(v.name)) continue;
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
    ...stepMissing,
    ...missing.map((name) => `${name} is required and not set: export it, pass --generate ${name}, or run \`pikit configure\` in a terminal`),
    ...unconfigured.map((id) => `the model provider "${id}" has no credentials: run \`pikit configure --login ${id}\` in a terminal, or set its API key (e.g. ${apiKeyName(id)})`),
  ];
  for (const problem of problems) log.problem(problem);
  if (problems.length > 0) throw new CliError(`pikit configure: ${problems.length} thing(s) left to configure`);
  log.ok("configured");
}

/** Runs the components' own steps (`component-configure.ts`); returns what they could not set. */
async function componentSteps(projectDir: string, interactive: boolean): Promise<string[]> {
  if (componentsWithSteps(projectDir).length === 0) return [];
  const result = await runScript<ComponentConfigureResult>("component-configure.ts", projectDir, [interactive ? "interactive" : "batch"], { interactive: true });
  if (!result.ok && result.cancelled === true) throw new Cancelled("cancelled");
  if (!result.ok) throw new CliError(`a component's configure step failed: ${result.error}`);
  return result.missing;
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
  const here = await checkModelCredentials(projectDir);
  const ids = Object.keys(here.providers);
  const exec = options.local === true ? undefined : await deploymentExec(projectDir);

  if (options.login !== undefined) {
    if (!ids.includes(options.login)) throw new CliError(`no installed component provides the model provider "${options.login}"`);
    await login(projectDir, options.login, here.store, exec);
    return ids.filter((id) => here.providers[id] !== true && id !== options.login);
  }

  // What this machine lacks may be where the app runs: `pikit up` reads the deployment's copy.
  const lacking = ids.filter((id) => here.providers[id] !== true);
  let there: Record<string, boolean> | undefined;
  if (lacking.length > 0 && exec !== undefined) {
    log.step("checking the model credentials where the app runs (`pikit up`)");
    try {
      there = (await checkModelCredentials(projectDir, exec)).providers;
    } catch (error) {
      // Docker's own message (not running, no permission) is already on the terminal, above.
      log.warn(
        `could not run a command where the app runs (${error instanceof Error ? error.message : String(error)}). A login now would be for \`pikit dev\` only; to log in for \`pikit up\`, fix what the deployment reported above and run \`pikit configure\` again`,
      );
    }
  }
  for (const id of ids) {
    if (here.providers[id] === true) log.info(`  model provider ${id}: has credentials`);
    else if (there?.[id] === true) log.info(`  model provider ${id}: has credentials for \`pikit up\` (for \`pikit dev\` too: \`pikit configure --login ${id} --local\`)`);
  }
  const unconfigured = lacking.filter((id) => there?.[id] !== true);
  if (!interactive) return unconfigured;

  const left: string[] = [];
  for (const id of unconfigured) {
    const keyName = apiKeyName(id);
    const hasKeyVariable = variables.some((v) => v.name === keyName);
    const inApp = there !== undefined;
    const choice = await ask(
      [
        `\nThe model provider "${id}" has no credentials.`,
        inApp
          ? "  1) log in with your subscription, for `pikit up` (OAuth: open a URL, then paste the page's address back here)"
          : `  1) log in with your subscription (OAuth, opens a URL)${exec === undefined ? "" : ", for `pikit dev` only"}`,
        ...(hasKeyVariable ? [`  2) paste an API key (stored in ${ENV_FILE} as ${keyName}; \`pikit up\` and \`pikit dev\` both read it)`] : []),
        ...(inApp ? ["  3) log in with your subscription, for `pikit dev` only (on this machine)"] : []),
        "  s) skip",
        "Choice: ",
      ].join("\n"),
    );
    if (choice === "1") await login(projectDir, id, here.store, inApp ? exec : undefined);
    else if (choice === "3" && inApp) await login(projectDir, id, here.store, undefined);
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

/** Logs in where the app will run: through the deployment's `exec` for `pikit up`, else here. */
async function login(projectDir: string, id: string, store: string | undefined, exec: AppExec | undefined): Promise<void> {
  if (exec !== undefined) log.step(`logging in to ${id} where the app runs (\`pikit up\`); the first time, its image is built`);
  await loginModel(projectDir, id, exec);
  const where = exec === undefined ? "on this machine, for `pikit dev`" : "where the app runs, for `pikit up`";
  log.ok(`logged in to ${id} ${where}; the tokens are stored by ${store ?? "model.credentials"} (see its config in pikit.config.ts)`);
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}
