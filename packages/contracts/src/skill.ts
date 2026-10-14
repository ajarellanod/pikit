/**
 * Skills: what an agent knows how to do, as instructions it loads when a task needs them. The format
 * is Agent Skills' (https://agentskills.io), the one Pi's coding agent reads: a folder with a
 * `SKILL.md`, whose YAML frontmatter has a `name` and a `description`, and whose body is the
 * instructions. Other files of the folder (scripts, references) are read or run by the agent's own
 * tools, from the skill's `location`, when it has one there.
 *
 * A skill is data the project ships (SPEC §6): `defineSkill` reads one when the App is defined, the
 * project installs it in its catalog (the keyed capability `agent.skill`, under its name), each agent
 * names the ones it has in `AgentDefinition.skills`, and the runtime lists every skill an agent has in
 * its system prompt (name and description) and gives it the tool `skill` (`SKILL_TOOL`), which returns
 * a skill's instructions. Installing a skill gives no agent anything until it names it, as with tools.
 * pi-durable has no skills of its own: this is the loader Pi's coding agent has, as small
 * (features/learned-skills.md, features/skills-catalog.md).
 *
 *   // the project's skills (a project component, as its agents are):
 *   import review from "../skills/review/SKILL.md" with { type: "text" };
 *   const skill = defineSkill(review, { name: "review" });
 *   pikit.provideKeyed("agent.skill", skill.name, skill);
 *   // an agent names it:
 *   defineAgent({ name: "assistant", model: "…", skills: ["review"] });
 *
 * An agent may also hold a skill object of its own (`skills: [defineSkill(text)]`), which no other
 * agent has.
 *
 * On a server, a skill whose folder has files the agent runs gives its folder as `location`
 * (`defineSkill(text, { location: "/app/skills/review" })`); on Cloudflare a skill is its text only.
 *
 * The frontmatter is read as the YAML a `SKILL.md` writes: top-level `key: value` lines, quoted values,
 * and `>` (folded) or `|` (literal) blocks; nested maps (`metadata:`) are skipped. Neutral: no file
 * access, so it runs on every target.
 */

/** One skill an agent knows. Plain data: `defineSkill` makes one from a `SKILL.md`. */
export interface AgentSkill {
  /** Lowercase letters, digits and single hyphens, at most 64 characters: its folder's name. */
  name: string;
  /** What it is for and when to use it, at most 1024 characters: what the model reads to pick it. */
  description: string;
  /** The `SKILL.md`'s body: what the model reads once it loads the skill. */
  instructions: string;
  /**
   * Where its folder is in the agent's environment (an absolute path), when its other files are there:
   * the model resolves a relative path of the instructions against it. Absent: the instructions only.
   */
  location?: string;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** Whether `name` is a skill's name: lowercase letters, digits and single hyphens, at most 64 characters. */
export function isSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_NAME && NAME.test(name);
}

/** What is wrong with `skill` as an `AgentSkill`, or `undefined`. */
export function skillProblem(skill: unknown): string | undefined {
  if (typeof skill !== "object" || skill === null) return "a skill must be an object (defineSkill)";
  const { name, description, instructions, location } = skill as Partial<Record<keyof AgentSkill, unknown>>;
  if (!isSkillName(name)) {
    return `skill name ${JSON.stringify(name)} must be lowercase letters, digits and single hyphens, at most ${MAX_NAME} characters`;
  }
  if (typeof description !== "string" || description.trim() === "" || description.length > MAX_DESCRIPTION) {
    return `skill "${name}": its description must be text of 1 to ${MAX_DESCRIPTION} characters`;
  }
  if (typeof instructions !== "string") return `skill "${name}": its instructions must be text`;
  if (location !== undefined && (typeof location !== "string" || location === "")) return `skill "${name}": its location must be a path`;
  return undefined;
}

/**
 * A skill from the text of its `SKILL.md`. Throws, saying why, when it has no frontmatter, no valid
 * `name` or `description`, or when `options.name` is given (its folder's name) and differs.
 */
export function defineSkill(markdown: string, options: { location?: string; name?: string } = {}): AgentSkill {
  const { frontmatter, body } = splitFrontmatter(markdown);
  if (frontmatter === undefined) throw new Error("a SKILL.md starts with a frontmatter (--- name, description ---)");
  const fields = readFrontmatter(frontmatter);
  const skill: AgentSkill = {
    name: fields.name ?? "",
    description: (fields.description ?? "").trim(),
    instructions: body.trim(),
    ...(options.location !== undefined && { location: options.location }),
  };
  const problem = skillProblem(skill);
  if (problem !== undefined) throw new Error(problem);
  if (options.name !== undefined && options.name !== skill.name) {
    throw new Error(`skill "${skill.name}": its folder is "${options.name}"; a skill's name is its folder's`);
  }
  return skill;
}

function splitFrontmatter(markdown: string): { frontmatter?: string; body: string } {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { body: text };
  const after = text.indexOf("\n", end + 4);
  return { frontmatter: text.slice(4, end), body: after === -1 ? "" : text.slice(after + 1) };
}

/** The top-level scalar fields of a frontmatter. */
function readFrontmatter(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i] as string);
    if (match === null) continue;
    const key = match[1] as string;
    const raw = (match[2] as string).trim();
    const block = /^([>|])[+-]?$/.exec(raw);
    if (block !== null || raw === "") {
      // An indented block follows: a `>` or `|` scalar, or a nested map (skipped).
      const indented: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")) indented.push(lines[++i] as string);
      if (block === null) continue;
      const content = dedent(indented);
      fields[key] = block[1] === "|" ? content.join("\n") : fold(content);
      continue;
    }
    fields[key] = unquote(raw);
  }
  return fields;
}

function dedent(lines: readonly string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== "").map((line) => (/^\s*/.exec(line) as RegExpExecArray)[0].length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  const out = lines.map((line) => line.slice(indent).trimEnd());
  while (out.length > 0 && out.at(-1) === "") out.pop();
  return out;
}

/** A `>` block: lines joined by spaces, a blank line a line break. */
function fold(lines: readonly string[]): string {
  return lines.reduce((text, line) => (line === "" ? `${text}\n` : text === "" || text.endsWith("\n") ? text + line : `${text} ${line}`), "");
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  // A plain scalar ends before a comment.
  return value.replace(/\s+#.*$/, "");
}
