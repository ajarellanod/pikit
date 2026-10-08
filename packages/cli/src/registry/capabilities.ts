/**
 * The capability catalogue: what each capability name means, for `pikit registry capabilities` and
 * for `registry validate`.
 *
 * The kit's catalogue (`CAPABILITIES`, below) is the default every registry extends: a registry's own
 * contracts are declared by the components that define them, in their `component.json`
 * (`declares.capabilities`, with `declares.kinds` for a new name prefix), so a user who builds memory
 * or approvals on pikit needs no change to the CLI (`registryCatalogue`). Redeclaring the kit's is an
 * error, and so is declaring one capability two ways.
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
import { KINDS, type Manifest } from "./manifest.ts";

/**
 * How settled a contract is. `experimental`: it may still change with any release.
 * `stable`: it changes only additively, and a breaking change needs a [decision] and a major of its
 * package. A contract becomes stable once two independent providers pass its suite, or, for one the
 * project provides, by a [decision].
 */
export type Stability = "experimental" | "stable";

export interface CapabilityEntry<Mode extends CapabilityMode = CapabilityMode> {
  mode: Mode;
  /**
   * Where the contract is defined: the kit package whose declaration merging defines it
   * (`@pikit/contracts`, `@pikit/pi-adapter`), or, for one a registry declares, the component that
   * declares it.
   */
  definedIn: string;
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
    // Provided by the runtime (runtime-pi reads it from pi-durable), so never offered: the runtime is the user's choice.
    summary: "What became of each admitted message, read from the runtime: what is pending, where one request is, and the feed of every run's outcome channels deliver from.",
  },
  "agent.observe": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    // Provided by the runtime (runtime-pi reads it from pi-durable), so never offered.
    summary: "What an operator sees of the runtime, read-only: its conversations (agent, busy, cost), a transcript, a live event stream, usage.",
  },
  "agent.directory": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Agents that are data (an operator's, made in the dashboard), by name: what a runtime asks for a name no agent.definition has.",
  },
  "admin.auth": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Whether an HTTP request is an operator's: what every admin route (the dashboard's) asks before answering.",
  },
  health: {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "What is up, degraded or down: components report their own state, and /health fails when an essential one stays down.",
  },
  proposals: {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    // Where proposals live is a choice per target (proposals-local, proposals-github): never offered.
    summary: "The agent's changes to itself waiting for an operator: list, read, approve or reject them, and where the steward clones from and pushes its branches to.",
  },
  settings: {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Values an operator changes live from the dashboard, read when used: each component declares its own (a schema, defaults).",
  },
  "conversations.registry": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "Which runtime conversation each conversation key (channel:conversationId) is in now; resolve and reset.",
  },
  github: {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "The project's own repository on GitHub, as connected, and a short-lived token for it: what proposals and the agent's git use.",
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
  "model.complete": {
    mode: "single",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    // Provided by the runtime (runtime-pi owns the models and their credentials), so never offered.
    summary: "Ask one of the App's models for a text, once (a prompt in, its text out): a title, a summary, a label.",
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
  "agent.extension": {
    mode: "keyed",
    definedIn: "@pikit/pi-adapter",
    stability: "experimental",
    summary: "One Pi extension per name (prompt sections, hooks on model requests and tool calls, wrappers, durable tasks, tools); an agent runs with only the extensions it names.",
  },
  "agent.command": {
    mode: "keyed",
    definedIn: "@pikit/contracts",
    stability: "experimental",
    summary: "One slash command per name (Pi's rule: /new, /name), run in a conversation by whoever runs commands (the dashboard), answering a note.",
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
export function capabilityEntry(name: string, catalogue: RegistryCatalogue = KIT_CATALOGUE): CapabilityEntry | undefined {
  return Object.hasOwn(catalogue.capabilities, name) ? catalogue.capabilities[name] : undefined;
}

/** What a registry's components may be named and may provide or use: the kit's vocabulary and what they declare. */
export interface RegistryCatalogue {
  /** Name prefixes (`channel` for `channel-telegram`). */
  kinds: readonly string[];
  capabilities: Readonly<Record<string, CapabilityEntry>>;
}

/** The kit's own vocabulary, which every registry extends. */
export const KIT_CATALOGUE: RegistryCatalogue = { kinds: KINDS, capabilities: CAPABILITIES as Record<string, CapabilityEntry> };

/** A kind: one lowercase word, the part of a component's name before its first `-`. */
const KIND = /^[a-z][a-z0-9]*$/;
/** A capability name: lowercase words joined by `.` or `-` (`memory`, `approvals.queue`). */
const CAPABILITY = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;

/**
 * The kit's catalogue extended with what `manifests` declare (`declares`), and the problems of those
 * declarations, by component (`<component>: <problem>`): a kind or capability the kit already has,
 * a malformed name, or one capability declared two ways. Two components may declare the same
 * capability identically (two providers of one contract, each carrying it).
 */
export function registryCatalogue(manifests: readonly Manifest[]): { catalogue: RegistryCatalogue; problems: string[] } {
  const kinds = [...KINDS];
  const capabilities: Record<string, CapabilityEntry> = { ...(CAPABILITIES as Record<string, CapabilityEntry>) };
  const declaredBy = new Map<string, string>();
  const problems: string[] = [];
  for (const m of [...manifests].sort((a, b) => a.name.localeCompare(b.name))) {
    const report = (problem: string) => problems.push(`${m.name}: ${problem}`);
    for (const kind of m.declares?.kinds ?? []) {
      if (!KIND.test(kind)) report(`declares the kind "${kind}", which is not one lowercase word (a kind is a name's prefix: "${kind}-…")`);
      else if (KINDS.includes(kind)) report(`declares the kind "${kind}", which the kit has already: declare only new kinds`);
      else if (!kinds.includes(kind)) kinds.push(kind);
    }
    for (const [name, declared] of Object.entries(m.declares?.capabilities ?? {})) {
      if (!CAPABILITY.test(name)) {
        report(`declares the capability "${name}", which is not a capability name (lowercase words joined by "." or "-")`);
        continue;
      }
      if (capabilityEntry(name) !== undefined) {
        report(`declares the capability "${name}", which the kit defines (${capabilityEntry(name)?.definedIn}): use it, or declare a capability of another name`);
        continue;
      }
      const entry: CapabilityEntry = { mode: declared.mode as CapabilityMode, definedIn: m.name, stability: declared.stability as Stability, summary: declared.summary };
      const first = declaredBy.get(name);
      const existing = capabilities[name];
      if (first === undefined || existing === undefined) {
        declaredBy.set(name, m.name);
        capabilities[name] = entry;
      } else if (existing.mode !== entry.mode || existing.stability !== entry.stability || existing.summary !== entry.summary) {
        report(`declares the capability "${name}" differently from ${first}: one contract has one declaration (copy ${first}'s)`);
      }
    }
  }
  return { catalogue: { kinds, capabilities }, problems };
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
 * Every catalogued capability (the kit's and those the manifests declare), plus any unknown one the
 * manifests name, sorted by name. The
 * manifests' `provides` / `requires` / `optional` are generated from setup, so this is what the
 * components really do.
 */
export function capabilityUsage(manifests: readonly Manifest[]): CapabilityUsage[] {
  const usage = new Map<string, CapabilityUsage>();
  const of = (name: string): CapabilityUsage => {
    let entry = usage.get(name);
    if (entry === undefined) {
      entry = { name, entry: capabilityEntry(name, catalogue), providers: [], consumers: [] };
      usage.set(name, entry);
    }
    return entry;
  };
  const { catalogue } = registryCatalogue(manifests);
  for (const name of Object.keys(catalogue.capabilities)) of(name);
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
      const where = entry === undefined || entry.definedIn.startsWith("@") ? entry?.definedIn : `declared by ${entry.definedIn}`;
      const head = entry ? `${name}  (${entry.mode}, ${where}, ${level})` : `${name}  (not in the catalogue)`;
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
