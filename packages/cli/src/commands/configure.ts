/**
 * `pikit configure`: what a project needs before it runs, and nothing else.
 *
 * 1. The components' own steps: a component that ships `src/pikit/<name>/configure.ts` sets up
 *    its own variables there (checking a token, discovering an id), and the CLI only calls it.
 * 2. The other variables the installed components declare (`environment` in their manifests),
 *    written to `.env` with mode 0600. A secret is asked without echo; a required `*_TOKEN` can be
 *    generated.
 * 3. Model credentials, for each model provider an agent names in its `model` that has none (an
 *    installed provider no agent uses is skipped, and so is the deployment when nothing is missing
 *    here): a login through pi-ai's
 *    own flow, stored by the project's `model.credentials` component (`credentials-file`), or an
 *    API key in `.env`. The login runs where the app will run: through the deployment's `exec` for
 *    `pikit up` (in Docker, its volume), or on this machine for `pikit dev`. Each place keeps its
 *    own copy; nothing is copied between them. A project with no `model.credentials`
 *    component (on Cloudflare) has nowhere to keep a login: it is offered the API key only.
 *
 * Without a terminal (or with `--yes`) it asks nothing: a variable comes from the process
 * environment or from `--generate <NAME>`, and a missing required one fails the command. It never
 * prints a value, and never reads or writes Pi's own `~/.pi/agent/auth.json`.
 */

import type { EnvironmentVariable } from "../registry/manifest.ts";
import { type ComponentConfigureResult, componentsWithSteps } from "../project/component-configure.ts";
import { type AppExec, deploymentExec } from "../project/deployment-module.ts";
import { ENV_FILE, readEnv, writeEnv } from "../project/env-file.ts";
import type { CredentialsResult } from "../project/credentials.ts";
import { apiKeyName, checkModelCredentials, providersInUse } from "../project/model-credentials.ts";
import { readProjectManifest } from "../project/pikit-json.ts";
import { runScript, runScriptInApp } from "../project/run.ts";
import { ask, askSecret, beginGuided, Cancelled, CliError, choose, isInteractive, log } from "../ui.ts";

export interface ConfigureOptions {
  /** Ask nothing, as without a terminal. */
  yes?: boolean;
  /** Variables to fill with a new random value (32 bytes, hex). */
  generate?: string[];
  /**
   * Run this provider's OAuth login (in a terminal: it prints a URL to open). It logs in where the app
   * runs for `pikit up` when the deployment can run a command there (`exec`), else on this machine.
   * Where the app runs, the login method is `code` (paste back the code the page shows); here, the
   * login asks (browser or code), or takes pi-ai's default (browser) without a terminal.
   */
  login?: string;
  /**
   * The login method, when the provider offers a choice (Anthropic): `browser` (it comes back by itself)
   * or `code` (paste the code the page shows). Without it, as above.
   */
  loginMethod?: LoginMethod;
  /** Log in on this machine, for `pikit dev`, even when the deployment could run the login. */
  local?: boolean;
}

/** The login methods `--login-method` names. */
export const LOGIN_METHODS = ["browser", "code"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

/** pi-ai's id of each method (its `select` option values). */
const PI_LOGIN_METHOD: Record<LoginMethod, string> = { browser: "browser", code: "copy_code" };

export async function configure(projectDir: string, options: ConfigureOptions = {}): Promise<void> {
  const interactive = options.yes !== true && isInteractive();
  if (interactive) beginGuided();
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
  const question = `${v.name}${v.description ? ` — ${v.description}` : ""}${generable ? " (Enter generates one)" : ""}`;
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
  const used = await providersInUse(projectDir);
  const here = await checkModelCredentials(projectDir, undefined, used);
  const ids = Object.keys(here.providers);
  for (const id of here.unused) log.info(`  model provider ${id}: no agent uses it, so it needs no credentials`);
  const exec = options.local === true ? undefined : await deploymentExec(projectDir);

  if (options.login !== undefined) {
    if (!ids.includes(options.login) && !here.unused.includes(options.login)) throw new CliError(`no installed component provides the model provider "${options.login}"`);
    await login(projectDir, options.login, here.store, exec, options.loginMethod);
    return ids.filter((id) => here.providers[id] !== true && id !== options.login);
  }

  // What this machine lacks may be where the app runs: `pikit up` reads the deployment's copy.
  const lacking = ids.filter((id) => here.providers[id] !== true);
  let there: Record<string, boolean> | undefined;
  if (lacking.length > 0 && exec !== undefined) {
    log.step("checking the model credentials where the app runs (`pikit up`); the first time, its image is built (about a minute)");
    try {
      there = (await checkModelCredentials(projectDir, exec, used)).providers;
    } catch (error) {
      // The deployment's own message (Docker not running, no permission) is on the terminal, above: one line here.
      const why = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      log.warn(`the deployment could not run a command where the app runs (${why}): a login now is for \`pikit dev\` only; run \`pikit configure\` again once it can`);
    }
  }
  for (const id of ids) {
    if (here.providers[id] === true) log.info(`  model provider ${id}: has credentials`);
    else if (there?.[id] === true) log.info(`  model provider ${id}: has credentials for \`pikit up\` (for \`pikit dev\` too: \`pikit configure --login ${id} --local\`)`);
  }
  const unconfigured = lacking.filter((id) => there?.[id] !== true);
  if (!interactive) return unconfigured;

  const left: string[] = [];
  // A login is stored by `model.credentials`: without one (a Cloudflare project) it has nowhere to go.
  const canLogIn = here.store !== undefined;
  for (const id of unconfigured) {
    const keyName = apiKeyName(id);
    const hasKeyVariable = variables.some((v) => v.name === keyName);
    const inApp = there !== undefined;
    if (!canLogIn && !hasKeyVariable) {
      left.push(id);
      continue;
    }
    const choice = await choose<"up" | "key" | "dev" | "skip">(`The model provider "${id}" has no credentials. How should your agent reach it?`, [
      ...(!canLogIn
        ? []
        : inApp
          ? [{ value: "up" as const, label: "Log in with your subscription, for `pikit up`", hint: "OAuth, code login: open a URL, sign in, paste the code the page shows back here" }]
          : [{ value: "dev" as const, label: `Log in with your subscription${exec === undefined ? "" : ", for `pikit dev` only"}`, hint: LOGIN_HERE }]),
      ...(hasKeyVariable ? [{ value: "key" as const, label: "Paste an API key", hint: `stored in ${ENV_FILE} as ${keyName}; \`pikit up\` and \`pikit dev\` both read it` }] : []),
      ...(canLogIn && inApp ? [{ value: "dev" as const, label: "Log in with your subscription, for `pikit dev` only", hint: `on this machine; ${LOGIN_HERE}` }] : []),
      { value: "skip", label: "Skip for now" },
    ]);
    if (choice === "up") await login(projectDir, id, here.store, exec);
    else if (choice === "dev") await login(projectDir, id, here.store, undefined);
    else if (choice === "key") {
      const key = await askSecret(keyName);
      if (key === "") left.push(id);
      else {
        writeEnv(projectDir, new Map([[keyName, key]]));
        log.ok(`${ENV_FILE}: set ${keyName}`);
      }
    } else left.push(id);
  }
  return left;
}

const LOGIN_HERE = "OAuth: browser login (it comes back by itself) or code login (paste the code the page shows)";

/**
 * Where the app runs, a choice of login method (Anthropic's: browser or code) is answered with
 * `code`: the app's container publishes no port, so the browser cannot come back to the login's
 * callback. On this machine, the login asks.
 */
const IN_APP_LOGIN_METHOD: LoginMethod = "code";

/**
 * Logs in where the app will run: through the deployment's `exec` for `pikit up`, else here.
 * `credentials.ts` runs pi-ai's flow and stores the tokens with the project's `model.credentials`.
 */
async function login(projectDir: string, id: string, store: string | undefined, exec: AppExec | undefined, method?: LoginMethod): Promise<void> {
  if (exec !== undefined) log.step(`logging in to ${id} where the app runs (\`pikit up\`); the first time, its image is built`);
  const chosen = method ?? (exec === undefined ? undefined : IN_APP_LOGIN_METHOD);
  const args = ["login", id, ...(chosen === undefined ? [] : [PI_LOGIN_METHOD[chosen]])];
  const result =
    exec === undefined
      ? await runScript<CredentialsResult>("credentials.ts", projectDir, args, { interactive: true })
      : await runScriptInApp<CredentialsResult>(exec, "credentials.ts", args, { interactive: true });
  if (!result.ok) throw new CliError(`login to ${id} failed: ${result.error}`);
  const where = exec === undefined ? "on this machine, for `pikit dev`" : "where the app runs, for `pikit up`";
  log.ok(`logged in to ${id} ${where}; the tokens are stored by ${store ?? "model.credentials"} (see its config in pikit.config.ts)`);
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}
