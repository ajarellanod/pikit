/**
 * What Home says of the App's composition (`ApiApp`), worked out here with no imports but types, so the
 * kit's tests read it as it is: its components by what they are for, the line that sums it up, and the
 * wiring worth a look (a capability with a choice of providers, a keyed one, one nobody provides, the
 * pipelines' stages).
 */

import type { ApiApp } from "../../lib/admin-api.ts";

export type Component = ApiApp["components"][number];

export interface Group {
  title: string;
  components: Component[];
}

/**
 * What a component is for: the first kind whose capabilities it provides (`storage.` is a family), else
 * whose prefix its name has. A channel provides only routes, so it is known by its name.
 */
const KINDS: { title: string; capabilities: string[]; prefixes: string[] }[] = [
  { title: "Channels", capabilities: [], prefixes: ["channel-"] },
  { title: "Agents and models", capabilities: ["agent.runtime", "model.provider", "agent.extension"], prefixes: ["runtime-", "provider-", "router-", "extension-", "agents-"] },
  { title: "Tools", capabilities: ["agent.tool"], prefixes: ["tool-"] },
  { title: "Data", capabilities: ["storage.", "conversations.registry", "settings", "outbound.queue"], prefixes: ["storage-", "conversations-"] },
  { title: "Integrations", capabilities: ["repo.github", "proposals"], prefixes: [] },
  { title: "Dashboard and admin", capabilities: ["admin.auth"], prefixes: ["admin-"] },
  { title: "Platform", capabilities: ["secrets", "wakeups", "execution"], prefixes: ["actors-", "deployment-", "secrets-", "execution-"] },
];
export const OTHER = "Other";

const provides = (component: Component, capabilities: string[]) =>
  component.provides.some((name) => capabilities.some((each) => (each.endsWith(".") ? name.startsWith(each) : name === each)));

export function kindOf(component: Component): string {
  const kind = KINDS.find((each) => provides(component, each.capabilities) || each.prefixes.some((prefix) => component.name.startsWith(prefix)));
  return kind?.title ?? OTHER;
}

/** The components by kind, in the kinds' order (Other last), each kind's by name; no empty kind. */
export function groupsOf(components: Component[]): Group[] {
  const titles = [...KINDS.map((kind) => kind.title), OTHER];
  return titles
    .map((title) => ({ title, components: components.filter((component) => kindOf(component) === title).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((group) => group.components.length > 0);
}

/** Where the App runs, in words. */
export function placeOf(target: string): string {
  return target === "durable" ? "Cloudflare" : target === "server" ? "a server" : target;
}

/** The platforms its channels talk on, by the first word after `channel-` (`channel-telegram-webhook` is Telegram). */
export function channelsOf(components: Component[]): string[] {
  const names = components
    .filter((component) => component.name.startsWith("channel-"))
    .map((component) => component.name.slice("channel-".length).split("-")[0] ?? "")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1));
  return [...new Set(names)];
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const list = (words: string[]) => (words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/**
 * The App in one line: where it talks (its channels, and this dashboard), with how many agents (when
 * read) and tools, out of how many components.
 */
export function summaryOf(app: ApiApp, agents: number | undefined): string {
  const where = [...channelsOf(app.components), "this dashboard"];
  const tools = app.components.filter((component) => kindOf(component) === "Tools").length;
  const with_ = [...(agents === undefined ? [] : [plural(agents, "agent")]), plural(tools, "tool")];
  return `Talks on ${list(where)}, with ${list(with_)}: ${plural(app.components.length, "component")} in all.`;
}

/** Who provides `capability` for the App: its keys' providers, the one selected, or every provider. */
export function providersOf(app: ApiApp, capability: string): string[] {
  const found = app.capabilities[capability];
  if (found === undefined) return [];
  if (found.keys !== undefined && Object.keys(found.keys).length > 0) return [...new Set(Object.values(found.keys))];
  return found.selected !== undefined ? [found.selected] : found.providers;
}

/** The other components that use what `component` provides (requiring it, or using it when installed). */
export function usersOf(app: ApiApp, component: Component): string[] {
  return app.components
    .filter((other) => other.name !== component.name && [...other.requires, ...other.optional].some((capability) => component.provides.includes(capability)))
    .map((other) => other.name);
}

/**
 * A single capability more than one component provides, with the one the App uses. One every provider
 * of is used (`agent.tool`, a keyed one) is no choice.
 */
export interface Choice {
  capability: string;
  providers: string[];
  selected: string;
}

/** One key of a keyed capability (an `http.route`'s path) and who provides it. */
export interface Keyed {
  capability: string;
  key: string;
  provider: string;
}

/** A capability some components would use, which nothing provides. */
export interface Missing {
  capability: string;
  wantedBy: string[];
}

export interface Stage {
  id: string;
  priority?: number;
}

export interface Wiring {
  choices: Choice[];
  keyed: Keyed[];
  missing: Missing[];
  pipelines: { name: string; stages: Stage[] }[];
}

/** A pipeline's stage as the API gives it (`{ id, priority }`); anything else by its JSON. */
function stageOf(value: unknown): Stage {
  if (typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string") {
    const { id, priority } = value as { id: string; priority?: unknown };
    return typeof priority === "number" ? { id, priority } : { id };
  }
  return { id: JSON.stringify(value) };
}

export function wiringOf(app: ApiApp): Wiring {
  const capabilities = Object.entries(app.capabilities).sort(([a], [b]) => a.localeCompare(b));
  const choices = capabilities
    .flatMap(([name, capability]) => (capability.providers.length > 1 && capability.selected !== undefined ? [{ capability: name, providers: capability.providers, selected: capability.selected }] : []));
  const keyed = capabilities.flatMap(([name, capability]) =>
    Object.entries(capability.keys ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, provider]) => ({ capability: name, key, provider })),
  );
  const wanted = new Map<string, string[]>();
  for (const component of app.components) {
    for (const capability of component.optional) {
      if ((app.capabilities[capability]?.providers.length ?? 0) > 0) continue;
      wanted.set(capability, [...(wanted.get(capability) ?? []), component.name]);
    }
  }
  const missing = [...wanted].sort(([a], [b]) => a.localeCompare(b)).map(([capability, wantedBy]) => ({ capability, wantedBy }));
  const pipelines = Object.entries(app.pipelines)
    .filter(([, stages]) => stages.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, stages]) => ({ name, stages: stages.map(stageOf) }));
  return { choices, keyed, missing, pipelines };
}
