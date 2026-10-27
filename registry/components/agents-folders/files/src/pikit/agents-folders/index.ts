/**
 * agents-folders: the project's agents and skills from folders (features/agent-folders.md).
 *
 *   src/agents/<name>/agent.ts              what the agent may do (defineAgent): model, tools, extensions, skills
 *   src/agents/<name>/SYSTEM.md             its system prompt (optional; never beside a systemPrompt in agent.ts)
 *   src/agents/<name>/channels/<channel>.md appended to its prompt in that channel's conversations (telegram:ops → telegram.ops.md)
 *   src/agents/<name>/skills/<skill>/SKILL.md  skills of this agent only
 *   src/agents/<name>/prompts/<command>.md  its prompt templates (Pi's format): each one the slash command /<command>
 *   src/skills/<skill>/SKILL.md             the project's catalog (agent.skill): agents name them in `skills`
 *
 * `pikit agents` (the command this component adds, `generate.ts`) reads them and writes one plain file,
 * `src/extensions/agents.ts`: the project component `pikit.config.ts` lists, which provides one
 * `agent.definition` per folder, one `agent.skill` per catalog skill, and one `agent.command` per
 * prompt template's name (`templateCommand` in that file). The texts are written into it
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
  /** `prompts/<command>.md`, its prompt templates, sorted by name. */
  prompts: readonly PromptFile[];
}

/**
 * One prompt template (Pi's coding agent's format): `prompts/<command>.md`, an optional frontmatter
 * (`description`, `argument-hint`) and its text, whose placeholders (`$1`, `$@`, `${1:-default}`…) the
 * command fills from what follows `/<command>`.
 */
export interface PromptFile {
  /** The file's name without `.md`: the command's (`isCommandName`). */
  name: string;
  /** Its frontmatter's `description`, or its first line (60 characters at most, as Pi takes it). */
  description: string;
  /** Its frontmatter's `argument-hint`: `[focus]`, `<file>`. */
  argumentHint?: string;
  /** Its text, after the frontmatter, trimmed. */
  text: string;
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

/**
 * What the generated file holds to run the prompt templates: Pi's argument splitting and placeholders
 * (`parseCommandArgs`, `substituteArgs` of its coding agent), and the command each name is. Written into
 * the file as it is here, so the file stays plain code that needs nothing of this component.
 */
const TEMPLATE_CODE = String.raw`/** A prompt template (Pi's format): what a menu shows, and its text. */
interface Template {
  description: string;
  argumentHint?: string;
  text: string;
}

/** A command's arguments as Pi splits them: at spaces, a "quoted" or 'quoted' one kept whole. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let token = false;
  let quote: string | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      token = true;
    } else if (/\s/.test(char)) {
      if (token) args.push(current);
      current = "";
      token = false;
    } else {
      current += char;
      token = true;
    }
  }
  if (token) args.push(current);
  return args;
}

/** Pi's placeholders filled from args: $1 $2…, $@ and $ARGUMENTS (all), {1:-default} and {@:-default}, {@:N} and {@:N:L} (each after a $). */
function expand(text: string, args: string[]): string {
  const all = args.join(" ");
  const placeholder = new RegExp("\\$\\{(\\d+|ARGUMENTS|@):-([^}]*)\\}|\\$\\{@:(\\d+)(?::(\\d+))?\\}|\\$(ARGUMENTS|@|\\d+)", "g");
  return text.replace(placeholder, (_match, target?: string, fallback?: string, from?: string, length?: string, simple?: string) => {
    if (target !== undefined) return (target === "@" || target === "ARGUMENTS" ? all : args[Number(target) - 1]) || (fallback ?? "");
    if (from !== undefined) {
      const start = Math.max(0, Number(from) - 1);
      return (length === undefined ? args.slice(start) : args.slice(start, start + Number(length))).join(" ");
    }
    return simple === "@" || simple === "ARGUMENTS" ? all : (args[Number(simple) - 1] ?? "");
  });
}

/**
 * The slash command of a template's name, for anyone in a chat: the template of the conversation's
 * agent, its arguments expanded, as the prompt whoever ran it dispatches in place of the typed message.
 * One name in several agents is one command; the first agent's description is the menu's.
 */
function templateCommand(name: string, byAgent: Record<string, Template>): AgentCommand {
  const first = Object.values(byAgent)[0] as Template;
  return {
    description: first.description,
    ...(first.argumentHint !== undefined && { argumentHint: first.argumentHint }),
    audience: "user",
    async run(conversation, args) {
      const template = Object.hasOwn(byAgent, conversation.agent) ? byAgent[conversation.agent] : undefined;
      if (template === undefined) throw new Error("this agent has no template \"" + name + "\"");
      const prompt = expand(template.text, splitArgs(args));
      if (prompt.trim() === "") throw new Error("/" + name + " with these arguments is an empty prompt" + (first.argumentHint === undefined ? "" : ": /" + name + " " + first.argumentHint));
      return { prompt };
    },
  };
}`;

/** The templates of `agents`, by name then agent: `{ name: { agent: template } }`, sorted. */
function templatesOf(agents: readonly AgentFolder[]): [string, [string, PromptFile][]][] {
  const byName = new Map<string, [string, PromptFile][]>();
  for (const agent of agents) for (const prompt of agent.prompts) byName.set(prompt.name, [...(byName.get(prompt.name) ?? []), [agent.name, prompt]]);
  return [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The text of `src/extensions/agents.ts` for `folders`: the same folders, the same text. */
export function render(folders: Folders): string {
  const every = [...folders.skills, ...folders.agents.flatMap((agent) => agent.skills)];
  const locations = every.some((each) => each.location !== undefined);
  const templates = templatesOf(folders.agents);
  const lines: string[] = [
    "/**",
    " * The project's agents and skills, written by `pikit agents` (agents-folders) from src/agents/ and",
    " * src/skills/: do not edit it. Change the folders and run `pikit agents` again; `pikit doctor` fails",
    " * while this file is not what they say.",
    " */",
    "",
    ...(locations ? [importLine("{ fileURLToPath }", "node:url")] : []),
    importLine("{ defineComponent }", "@pikit/core"),
    importLine(`{ ${templates.length > 0 ? "type AgentCommand, " : ""}type AgentDefinition, type AgentSkill, defineAgent${every.length > 0 ? ", defineSkill" : ""} }`, "@pikit/contracts"),
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
  lines.push("];", "");
  if (templates.length > 0) {
    lines.push(
      TEMPLATE_CODE,
      "",
      "/** src/agents/<agent>/prompts/<name>.md, by name, then by agent: each name one slash command. */",
      "const templates: Record<string, Record<string, Template>> = {",
    );
    for (const [name, byAgent] of templates) {
      lines.push(`  ${JSON.stringify(name)}: {`);
      for (const [agent, prompt] of byAgent) {
        const hint = prompt.argumentHint === undefined ? "" : ` argumentHint: ${JSON.stringify(prompt.argumentHint)},`;
        lines.push(`    ${JSON.stringify(agent)}: { description: ${JSON.stringify(prompt.description)},${hint} text: ${literal(prompt.text)} },`);
      }
      lines.push("  },");
    }
    lines.push("};", "");
  }
  lines.push(
    "export default defineComponent({",
    '  name: "agents",',
    "  setup(pikit) {",
    '    for (const agent of agents) pikit.provideKeyed("agent.definition", agent.name, agent);',
    '    for (const each of skills) pikit.provideKeyed("agent.skill", each.name, each);',
    ...(templates.length > 0 ? ['    for (const [name, byAgent] of Object.entries(templates)) pikit.provideKeyed("agent.command", name, templateCommand(name, byAgent));'] : []),
    "  },",
    "});",
    "",
  );
  return lines.join("\n");
}
