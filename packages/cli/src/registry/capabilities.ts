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
 * Each entry also says how settled its contract is (the contracts version on their own schedule,
 * SPEC K8). A contract is `experimental` until two independent providers in this registry pass its
 * suite; only then may it be `stable` (`checkStability`, run by this repository's tests on its own
 * registry). The kernel defines no capability: every contract is in `@pikit/contracts`, or in
 * `@pikit/pi-adapter` when its type is Pi's.
 *
 * The Pi-owned capabilities (`execution`, `model.credentials`…) are declared by `@pikit/pi-adapter`,
 * which the repository's single type-check program includes. It is deliberately not imported here:
 * importing it through the CLI's `node_modules` gives tsc a second path to `@pikit/core` and breaks
 * core's own tests. Were the adapter ever left out of the program, its entries below would fail
 * `tsc` as unknown properties, so the catalogue cannot silently lose them.
 */

import type { AppCapabilities, AppKeyedCapabilities, CapabilityMode } from "@pikit/core";
import type { Manifest } from "./manifest.ts";

/**
 * How settled a contract is. `experimental`: it may still change with any release.
 * `stable`: it changes only additively, and a breaking change needs a [decision] and a major of its
 * package. A contract becomes stable once two independent providers pass its suite, or, for one the
 * project provides, by a [decision].
 */
export type Stability = "experimental" | "stable";

export interface CapabilityEntry<Mode extends CapabilityMode = CapabilityMode> {
  mode: Mode;
  /** The package whose declaration merging defines the contract. */
  definedIn: "@pikit/contracts" | "@pikit/pi-adapter";
  stability: Stability;
  /** Provided by the project itself (its agents), never by a registry component. */
  providedBy?: "project";
  /** One line: what a consumer gets from it. */
  summary: string;
  /**
   * Transitional: the contract is expected to be bridged or deleted, not to settle. One line: what
   * replaces it and when, so a component author knows before depending on it.
   */
  transitional?: string;
  /**
   * Offered: when a component that can use it (`useOptional`) or requires it (`use`) is added and
   * nothing provides it, `pikit add` and `pikit new` offer its provider (`project/offers.ts`).
   * For a capability with one obvious provider that changes nothing else; not for a choice like a
   * per-agent workspace.
   */
  offer?: true;
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
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Runs the agents: dispatch a message to its conversation, abort or resume a run.",
  },
  "agent.conversations": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Where the agent runtime keeps conversations: creates a new one, for the conversation registry (a first message, a reset).",
  },
  "agent.submissions": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "What became of each admitted message: resumes unanswered conversations at start, and feeds every run's outcome to the channels.",
    transitional: "a bridge over pi-durable's own submissions; deleted once the channels read pi-durable directly (features/pi-durable-migration.md).",
    offer: true,
  },
  "conversations.registry": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Which runtime conversation each conversation key (channel:conversationId) is in now; resolve and reset.",
  },
  secrets: {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "The only way a component reads a secret (environment, Worker bindings, a vault).",
  },
  "outbound.queue": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Stores each answer before sending it and delivers it through the channel's transport, retrying.",
    offer: true,
  },
  "storage.sql": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "An async SQL database for records that outlive the process; each component owns its own tables.",
  },
  "storage.kv": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Small JSON values a component keeps across restarts, by key, in a namespace of its own (a cursor, a token).",
    offer: true,
  },
  "actor.mailbox": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Delivers a JSON message to the actor owning a key, wherever it runs; resolves once the actor holds it durably.",
  },
  "actor.inbox": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Where an actor registers one handler per message type it receives through actor.mailbox; a handler resolves once the message is durable.",
  },
  wakeups: {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Timers: a component registers a named handler and asks for it to run at or after a time, at least once, retried with backoff.",
  },
  "model.credentials": {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    stability: "experimental",
    summary: "pi-ai's CredentialStore: the model providers' credentials; without it, only their env variables.",
  },
  execution: {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    stability: "experimental",
    summary: "pi-durable's ExecutionEnv: the filesystem the agent's file tools work on.",
  },
  "execution.shell": {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    stability: "experimental",
    summary: "The same ExecutionEnv, provided only when it really runs commands; shell tools require it.",
  },
  workspace: {
    mode: "single",
    definedIn: "@pikit/pi-adapter",
    stability: "experimental",
    summary: "Each agent's own ExecutionEnv, resolved per tool call from its conversation; the runtime gives it to the file and shell tools when installed.",
  },
  "agent.definition": {
    mode: "keyed",
    definedIn: "@pikit/contracts",
    // The programming model (`defineAgent`, `prepare`): stable by [decision] (the former SPEC §12a).
    stability: "stable",
    providedBy: "project",
    summary: "One agent per name (model, prompt, tools); provided by the project, not the registry.",
  },
  "agent.tool": {
    mode: "keyed",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "One tool per name the model calls it by; an agent gets only the tools it names.",
  },
  "http.route": {
    mode: "keyed",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: 'One HTTP endpoint per "METHOD /path", as a fetch handler; one server component serves them all.',
  },
  "model.provider": {
    mode: "keyed",
    definedIn: "@pikit/pi-adapter",
    stability: "experimental",
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

/**
 * A `stable` contract has two providers in the registry: one implementation cannot show
 * that the contract is not shaped by it. Capabilities the project provides are promoted by decision.
 */
export function checkStability(usage: readonly CapabilityUsage[]): string[] {
  return usage
    .filter(({ entry, providers }) => entry?.stability === "stable" && entry.providedBy !== "project" && providers.length < 2)
    .map(({ name, providers }) => `${name} is stable with ${providers.length} provider(s) in the registry; a stable contract needs two`);
}

/** The catalogue as text: one block per capability. */
export function formatCapabilities(usage: readonly CapabilityUsage[]): string {
  const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "none in the registry");
  return usage
    .map(({ name, entry, providers, consumers }) => {
      const level = entry?.transitional === undefined ? entry?.stability : `${entry.stability}, transitional`;
      const head = entry ? `${name}  (${entry.mode}, ${entry.definedIn}, ${level})` : `${name}  (not in the catalogue)`;
      const users = consumers.map((c) => (c.optional ? `${c.name} (optional)` : c.name));
      return [
        head,
        ...(entry ? [`  ${entry.summary}`] : []),
        ...(entry?.transitional !== undefined ? [`  transitional: ${entry.transitional}`] : []),
        `  provided by: ${entry?.providedBy === "project" ? "the project" : list(providers)}`,
        `  used by:     ${list(users)}`,
      ].join("\n");
    })
    .join("\n\n");
}
