/**
 * The agents' live overrides (features/settings.md, option B): an operator changes an agent's system
 * prompt, model, tools and skills from the dashboard (router-basic's Agent section), as runtime-pi's settings
 * (`settings`, when a provider is installed). The definition still owns the agent (SPEC §6): the
 * overrides are data over it, applied where the runtime rebuilds `pi.agent` from the definition (at
 * every admission, in the commit of each state update, before a reopened Harness resumes), after
 * `prepare(state)`. So a restart, a reopened Harness and an evicted object build the same agent.
 *
 * - **What can be overridden**, per agent: `systemPrompt`; `model`, one an installed `model.provider`
 *   has; `tools`, the tools on among the names its definition gives (a name it leaves out is off;
 *   tools `prepare` adds beyond the definition's stay); `skills`, the same among the skills its
 *   definition names (a catalog name, or a skill of its own by its name). The schema says which, from the App at start:
 *   a value outside it is refused when set, and left out when read (a deploy removed the model).
 * - **Where it goes**: a definition with an override gets a `prepare` that runs its own, then puts the
 *   override over what it returned. A definition with none is the definition itself. An override the
 *   runtime cannot resolve (a model gone) makes the run use the definition, logged as `prepare`'s
 *   failures are.
 */

import type { AgentDefinition, SettingsValue } from "@pikit/contracts";
import Type, { type TSchema } from "typebox";

/** What an operator may change of one agent. Absent: the definition's. */
export interface AgentOverride {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
}

/** runtime-pi's settings: an override per agent, by name. */
export type AgentOverrides = Record<string, AgentOverride>;

/** The longest system prompt an operator may set, in characters. */
export const MAX_PROMPT = 100_000;

/** The names of a definition's tools: a name as it is, a tool object by its `name`. */
export function toolNames(agent: Pick<AgentDefinition, "tools">): string[] {
  return (agent.tools ?? []).flatMap((tool) => {
    const named = typeof tool === "string" ? tool : (tool as { name?: unknown } | null)?.name;
    return typeof named === "string" ? [named] : [];
  });
}

/** The names of a definition's skills: a catalog name as it is, a skill of its own by its `name`. */
export function skillNames(agent: Pick<AgentDefinition, "skills">): string[] {
  return (agent.skills ?? []).flatMap((skill) => {
    const named = typeof skill === "string" ? skill : (skill as { name?: unknown } | null)?.name;
    return typeof named === "string" ? [named] : [];
  });
}

const choice = (values: readonly string[], options: Record<string, unknown>): TSchema =>
  values.length === 0 ? Type.Never(options) : Type.Union(values.map((value) => Type.Literal(value)), options);

/**
 * The schema of runtime-pi's settings in this App: one optional object per agent, whose `default`s are
 * its definition's (what the dashboard shows when nothing is overridden; never applied as values).
 * With `live` (an `agent.directory` is installed), any other agent's name may hold an override too, as
 * a live agent's: among the models and the installed tools and skills, since what it names is known only
 * when used.
 */
export function overridesSchema(agents: readonly AgentDefinition[], models: readonly string[], live?: { tools: readonly string[]; skills: readonly string[] }): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
    const tools = toolNames(agent);
    const skills = skillNames(agent);
    properties[agent.name] = Type.Optional(
      Type.Object(
        {
          systemPrompt: Type.Optional(
            Type.String({ maxLength: MAX_PROMPT, title: "System prompt", description: "What the agent is told before every conversation.", default: agent.systemPrompt ?? "" }),
          ),
          model: Type.Optional(choice([...new Set([...models, agent.model])].sort(), { title: "Model", description: "The model that answers, among the installed providers'.", default: agent.model })),
          tools: Type.Optional(Type.Array(choice(tools, {}), { uniqueItems: true, title: "Tools", description: "The tools it may call, among those its definition names.", default: tools })),
          skills: Type.Optional(Type.Array(choice(skills, {}), { uniqueItems: true, title: "Skills", description: "The skills it knows, among those its definition names.", default: skills })),
        },
        { additionalProperties: false, title: agent.name },
      ),
    );
  }
  const other =
    live === undefined
      ? false
      : Type.Object(
          {
            systemPrompt: Type.Optional(Type.String({ maxLength: MAX_PROMPT })),
            model: Type.Optional(choice([...models].sort(), {})),
            tools: Type.Optional(Type.Array(choice([...live.tools].sort(), {}), { uniqueItems: true })),
            skills: Type.Optional(Type.Array(choice([...live.skills].sort(), {}), { uniqueItems: true })),
          },
          { additionalProperties: false },
        );
  return Type.Object(properties, { additionalProperties: other });
}

/** `agent` with `override` over what its `prepare` returns; `agent` itself with no override. */
export function withOverride(agent: AgentDefinition | undefined, override: AgentOverride | undefined): AgentDefinition | undefined {
  if (agent === undefined || override === undefined || Object.keys(override).length === 0) return agent;
  const own = agent.prepare;
  const on = override.tools === undefined ? undefined : new Set(override.tools);
  const off = on === undefined ? new Set<string>() : new Set(toolNames(agent).filter((name) => !on.has(name)));
  const known = override.skills === undefined ? undefined : new Set(override.skills);
  const unknown = known === undefined ? new Set<string>() : new Set(skillNames(agent).filter((name) => !known.has(name)));
  return {
    ...agent,
    prepare(state, context) {
      const changes = own === undefined ? {} : (own.call(agent, state, context) ?? {});
      const tools = changes.tools ?? agent.tools ?? [];
      const skills = changes.skills ?? agent.skills ?? [];
      return {
        ...changes,
        ...(override.systemPrompt !== undefined && { systemPrompt: override.systemPrompt }),
        ...(override.model !== undefined && { model: override.model }),
        ...(off.size > 0 && { tools: tools.filter((tool) => !off.has(typeof tool === "string" ? tool : tool.name)) }),
        ...(unknown.size > 0 && { skills: skills.filter((skill) => !unknown.has(typeof skill === "string" ? skill : skill.name)) }),
      };
    },
  };
}

/** The overrides as `settings.get` answers them: only well-formed ones (the provider validated them). */
export function overridesOf(value: SettingsValue): AgentOverrides {
  return value as unknown as AgentOverrides;
}
