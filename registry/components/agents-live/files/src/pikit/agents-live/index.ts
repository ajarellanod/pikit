/**
 * agents-live: agents as data (features/settings.md, "Multi-agent"). An operator creates, edits and
 * removes agents in the dashboard (its Agents section, `settings/`), with no deploy and no restart;
 * this component keeps them as its settings (`settings`, settings-store) and provides them as
 * `agent.directory` (@pikit/contracts' agent-directory.ts), where runtime-pi finds an agent its
 * `agent.definition`s do not have, and router-rules checks the agent a rule names.
 *
 * - **An agent** is a name (kebab-case), a description, a system prompt, a model (one an installed
 *   `model.provider` has), and tools and extensions by name (installed `agent.tool` and
 *   `agent.extension` keys only). What needs code (`prepare`, a tool of the project's own) is an agent
 *   of `src/agents/`, which stays as it is: the project's agents are listed beside these, read-only.
 * - **Its settings** are one key per agent (`{ support: { model, systemPrompt, … } }`), declared at
 *   start with what this App has: the models, the tools, the extensions, and the names of the code's
 *   agents, which no live agent may take. A change the schema refuses is refused (`invalid_value`); a
 *   stored agent a deploy made invalid (its model gone, a code agent of its name) is left out when read,
 *   logged by settings-store, and is no agent until an operator saves it again.
 * - **Read when used**: `list` and `get` read the settings each time (on Cloudflare settings-store
 *   keeps them a second in each object): a new agent answers its first message with no restart, and a
 *   change applies to the next admission.
 *
 * It requires `settings` (settings-store, which comes with the dashboard). With router-rules, which
 * reads its rules from settings too, an operator routes a channel, chat or person to a live agent
 * (the Routing section): `pikit new`'s features step installs both.
 *
 * Targets: `server` and `durable` (it imports nothing platform-specific; on Cloudflare it goes in each
 * conversation's object, where runtime-pi asks it, and the settings are the settings object's).
 */

import { type AppContext, defineComponent } from "@pikit/core";
import type { AgentDirectory, DirectoryAgent, SettingsValue } from "@pikit/contracts";
import { modelsFrom } from "@pikit/pi-adapter";
import Type, { type TSchema } from "typebox";

/** An agent's name, as `defineAgent` checks it. */
export const AGENT_NAME = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** The longest system prompt, in characters. */
export const MAX_PROMPT = 100_000;
/** The longest description, in characters. */
export const MAX_DESCRIPTION = 300;
/** The most live agents one App holds. */
export const MAX_AGENTS = 100;

/** What this App offers a live agent, and the names it may not take. */
export interface AgentChoices {
  models: readonly string[];
  tools: readonly string[];
  extensions: readonly string[];
  /** The code's agents (`agent.definition`). */
  defined: readonly string[];
}

const choice = (values: readonly string[], options: Record<string, unknown> = {}): TSchema =>
  values.length === 0 ? Type.Never(options) : Type.Union([...values].sort().map((value) => Type.Literal(value)), options);

/** agents-live's settings: one key per agent, its value the agent's fields (a `DirectoryAgent` without its name). */
export function agentsSchema({ models, tools, extensions, defined }: AgentChoices): TSchema {
  const agent = Type.Object(
    {
      description: Type.Optional(Type.String({ maxLength: MAX_DESCRIPTION, title: "Description", description: "One line: what it is for." })),
      model: choice(models, { title: "Model", description: "The model that answers, among the installed providers'." }),
      systemPrompt: Type.Optional(Type.String({ maxLength: MAX_PROMPT, title: "System prompt", description: "What the agent is told before every conversation." })),
      tools: Type.Optional(Type.Array(choice(tools), { uniqueItems: true, title: "Tools", description: "The tools it may call, among the installed ones." })),
      extensions: Type.Optional(Type.Array(choice(extensions), { uniqueItems: true, title: "Extensions", description: "The agent extensions it runs with, in order, among the installed ones." })),
    },
    { additionalProperties: false },
  );
  return Type.Object({}, {
    additionalProperties: false,
    patternProperties: { [AGENT_NAME]: agent },
    maxProperties: MAX_AGENTS,
    ...(defined.length > 0 && { propertyNames: { not: { enum: [...defined].sort() } } }),
    title: "Agents",
  } as Record<string, unknown>);
}

/** The agents a settings value holds, by name. */
export function agentsOf(value: SettingsValue): DirectoryAgent[] {
  return Object.entries(value)
    .map(([name, fields]) => ({ ...(fields as Omit<DirectoryAgent, "name">), name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default defineComponent({
  name: "agents-live",
  setup(pikit) {
    const settings = pikit.use("settings");
    const definitions = pikit.useKeyed("agent.definition");
    const providers = pikit.useKeyed("model.provider");
    const tools = pikit.useKeyed("agent.tool");
    const extensions = pikit.useKeyed("agent.extension");
    let declared = false;

    const read = async (ctx: AppContext): Promise<DirectoryAgent[]> => {
      if (!declared) throw new Error("agents-live: agent.directory used while the app is not running");
      // A code agent wins: a stored one of its name (a deploy added it) is not listed.
      return agentsOf(await settings.get().get("agents-live", ctx)).filter((agent) => definitions.get(agent.name) === undefined);
    };
    const directory: AgentDirectory = {
      list: read,
      get: async (name, ctx) => (await read(ctx)).find((agent) => agent.name === name),
    };
    pikit.provide("agent.directory", directory);

    return {
      start() {
        const models = modelsFrom(providers.keys().flatMap((key) => providers.get(key) ?? []))
          .getModels()
          .map((model) => `${model.provider}/${model.id}`);
        const schema = agentsSchema({ models, tools: tools.keys(), extensions: extensions.keys(), defined: definitions.keys() });
        settings.get().declare("agents-live", schema, {});
        declared = true;
      },
      stop() {
        declared = false;
      },
    };
  },
});
