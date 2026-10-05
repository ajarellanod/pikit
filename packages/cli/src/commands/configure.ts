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
 *    own flow, stored by the project's `model.credentials` component (`credentials-file`), offered
 *    only for a provider that has one (pi-ai's `provider.auth.oauth`), or an API key in `.env`, in the
 *    variable the provider's component declares (its manifest's first secret `environment` entry). The login runs where the app will run: through the deployment's `exec` for
 *    `pikit up` (in Docker, its volume), or on this machine for `pikit dev`. Each place keeps its
 *    own copy; nothing is copied between them. A project with no `model.credentials`
 *    component (on Cloudflare) has nowhere to keep a login: it is offered the API key only.
 *
 * Without a terminal (or with `--yes`) it asks nothing: a variable comes from the process
 * environment or from `--generate <NAME>`, and a missing required one fails the command. It never
 * prints a value, and never reads or writes Pi's own `~/.pi/agent/auth.json`.
 */

import { type ComponentConfigureResult, componentsWithSteps } from "../project/component-configure.ts";
import { declaredVariables, planModels, planVariables } from "../project/configure-plan.ts";
import { type AppExec, deploymentExec } from "../project/deployment-module.ts";
import { ENV_FILE, readEnv, writeEnv } from "../project/env-file.ts";
import type { CredentialsResult } from "../project/credentials.ts";
import { apiKeyHint, canLogIn, type CheckedCredentials, checkModelCredentials, providersInUse } from "../project/model-credentials.ts";
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
  const stepMissing = await componentSteps(projectDir, interactive);
  const { components } = readProjectManifest(projectDir);
  // A component with a step of its own owns its variables: they are not asked for again here.
  const owned = new Set(componentsWithSteps(projectDir).flatMap((name) => components[name]?.environment.map((v) => v.name) ?? []));
  const steps = planVariables(declaredVariables(components), {
    owned,
    current: readEnv(projectDir),
    environment: process.env,
    generate: options.generate ?? [],
    interactive,
  });
  const updates = new Map<string, string>();
  const missing: string[] = [];

  for (const step of steps) {
    const { name, description, secret } = step.variable;
    let value: string | undefined;
    if (step.action === "set") log.info(`  ${name}: already set`);
    else if (step.action === "generate") value = randomToken();
    else if (step.action === "environment") {
      log.info(`  ${name}: taken from the environment`);
      value = step.value;
    } else if (step.action === "ask") {
      const question = `${name}${description ? ` — ${description}` : ""}${step.generable ? " (Enter generates one)" : ""}`;
      const answer = secret ? await askSecret(question) : await ask(question);
      value = answer === "" && step.generable ? randomToken() : answer;
      if (value === "") missing.push(name);
    } else if (step.action === "missing") missing.push(name);
    if (value !== undefined && value !== "") updates.set(name, value);
  }
  if (updates.size > 0) {
    writeEnv(projectDir, updates);
    log.ok(`${ENV_FILE} (mode 0600): set ${[...updates.keys()].join(", ")}`);
  }

  const models = await configureModels(projectDir, options, interactive);

  const problems = [
    ...stepMissing,
    ...missing.map((name) => `${name} is required and not set: export it, pass --generate ${name}, or run \`pikit configure\` in a terminal`),
    ...models.left.map((id) => {
      const login = canLogIn(models.checked, id) ? `run \`pikit configure --login ${id}\` in a terminal, or ` : "";
      return `the model provider "${id}" has no credentials: ${login}${apiKeyHint(projectDir, models.checked, id)}`;
    }),
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

/** Returns the providers still without credentials, and what was checked on this machine. */
async function configureModels(projectDir: string, options: ConfigureOptions, interactive: boolean): Promise<{ left: string[]; checked: CheckedCredentials }> {
  const used = await providersInUse(projectDir);
  const here = await checkModelCredentials(projectDir, undefined, used);
  const ids = Object.keys(here.providers);
  for (const id of here.unused) log.info(`  model provider ${id}: no agent uses it, so it needs no credentials`);
  const exec = options.local === true ? undefined : await deploymentExec(projectDir);

  if (options.login !== undefined) {
    if (!ids.includes(options.login) && !here.unused.includes(options.login)) throw new CliError(`no installed component provides the model provider "${options.login}"`);
    if (!here.oauth.includes(options.login)) throw new CliError(`the model provider "${options.login}" has no login: it takes an API key (${apiKeyHint(projectDir, here, options.login)})`);
    if (!canLogIn(here, options.login)) throw new CliError(`the model provider "${options.login}" has no model.credentials component to store a login: ${apiKeyHint(projectDir, here, options.login)}`);
    await login(projectDir, options.login, here.store, exec, options.loginMethod);
    return { left: ids.filter((id) => here.providers[id] !== true && id !== options.login), checked: here };
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
  const plan = planModels({ checked: here, there, components: readProjectManifest(projectDir).components, exec: exec !== undefined });
  for (const { id, has } of plan) {
    if (has === "here") log.info(`  model provider ${id}: has credentials`);
    else if (has === "there") log.info(`  model provider ${id}: has credentials for \`pikit up\` (for \`pikit dev\` too: \`pikit configure --login ${id} --local\`)`);
  }
  const unconfigured = plan.filter((step) => step.has === "none");
  if (!interactive) return { left: unconfigured.map((step) => step.id), checked: here };

  const left: string[] = [];
  for (const { id, choices, keyName } of unconfigured) {
    if (choices.length === 0) {
      left.push(id);
      continue;
    }
    const choice = await choose(`The model provider "${id}" has no credentials. How should your agent reach it?`, choices);
    if (choice === "up") await login(projectDir, id, here.store, exec);
    else if (choice === "dev") await login(projectDir, id, here.store, undefined);
    else if (choice === "key" && keyName !== undefined) {
      const key = await askSecret(keyName);
      if (key === "") left.push(id);
      else {
        writeEnv(projectDir, new Map([[keyName, key]]));
        log.ok(`${ENV_FILE}: set ${keyName}`);
      }
    } else left.push(id);
  }
  return { left, checked: here };
}

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
