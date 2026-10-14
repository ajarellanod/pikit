/**
 * agents-folders: the project's agents and skills from folders (features/agent-folders.md).
 *
 *   src/agents/<name>/agent.ts              what the agent may do (defineAgent): model, tools, extensions, skills
 *   src/agents/<name>/SYSTEM.md             its system prompt (optional; never beside a systemPrompt in agent.ts)
 *   src/agents/<name>/channels/<channel>.md appended to its prompt in that channel's conversations (telegram:ops → telegram.ops.md)
 *   src/agents/<name>/skills/<skill>/SKILL.md  skills of this agent only
 *   src/skills/<skill>/SKILL.md             the project's catalog (agent.skill): agents name them in `skills`
 *
 * `pikit agents` (the command this component adds, `generate.ts`) reads them and writes one plain file,
 * `src/extensions/agents.ts`: the project component `pikit.config.ts` lists, which provides one
 * `agent.definition` per folder and one `agent.skill` per catalog skill. The texts are written into it
 * as strings, so it needs no `.md` loader and is the same on a server and on Cloudflare; following the
 * imports from `pikit.config.ts` shows everything that runs. Its `doctor` hook (`doctor.ts`) fails while
 * that file is not what the folders say, so `pikit dev` and `pikit up` stop and name the command: nothing
 * is regenerated behind your back, and what was reviewed is what runs (SPEC §6).
 *
 * This file is the renderer: what the folders become, from what `generate.ts` read of them. It imports
 * nothing, so its tests and anyone reading it see the whole format here. Not an app component: it has
 * no default export and is never listed in `pikit.config.ts`. Removing the component leaves the
 * generated file as it was, plain code kept by hand from then on.
 */

/** One agent's folder, as read: its name and the texts beside its `agent.ts`. */
export interface AgentFolder {
  /** The folder's name, which must be its agent's (`fromFolder` checks it when the App is defined). */
  name: string;
  /** `SYSTEM.md`, when there is one. */
  system?: string;
  /** `channels/<channel>.md`, by channel (`telegram:ops` for `telegram.ops.md`), sorted. */
  channels: readonly { channel: string; text: string }[];
  /** `skills/<skill>/SKILL.md`, its own skills, sorted. */
  skills: readonly SkillFolder[];
}

/** One skill's folder, as read. */
export interface SkillFolder {
  /** The folder's name, which must be the skill's (`defineSkill` checks it). */
  name: string;
  /** The `SKILL.md`. */
  text: string;
  /**
   * The folder's path relative to `src/extensions/`, when the skill has files of its own to run there
   * and the project runs on a server: its `location`. Absent: the skill is its text only.
   */
  location?: string;
}

/** What `generate.ts` read: every agent folder and the catalog, each sorted by name. */
export interface Folders {
  agents: readonly AgentFolder[];
  skills: readonly SkillFolder[];
}

/** The file it writes, relative to the project. */
export const GENERATED = "src/extensions/agents.ts";

/** A part of a channel instance (`telegram`, `ops` of `telegram:ops`), as workspace-local names its directory. */
const CHANNEL_PART = /^[a-z][a-z0-9-]*$/;

/** The channel a `channels/` file is for: `telegram.ops.md` → `telegram:ops`; `undefined` when it names none. */
export function channelOfFile(file: string): string | undefined {
  if (!file.endsWith(".md")) return undefined;
  const parts = file.slice(0, -".md".length).split(".");
  return parts.every((part) => CHANNEL_PART.test(part)) ? parts.join(":") : undefined;
}

/** A text as a template literal: multi-line and readable, with what a template would read escaped. */
export function literal(text: string): string {
  return `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;
}

/** An identifier for an agent's import: `sales-eu` → `salesEu`, never a reserved word. */
function identifierOf(name: string): string {
  return `${name.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())}Agent`;
}

/**
 * One import line of the generated file. Built from parts: `registry validate` reads every source of a
 * component for its imports, strings too, and these are the generated file's, not this one's.
 */
function importLine(what: string, specifier: string): string {
  const keyword = "import";
  return `${keyword} ${what} from ${JSON.stringify(specifier)};`;
}

function skill(folder: SkillFolder, indent: string): string {
  const location = folder.location === undefined ? "" : `, location: fileURLToPath(new URL(${JSON.stringify(folder.location)}, import.meta.url))`;
  return `${indent}defineSkill(${literal(folder.text)}, { name: ${JSON.stringify(folder.name)}${location} }),`;
}

/** The text of `src/extensions/agents.ts` for `folders`: the same folders, the same text. */
export function render(folders: Folders): string {
  const every = [...folders.skills, ...folders.agents.flatMap((agent) => agent.skills)];
  const locations = every.some((each) => each.location !== undefined);
  const lines: string[] = [
    "/**",
    " * The project's agents and skills, written by `pikit agents` (agents-folders) from src/agents/ and",
    " * src/skills/: do not edit it. Change the folders and run `pikit agents` again; `pikit doctor` fails",
    " * while this file is not what they say.",
    " */",
    "",
    ...(locations ? [importLine("{ fileURLToPath }", "node:url")] : []),
    importLine("{ defineComponent }", "@pikit/core"),
    importLine(`{ type AgentDefinition, type AgentSkill, defineAgent${every.length > 0 ? ", defineSkill" : ""} }`, "@pikit/contracts"),
    ...folders.agents.map((agent) => importLine(identifierOf(agent.name), `../agents/${agent.name}/agent.ts`)),
    "",
    "/** What a folder holds beside its agent.ts. */",
    "interface Texts {",
    "  system?: string;",
    "  channels?: Record<string, string>;",
    "  skills?: AgentSkill[];",
    "}",
    "",
    "/**",
    " * The agent of a folder: its agent.ts, with SYSTEM.md as its prompt, its own skills after the ones it",
    " * names, and each channel's text appended to the prompt in that channel's conversations, after what",
    " * its own prepare gives. An agent.ts naming another agent, or with a systemPrompt beside SYSTEM.md,",
    " * stops the App: one source per field.",
    " */",
    "function fromFolder(folder: string, agent: AgentDefinition, texts: Texts): AgentDefinition {",
    "  if (agent.name !== folder) {",
    "    throw new Error(`src/agents/${folder}/agent.ts defines the agent \"${agent.name}\": an agent's folder is named after it`);",
    "  }",
    "  if (texts.system !== undefined && agent.systemPrompt !== undefined) {",
    "    throw new Error(`agent \"${agent.name}\": its system prompt is in agent.ts and in SYSTEM.md; keep one`);",
    "  }",
    "  const systemPrompt = texts.system ?? agent.systemPrompt;",
    "  const channels = texts.channels ?? {};",
    "  const own = agent.prepare;",
    "  return defineAgent({",
    "    ...agent,",
    "    ...(systemPrompt !== undefined && { systemPrompt }),",
    "    ...(texts.skills !== undefined && { skills: [...(agent.skills ?? []), ...texts.skills] }),",
    "    ...(Object.keys(channels).length > 0 && {",
    "      prepare(state, context) {",
    "        const changes = own?.call(agent, state, context) ?? {};",
    "        const channel = context.conversation.channel;",
    "        const text = channel === undefined ? undefined : channels[channel];",
    "        if (text === undefined) return changes;",
    "        const prompt = changes.systemPrompt ?? systemPrompt;",
    "        return { ...changes, systemPrompt: prompt === undefined || prompt === \"\" ? text : `${prompt}\\n\\n${text}` };",
    "      },",
    "    }),",
    "  });",
    "}",
    "",
    "/** src/skills/: the project's catalog, which agents name in their skills. */",
    "const skills: AgentSkill[] = [",
    ...folders.skills.map((each) => skill(each, "  ")),
    "];",
    "",
    "/** src/agents/: one agent per folder. */",
    "const agents: AgentDefinition[] = [",
  ];
  for (const agent of folders.agents) {
    const texts: string[] = [];
    if (agent.system !== undefined) texts.push(`    system: ${literal(agent.system)},`);
    if (agent.channels.length > 0) {
      texts.push("    channels: {", ...agent.channels.map((each) => `      ${JSON.stringify(each.channel)}: ${literal(each.text)},`), "    },");
    }
    if (agent.skills.length > 0) texts.push("    skills: [", ...agent.skills.map((each) => skill(each, "      ")), "    ],");
    lines.push(
      texts.length === 0
        ? `  fromFolder(${JSON.stringify(agent.name)}, ${identifierOf(agent.name)}, {}),`
        : [`  fromFolder(${JSON.stringify(agent.name)}, ${identifierOf(agent.name)}, {`, ...texts, "  }),"].join("\n"),
    );
  }
  lines.push(
    "];",
    "",
    "export default defineComponent({",
    '  name: "agents",',
    "  setup(pikit) {",
    '    for (const agent of agents) pikit.provideKeyed("agent.definition", agent.name, agent);',
    '    for (const each of skills) pikit.provideKeyed("agent.skill", each.name, each);',
    "  },",
    "});",
    "",
  );
  return lines.join("\n");
}
