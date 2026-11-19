/**
 * `actor.kind` (SPEC §4.1, C9): the actor keys a component owns, so that on the `durable` target an
 * object of one of them runs that kind's App (its owners and what they use) instead of the whole
 * default export. Keyed, provided under the declaring component's own name:
 *
 *   pikit.provideKeyed("actor.kind", "credentials-do", { keys: ["credentials-do"] });
 *   pikit.provideKeyed("actor.kind", "memory-sql", { prefixes: ["memory:"] });
 *
 * A declaration is a value, never a loaded part: nothing in an App uses it. Its readers are the
 * deployment's host (deployment-cloudflare's object host, which composes an object's App from its
 * key) and `pikit doctor`, each over the whole App's `describe()` (K13) with the functions below, so
 * the two cannot disagree. On a server nothing reads it: one process is every key's actor.
 *
 * - **Matching** (`actorKindOf`): a key one declaration names exactly wins over any prefix, the longest
 *   prefix over shorter ones. Components that declare the same pattern own it together: each declares
 *   it for itself, and neither names the other. A key that matches nothing (a conversation's, or any
 *   actor's whose component declared nothing) runs the whole App, as before this contract.
 * - **Refused** (`actorKindProblems`): a declaration under a key that is not its provider's name, an
 *   empty kind, keys or prefixes that are not a list of strings, an empty pattern, a pattern of the
 *   host's own (`pikit:`: `pikit:health`). The host fails every object's start on a problem, so
 *   `/health` fails and the deploy is rolled back (C8).
 * - **A kind's App** (`actorComposition`) is the closure of its owners over the capability graph:
 *   the owners, the providers of `actor.inbox` and `wakeups` (the object's RPC and its alarm), and,
 *   for every capability an included component uses (`requires`, `optional`, keyed), the selected
 *   provider of a single one when it is installed and every provider of a keyed one; and, for a single
 *   capability an included component provides among several, its selected provider, so
 *   `config.capabilities` stays valid. Events and pipeline stages are not followed (K3: they are not
 *   in the graph). So the rule every owner keeps: **an actor kind's handlers depend only on the
 *   capabilities its components use; never on another component's listener or pipeline stage running
 *   in its object.**
 * - **What runs** (`actorKindOptions`): the subset of the project's own components the closure names,
 *   in their list order (the kernel orders them as any App: every provider before its consumers), with
 *   the project's config reduced to those components and to the selections whose provider is
 *   included. Never a component of the host's.
 *
 * A component that answers calls or messages on a kind's keys owns them: it declares the same
 * pattern, or in a kind's object its calls find no handler (`no_handler`). `createActorKindConformance`
 * (`@pikit/contracts/testing`) checks a kind's object against the whole App's, on the same calls.
 */

import type { AppDescription, ComponentDefinition } from "@pikit/core";

/**
 * The actor keys a component owns: an object of one of them runs this component and what it uses,
 * not the whole App (SPEC C9). Provided under the component's own name.
 */
export interface ActorKind {
  /** Keys it answers, exactly: `["credentials-do"]`. */
  readonly keys?: readonly string[];
  /** Key prefixes: every key that starts with one, `["memory:"]`. */
  readonly prefixes?: readonly string[];
}

declare module "@pikit/core" {
  interface AppKeyedCapabilities {
    "actor.kind": ActorKind;
  }
}

const ACTOR_KIND = "actor.kind";

/** The prefix of the deployment host's own keys (`pikit:health`): never a kind's. */
const HOST_KEY_PREFIX = "pikit:";

export interface ActorKindDeclaration extends ActorKind {
  /** The capability's key: the component that declares the kind. */
  readonly component: string;
  /** The component that provided it, as `describe()` says: `component` itself, or a problem. */
  readonly provider: string;
}

export interface ActorKindMatch {
  /** The pattern that matched: the key itself, or the longest prefix. */
  readonly pattern: string;
  readonly exact: boolean;
  /** Every component that declares that pattern, in the App's start order. */
  readonly owners: readonly string[];
}

/** What `actorKindDeclarations` reads the declarations from: the `useKeyed("actor.kind")` handle. */
export interface ActorKindReader {
  keys(): string[];
  get(key: string): ActorKind | undefined;
}

/**
 * Every `actor.kind` declaration of an App, in its start order: `kinds` is a `useKeyed("actor.kind")`
 * handle of a component in that App (read once the App is created: no start needed), `description`
 * its `describe()`.
 */
export function actorKindDeclarations(description: AppDescription, kinds: ActorKindReader): ActorKindDeclaration[] {
  const providers = description.capabilities[ACTOR_KIND]?.keys ?? {};
  const order = new Map(description.components.map((c, i) => [c.name, i]));
  const rank = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER;
  return kinds
    .keys()
    .map((component): ActorKindDeclaration => {
      const kind = kinds.get(component) ?? {};
      return {
        component,
        provider: providers[component] ?? component,
        ...(kind.keys !== undefined && { keys: kind.keys }),
        ...(kind.prefixes !== undefined && { prefixes: kind.prefixes }),
      };
    })
    .sort((a, b) => rank(a.provider) - rank(b.provider));
}

/** What is wrong with a set of declarations, one line each, never a secret. Empty when nothing is. */
export function actorKindProblems(declarations: readonly ActorKindDeclaration[]): string[] {
  const problems: string[] = [];
  for (const declaration of declarations) {
    const { component, provider } = declaration;
    const report = (problem: string) => problems.push(`actor.kind "${component}": ${problem}`);
    if (component !== provider) report(`provided by "${provider}": a component declares its kinds under its own name (provideKeyed("actor.kind", "${provider}", …))`);
    let patterns = 0;
    for (const field of ["keys", "prefixes"] as const) {
      const list = declaration[field] as unknown;
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) {
        report(`its ${field} are not a list of strings`);
        continue;
      }
      for (const pattern of list as string[]) {
        patterns++;
        if (pattern === "") report(`declares an empty ${field === "keys" ? "key" : "prefix"}`);
        else if (pattern.startsWith(HOST_KEY_PREFIX)) report(`declares "${pattern}": keys that start with "${HOST_KEY_PREFIX}" are the deployment host's own`);
      }
    }
    if (patterns === 0) report("declares no key and no prefix");
  }
  return problems;
}

/** The kind `key` belongs to, or `undefined`: the whole App (always for the host's own keys, `pikit:…`). */
export function actorKindOf(declarations: readonly ActorKindDeclaration[], key: string): ActorKindMatch | undefined {
  if (key.startsWith(HOST_KEY_PREFIX)) return undefined;
  const exact = declarations.filter((d) => listOf(d.keys).includes(key));
  if (exact.length > 0) return { pattern: key, exact: true, owners: exact.map((d) => d.component) };
  let longest: string | undefined;
  for (const d of declarations) {
    for (const prefix of listOf(d.prefixes)) {
      if (prefix !== "" && key.startsWith(prefix) && (longest === undefined || prefix.length > longest.length)) longest = prefix;
    }
  }
  if (longest === undefined) return undefined;
  const pattern = longest;
  return { pattern, exact: false, owners: declarations.filter((d) => listOf(d.prefixes).includes(pattern)).map((d) => d.component) };
}

/** Every kind the declarations make, one per pattern: exact keys first, then prefixes, each in first-declared order. */
export function actorKinds(declarations: readonly ActorKindDeclaration[]): ActorKindMatch[] {
  const kinds: ActorKindMatch[] = [];
  const seen = new Set<string>();
  for (const exact of [true, false]) {
    for (const d of declarations) {
      for (const pattern of listOf(exact ? d.keys : d.prefixes)) {
        const id = `${exact ? "key" : "prefix"}:${pattern}`;
        if (pattern === "" || seen.has(id)) continue;
        seen.add(id);
        const owners = declarations.filter((o) => listOf(exact ? o.keys : o.prefixes).includes(pattern)).map((o) => o.component);
        kinds.push({ pattern, exact, owners });
      }
    }
  }
  return kinds;
}

/** The capabilities every kind's App holds the providers of: the object's RPC and its alarm. */
const ALWAYS = ["actor.inbox", "wakeups"] as const;

/**
 * The components of a kind's App, by name, in `description`'s start order: the owners, the providers
 * of `actor.inbox` and `wakeups` (the object's RPC and alarm), and, transitively, for every
 * capability an included component uses (`requires`, `optional`, keyed): the selected provider of a
 * single one when it is installed, every provider of a keyed one; and the selected provider of a
 * single capability an included component provides among several. Throws when an owner is not a
 * component of `description`.
 */
export function actorComposition(description: AppDescription, owners: readonly string[]): readonly string[] {
  const byName = new Map(description.components.map((c) => [c.name, c]));
  for (const owner of owners) {
    if (!byName.has(owner)) throw new Error(`actorComposition: "${owner}" is not a component of this App`);
  }
  /** The components a use of `capability` reaches: none (absent, ambiguous), every provider (keyed), or the selected one. */
  const reached = (capability: string): readonly string[] => {
    const entry = description.capabilities[capability];
    if (entry === undefined) return [];
    if (entry.keys !== undefined) return entry.providers;
    return entry.selected !== undefined ? [entry.selected] : [];
  };
  const included = new Set<string>();
  const visit = (name: string): void => {
    if (included.has(name)) return;
    const component = byName.get(name);
    if (component === undefined) return;
    included.add(name);
    for (const capability of [...component.requires, ...component.optional]) for (const provider of reached(capability)) visit(provider);
    for (const capability of component.provides) {
      const entry = description.capabilities[capability];
      if (entry !== undefined && entry.keys === undefined && entry.providers.length > 1 && entry.selected !== undefined) visit(entry.selected);
    }
  };
  for (const owner of owners) visit(owner);
  for (const capability of ALWAYS) for (const provider of reached(capability)) visit(provider);
  return description.components.filter((c) => included.has(c.name)).map((c) => c.name);
}

/**
 * What a kind's App is made of, for `defineApp`: the subset of `definition`'s components that
 * `names` lists, in `definition`'s list order, and its config reduced to those components' entries
 * and to the `capabilities` selections whose provider is among them. Add the host's target, logger
 * and clock. Throws when `names` lists a component `definition` does not have.
 */
export function actorKindOptions(
  definition: { readonly components: readonly ComponentDefinition[]; readonly config: Readonly<Record<string, unknown>> },
  names: readonly string[],
): { components: ComponentDefinition[]; config: Record<string, unknown> } {
  const wanted = new Set(names);
  const components = definition.components.filter((c) => wanted.has(c.name));
  if (components.length !== wanted.size) {
    const missing = names.filter((name) => !definition.components.some((c) => c.name === name));
    throw new Error(`actorKindOptions: ${missing.map((n) => `"${n}"`).join(", ")} not among the App's components`);
  }
  const config: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(definition.config)) {
    if (name === "capabilities") {
      const selections = Object.entries((value ?? {}) as Record<string, string>).filter(([, chosen]) => wanted.has(chosen));
      if (selections.length > 0) config.capabilities = Object.fromEntries(selections);
    } else if (wanted.has(name)) {
      config[name] = value;
    }
  }
  return { components, config };
}

function listOf(list: readonly string[] | undefined): readonly string[] {
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
}
