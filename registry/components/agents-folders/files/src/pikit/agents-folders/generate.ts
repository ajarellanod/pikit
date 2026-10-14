/**
 * `pikit agents`: reads src/agents/ and src/skills/ and writes src/extensions/agents.ts (`index.ts`
 * says the format). `component.json` declares it (`"commands": { "agents": … }`); the CLI runs
 * `command(io)` in the project's directory, in its own process, never in the app: this file reads the
 * disk, which a Durable Object has no project files on.
 *
 * Every problem is said at once, and nothing is written while there is one: a folder without its
 * agent.ts, a name an agent or a skill cannot have, a SKILL.md `defineSkill` refuses, a channel file
 * that names no channel, a `pikit.config.ts` that does not list the generated file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineSkill, isSkillName } from "@pikit/contracts";
import { type AgentFolder, channelOfFile, type Folders, GENERATED, render, type SkillFolder } from "./index.ts";

/** What the CLI gives a command (`component-command.ts`). Components declare the same shape; nothing is imported. */
export interface CommandIO {
  args: readonly string[];
  config(): Promise<Readonly<Record<string, unknown>>>;
  get(name: string): string | undefined;
  say(line: string): void;
}

/** An agent's name, as `defineAgent` checks it: its folder's. */
const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The file a skill's folder holds its instructions in. */
const SKILL_FILE = "SKILL.md";

/** What the folders of `projectDir` become: the generated file's text, or the problems that stop it. */
export function generated(projectDir: string): { text: string; problems: string[]; agents: number; skills: number } {
  const problems: string[] = [];
  const server = targetsOf(projectDir, problems).includes("server");
  const agents = agentsOf(projectDir, server, problems);
  const skills = skillsIn(join(projectDir, "src", "skills"), "src/skills", "../skills", server, problems);
  const config = join(projectDir, "pikit.config.ts");
  if (existsSync(config) && !readFileSync(config, "utf8").includes(`"./${GENERATED}"`)) {
    problems.push(`pikit.config.ts does not list ./${GENERATED}: import it and add it to the components, as the starter does`);
  }
  const folders: Folders = { agents, skills };
  return { text: problems.length === 0 ? render(folders) : "", problems, agents: agents.length, skills: skills.length };
}

/** The problems of the project as it is: the folders', or a generated file that is not what they say. */
export function stale(projectDir: string): string[] {
  const { text, problems } = generated(projectDir);
  if (problems.length > 0) return problems;
  const file = join(projectDir, GENERATED);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  return current === text ? [] : [`${GENERATED} is not what src/agents/ and src/skills/ say: run \`pikit agents\` (then commit both)`];
}

/** `pikit agents`: writes the file when it changes, and says what it did. */
export async function command(io: CommandIO): Promise<string[]> {
  if (io.args.length > 0) return [`\`pikit agents\` takes no arguments (it was given ${io.args.map((arg) => JSON.stringify(arg)).join(" ")})`];
  const projectDir = process.cwd();
  const { text, problems, agents, skills } = generated(projectDir);
  if (problems.length > 0) return problems;
  const file = join(projectDir, GENERATED);
  const what = `${agents} agent${agents === 1 ? "" : "s"}, ${skills} skill${skills === 1 ? "" : "s"} in the catalog`;
  if (existsSync(file) && readFileSync(file, "utf8") === text) {
    io.say(`${GENERATED} is up to date (${what})`);
    return [];
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  io.say(`wrote ${GENERATED} (${what}): commit it with the folders`);
  return [];
}

function targetsOf(projectDir: string, problems: string[]): string[] {
  const file = join(projectDir, "pikit.json");
  if (!existsSync(file)) {
    problems.push("pikit.json is missing: run `pikit agents` in a pikit project");
    return [];
  }
  const targets = (JSON.parse(readFileSync(file, "utf8")) as { targets?: unknown }).targets;
  return Array.isArray(targets) ? targets.filter((target): target is string => typeof target === "string") : [];
}

/** The entries of `dir` that are directories, sorted; none when it does not exist. */
function directories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .sort();
}

function agentsOf(projectDir: string, server: boolean, problems: string[]): AgentFolder[] {
  const root = join(projectDir, "src", "agents");
  const names = directories(root);
  if (names.length === 0) problems.push("src/agents/ has no agent: an agent is a folder src/agents/<name>/ with its agent.ts");
  const agents: AgentFolder[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const at = `src/agents/${name}`;
    if (!AGENT_NAME.test(name)) {
      problems.push(`${at}/: an agent's folder is its name, kebab-case (support, sales-eu)`);
      continue;
    }
    if (!existsSync(join(dir, "agent.ts"))) {
      problems.push(`${at}/ has no agent.ts (export default defineAgent({ name: "${name}", … }))`);
      continue;
    }
    const system = readdirSync(dir).includes("SYSTEM.md") ? readFileSync(join(dir, "SYSTEM.md"), "utf8").trim() : undefined;
    const channels = (existsSync(join(dir, "channels")) ? readdirSync(join(dir, "channels")).sort() : []).flatMap((file) => {
      const channel = channelOfFile(file);
      if (channel === undefined) {
        problems.push(`${at}/channels/${file}: a channel's file is <channel>.md, lowercase, telegram:ops written telegram.ops.md`);
        return [];
      }
      return [{ channel, text: readFileSync(join(dir, "channels", file), "utf8").trim() }];
    });
    const skills = skillsIn(join(dir, "skills"), `${at}/skills`, `../agents/${name}/skills`, server, problems);
    agents.push({ name, ...(system !== undefined && { system }), channels, skills });
  }
  return agents;
}

/**
 * The skills of `dir` (one folder each, with its SKILL.md), checked as `defineSkill` checks them. On a
 * server, a skill whose folder holds more than its SKILL.md gets its location: where its files are when
 * the project runs (relative to src/extensions/, where the generated file is).
 */
function skillsIn(dir: string, at: string, fromGenerated: string, server: boolean, problems: string[]): SkillFolder[] {
  return directories(dir).flatMap((name) => {
    if (!isSkillName(name)) {
      problems.push(`${at}/${name}/: a skill's folder is its name: lowercase letters, digits and single hyphens`);
      return [];
    }
    const entries = readdirSync(join(dir, name));
    if (!entries.includes(SKILL_FILE)) {
      problems.push(`${at}/${name}/ has no ${SKILL_FILE}`);
      return [];
    }
    const text = readFileSync(join(dir, name, SKILL_FILE), "utf8");
    try {
      defineSkill(text, { name });
    } catch (error) {
      problems.push(`${at}/${name}/${SKILL_FILE}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const files = entries.some((entry) => entry !== SKILL_FILE);
    return [{ name, text, ...(server && files && { location: `${fromGenerated}/${name}/` }) }];
  });
}
