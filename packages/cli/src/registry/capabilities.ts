/**
 * The capability catalogue: what each capability name means, for `pikit registry capabilities` and
 * for `registry validate`.
 *
 * A capability's contract (its TypeScript type) lives with the package that defines it, by
 * declaration merging on `AppCapabilities` / `AppKeyedCapabilities`. This file adds only what a
 * reader of the registry needs and the types cannot say: one line on what it is for, and where its
 * contract is. The two cannot drift:
 * - The catalogue's type is mapped over both interfaces, so a capability defined without an entry,
 *   an entry for a capability that no longer exists, or the wrong mode fails `tsc`.
 * - `registry validate` rejects a component that provides or uses a capability with no entry here.
 *
 * The Pi-owned capabilities (`sessions.store`, `execution`…) are declared by `@pikit/pi-adapter`,
 * which the repository's single type-check program includes. It is deliberately not imported here:
 * importing it through the CLI's `node_modules` gives tsc a second path to `@pikit/core` and breaks
 * core's own tests. Were the adapter ever left out of the program, its entries below would fail
 * `tsc` as unknown properties, so the catalogue cannot silently lose them.
 */

import type { AppCapabilities, AppKeyedCapabilities, CapabilityMode } from "@pikit/core";
import type { Manifest } from "./manifest.ts";

export interface CapabilityEntry<Mode extends CapabilityMode = CapabilityMode> {
  mode: Mode;
  /** The package whose declaration merging defines the contract. */
  definedIn: "@pikit/core" | "@pikit/pi-adapter";
  /** One line: what a consumer gets from it. */
  summary: string;
}

/**
 * The repository type-checks as one program, so the capabilities tests declare for themselves
 * (`test.store` in core's `app.test.ts`) merge into the same interfaces. They are not contracts:
 * the `test.` prefix keeps them out of the catalogue.
 */
type Real<K> = Exclude<K & string, `test.${string}`>;

type Catalogue = { [K in Real<keyof AppCapabilities>]: CapabilityEntry<"single"> } & {
  [K in Real<keyof AppKeyedCapabilities>]: CapabilityEntry<"keyed">;
};

export const CAPABILITIES: Catalogue = {
  "agent.runtime": {
    mode: "single",
    definedIn: "@pikit/core",
    summary: "Runs the agents: dispatch a message to its conversation, abort or resume a run.",
  },
  "conversations.registry": {
    mode: "single",
    definedIn: "@pikit/core",
    summary: "Which session each conversation (channel:conversationId) is in now; resolve and reset.",
  },
  secrets: {
    mode: "single",
    definedIn: "@pikit/core",
    summary: "The only way a component reads a secret (environment, Worker bindings, a vault).",
  },
  "sessions.store": {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    summary: "Pi's SessionRepo: where each conversation's session (its transcript and state) is stored.",
  },
  "model.credentials": {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    summary: "pi-ai's CredentialStore: the model providers' credentials; without it, only their env variables.",
  },
  execution: {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    summary: "Pi's ExecutionEnv: the filesystem the agent's file tools work on.",
  },
  "execution.shell": {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    summary: "The same ExecutionEnv, provided only when it really runs commands; shell tools require it.",
  },
  "agent.definition": {
    mode: "keyed",
    definedIn: "@pikit/core",
    summary: "One agent per name (model, prompt, tools); provided by the project, not the registry.",
  },
  "agent.tool": {
    mode: "keyed",
    definedIn: "@pikit/core",
    summary: "One tool per name the model calls it by; an agent gets only the tools it names.",
  },
  "http.route": {
    mode: "keyed",
    definedIn: "@pikit/core",
    summary: 'One HTTP endpoint per "METHOD /path", as a fetch handler; one server component serves them all.',
  },
  "model.provider": {
    mode: "keyed",
    definedIn: "@pikit/pi-adapter",
    summary: "One pi-ai model provider per id (anthropic…); agents name its models as provider/modelId.",
  },
};

/** The catalogue entry for `name`, or `undefined` when the name is not a known capability. */
export function capabilityEntry(name: string): CapabilityEntry | undefined {
  return Object.hasOwn(CAPABILITIES, name) ? (CAPABILITIES as Record<string, CapabilityEntry>)[name] : undefined;
}

/** One capability as the registry sees it: its entry, and which components provide and use it. */
export interface CapabilityUsage {
  name: string;
  /** `undefined`: a component uses a name the catalogue does not know (`registry validate` rejects it). */
  entry: CapabilityEntry | undefined;
  providers: string[];
  /** `optional`: `useOptional()` / `useKeyed()`, which install fine with no provider. */
  consumers: { name: string; optional: boolean }[];
}

/**
 * Every catalogued capability, plus any unknown one the manifests name, sorted by name. The
 * manifests' `provides` / `requires` / `optional` are generated from setup, so this is what the
 * components really do.
 */
export function capabilityUsage(manifests: readonly Manifest[]): CapabilityUsage[] {
  const usage = new Map<string, CapabilityUsage>();
  const of = (name: string): CapabilityUsage => {
    let entry = usage.get(name);
    if (entry === undefined) {
      entry = { name, entry: capabilityEntry(name), providers: [], consumers: [] };
      usage.set(name, entry);
    }
    return entry;
  };
  for (const name of Object.keys(CAPABILITIES)) of(name);
  for (const m of [...manifests].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const name of m.provides ?? []) of(name).providers.push(m.name);
    for (const name of m.requires?.capabilities ?? []) of(name).consumers.push({ name: m.name, optional: false });
    for (const name of m.optional?.capabilities ?? []) of(name).consumers.push({ name: m.name, optional: true });
  }
  return [...usage.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The catalogue as text: one block per capability. */
export function formatCapabilities(usage: readonly CapabilityUsage[]): string {
  const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "none in the registry");
  return usage
    .map(({ name, entry, providers, consumers }) => {
      const head = entry ? `${name}  (${entry.mode}, ${entry.definedIn})` : `${name}  (not in the catalogue)`;
      const users = consumers.map((c) => (c.optional ? `${c.name} (optional)` : c.name));
      return [
        head,
        ...(entry ? [`  ${entry.summary}`] : []),
        `  provided by: ${list(providers)}`,
        `  used by:     ${list(users)}`,
      ].join("\n");
    })
    .join("\n\n");
}
