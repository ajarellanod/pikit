/**
 * What `pikit configure` asks for, decided from what it has read: the installed components'
 * records, `.env`, the process environment, the model credentials checked here and where the app
 * runs. Nothing here reads, asks or writes; `commands/configure.ts` does, by these decisions.
 */

import type { EnvironmentVariable } from "../registry/manifest.ts";
import type { Choice } from "../ui.ts";
import { ENV_FILE } from "./env-file.ts";
import { type CheckedCredentials, canLogIn, keyVariableOf } from "./model-credentials.ts";
import type { ProjectManifest } from "./pikit-json.ts";

/** Every installed component's variables, once each; required, or secret, when any component says so. */
export function declaredVariables(components: ProjectManifest["components"]): EnvironmentVariable[] {
  const byName = new Map<string, EnvironmentVariable>();
  for (const component of Object.values(components)) {
    for (const v of component.environment) {
      const seen = byName.get(v.name);
      byName.set(v.name, seen === undefined ? v : { ...seen, required: seen.required || v.required, secret: seen.secret || v.secret });
    }
  }
  return [...byName.values()];
}

/** What happens to one declared variable. */
export type VariableStep = { variable: EnvironmentVariable } & (
  | /** A component's own configure step sets it. */ { action: "owned" }
  | /** `.env` has it already. */ { action: "set" }
  | /** `--generate <NAME>`: a new random value. */ { action: "generate" }
  | /** Exported in the shell that runs `pikit configure`. */ { action: "environment"; value: string }
  | /** Asked, in a terminal; `generable`: Enter makes a random one (a required secret `*_TOKEN`). */ { action: "ask"; generable: boolean }
  | /** Required, and nothing gives it: the command fails, naming it. */ { action: "missing" }
  | /** Optional and not given: left unset (a provider's API key is asked for in the model step). */ { action: "skip" }
);

export interface VariableInput {
  /** The variables of components with their own configure step. */
  owned: ReadonlySet<string>;
  /** `.env` as it is. */
  current: ReadonlyMap<string, string>;
  /** The process environment. */
  environment: Readonly<Record<string, string | undefined>>;
  /** `--generate` names. */
  generate: readonly string[];
  /** In a terminal, without `--yes`. */
  interactive: boolean;
}

export function planVariables(variables: readonly EnvironmentVariable[], input: VariableInput): VariableStep[] {
  return variables.map((variable): VariableStep => {
    if (input.owned.has(variable.name)) return { variable, action: "owned" };
    if ((input.current.get(variable.name) ?? "") !== "") return { variable, action: "set" };
    if (input.generate.includes(variable.name)) return { variable, action: "generate" };
    const exported = input.environment[variable.name];
    if (exported !== undefined && exported !== "") return { variable, action: "environment", value: exported };
    if (!variable.required) return { variable, action: "skip" };
    if (!input.interactive) return { variable, action: "missing" };
    return { variable, action: "ask", generable: generable(variable) };
  });
}

/** A required secret `*_TOKEN` is one the project makes up (an admin's, a webhook's): Enter generates it. */
export function generable(variable: EnvironmentVariable): boolean {
  return variable.secret === true && /_TOKEN$/.test(variable.name);
}

/** How a provider without credentials can be reached: `pikit configure`'s question. */
export type ModelChoice = "up" | "key" | "dev" | "skip";

export interface ModelStep {
  id: string;
  /** Where it has credentials: this machine (`pikit dev`), only where the app runs (`pikit up`), or nowhere. */
  has: "here" | "there" | "none";
  /** For `none`, what is offered, `skip` last; empty when nothing can be (no login, no key variable): it is left. */
  choices: Choice<ModelChoice>[];
  /** The variable its API key goes in (`ANTHROPIC_API_KEY`), from its component's manifest. */
  keyName?: string;
}

export interface ModelInput {
  /** This machine's credentials, of the providers the agents name (`usedOnly`). */
  checked: CheckedCredentials;
  /** Where the app runs (`pikit up`), when the deployment could check there. */
  there: Readonly<Record<string, boolean>> | undefined;
  /** The installed components' records: a provider's key variable is its component's. */
  components: ProjectManifest["components"];
  /** The deployment can run a command where the app runs (`exec`): a login here is for `pikit dev` only. */
  exec: boolean;
}

/**
 * Per provider the agents name, where it has credentials and, when nowhere, how it can get them: a
 * login only where pi-ai has one and the project can store it (`canLogIn`), for `pikit up` when
 * the deployment checked where the app runs; an API key only in the variable its component declares.
 */
export function planModels({ checked, there, components, exec }: ModelInput): ModelStep[] {
  return Object.keys(checked.providers).map((id): ModelStep => {
    if (checked.providers[id] === true) return { id, has: "here", choices: [] };
    if (there?.[id] === true) return { id, has: "there", choices: [] };
    const login = canLogIn(checked, id);
    const keyName = keyVariableOf(components, checked, id);
    const inApp = there !== undefined;
    if (!login && keyName === undefined) return { id, has: "none", choices: [] };
    const choices: Choice<ModelChoice>[] = [
      ...(!login
        ? []
        : inApp
          ? [{ value: "up" as const, label: "Log in with your subscription, for `pikit up`", hint: "OAuth, code login: open a URL, sign in, paste the code the page shows back here" }]
          : [{ value: "dev" as const, label: `Log in with your subscription${exec ? ", for `pikit dev` only" : ""}`, hint: LOGIN_HERE }]),
      ...(keyName !== undefined ? [{ value: "key" as const, label: "Paste an API key", hint: `stored in ${ENV_FILE} as ${keyName}; \`pikit up\` and \`pikit dev\` both read it` }] : []),
      ...(login && inApp ? [{ value: "dev" as const, label: "Log in with your subscription, for `pikit dev` only", hint: `on this machine; ${LOGIN_HERE}` }] : []),
      { value: "skip", label: "Skip for now" },
    ];
    return { id, has: "none", choices, ...(keyName !== undefined && { keyName }) };
  });
}

const LOGIN_HERE = "OAuth: browser login (it comes back by itself) or code login (paste the code the page shows)";
