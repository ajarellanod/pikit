/**
 * `agent.command`: the slash commands an operator (or, later, a channel) runs in a conversation,
 * `/name args`, modelled on Pi's `registerCommand` (`RegisteredCommand`: a name, a description, an
 * argument hint, a handler of the text after the name). A component registers each one under its
 * name, as it registers a tool:
 *
 *   pikit.provideKeyed("agent.command", "deploy", {
 *     description: "Deploy the current branch",
 *     argumentHint: "<environment>",
 *     async run(conversation, args, ctx) {
 *       await deploys.get().start(args || "staging", ctx);
 *       return { text: `Deploying to ${args || "staging"}.` };
 *     },
 *   });
 *
 * - **Names** follow Pi's rule for slash commands (`COMMAND_NAME`: lowercase letters, digits, `-` and
 *   `:`, starting with a letter or digit): `new`, `name`, `skill:review`. The key is the name, without
 *   its slash.
 * - **Where it runs:** in the App that holds the conversation (on a server the one App; on Cloudflare
 *   the conversation's Durable Object, where its runtime and its storage are). Whoever runs it (admin-api,
 *   for the dashboard) finds it there by name (`runAgentCommand`) and passes the conversation's
 *   `ConversationRef`: the key's current conversation.
 * - **What it may do:** only through contracts, as any component does (`conversations.registry` to
 *   reset the key, `agent.runtime` to dispatch a message to it, a store of its own); never Pi's or
 *   another component's internals. It runs at once, whether or not a run is going in the conversation.
 * - **What it answers:** `{ text }`, a short note for whoever ran it (the dashboard shows it to the
 *   operator, quietly, and sends it to no channel), or nothing. It writes in the transcript only by
 *   what it does (a message it dispatches). A command that cannot do what it was asked throws an
 *   `Error` whose message says why, for the operator: `runAgentCommand` reports it, never throws it.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationRef } from "./agent.ts";

/** A command's name (its `agent.command` key, without the slash): Pi's rule for slash commands. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9:-]*$/;

/** The longest name and description a command may have (a menu row). */
const MAX_NAME = 64;
const MAX_DESCRIPTION = 200;

/** One slash command, provided under its name (`agent.command`). */
export interface AgentCommand {
  /** One line, for a menu: "Start a new conversation". */
  description: string;
  /** What its arguments are, for a menu: `<title>`. Absent: it takes none. */
  argumentHint?: string;
  /**
   * Runs it in `conversation` (the key's current one) with `args`, the text after the name, trimmed
   * (`""` when none). Resolves with a note for whoever ran it, or nothing; rejects, with a message for
   * the operator, when it cannot.
   */
  run(conversation: ConversationRef, args: string, ctx: AppContext): Promise<{ text?: string } | void>;
}

/** A command as a menu lists it. */
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Whether `name` is a command's name (`COMMAND_NAME`). */
export const isCommandName = (name: string): boolean => name.length <= MAX_NAME && COMMAND_NAME.test(name);

/** What is wrong with a command provided under `name`, or `undefined`: what a runner refuses to list. */
export function commandProblem(name: string, command: AgentCommand | undefined): string | undefined {
  if (!isCommandName(name)) return `"${name}" is not a command name (lowercase letters, digits, "-" and ":")`;
  if (command === undefined || typeof command.run !== "function") return `"${name}" has no run()`;
  if (typeof command.description !== "string" || command.description.trim() === "" || command.description.length > MAX_DESCRIPTION || /[\r\n]/.test(command.description)) {
    return `"${name}": its description is one line of at most ${MAX_DESCRIPTION} characters`;
  }
  if (command.argumentHint !== undefined && (typeof command.argumentHint !== "string" || /[\r\n]/.test(command.argumentHint))) return `"${name}": its argumentHint is one line`;
  return undefined;
}

/** What the App's commands are: the keyed capability `agent.command` as `useKeyed` gives it. */
export interface CommandLookup {
  keys(): string[];
  get(name: string): AgentCommand | undefined;
}

/** The App's commands as a menu lists them, by name; a malformed one is left out (`commandProblem`). */
export function listAgentCommands(commands: CommandLookup): CommandInfo[] {
  return commands
    .keys()
    .sort()
    .flatMap((name) => {
      const command = commands.get(name);
      if (command === undefined || commandProblem(name, command) !== undefined) return [];
      return [{ name, description: command.description, ...(command.argumentHint !== undefined && { argumentHint: command.argumentHint }) }];
    });
}

/** What became of a command: it ran (with its note), it failed (and why), or there is no such command. */
export type CommandOutcome = { kind: "ran"; text?: string } | { kind: "failed"; message: string } | { kind: "unknown" };

/**
 * Runs the command `name` of `commands` in `conversation` with `args` (trimmed). An unknown or
 * malformed name is `unknown`, and runs nothing; a command that rejects is `failed`, with its message
 * (never thrown); what it answers other than `{ text: string }` or nothing is taken as nothing.
 */
export async function runAgentCommand(commands: CommandLookup, name: string, conversation: ConversationRef, args: string, ctx: AppContext): Promise<CommandOutcome> {
  const command = isCommandName(name) ? commands.get(name) : undefined;
  if (command === undefined || commandProblem(name, command) !== undefined) return { kind: "unknown" };
  try {
    const answer = await command.run(conversation, args.trim(), ctx);
    const text = typeof answer === "object" && answer !== null && typeof answer.text === "string" && answer.text.trim() !== "" ? answer.text : undefined;
    return { kind: "ran", ...(text !== undefined && { text }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message: message.trim() === "" ? `/${name} failed` : message };
  }
}

declare module "@pikit/core" {
  interface AppKeyedCapabilities {
    /** One slash command per name (Pi's rule), run in a conversation; provided by any component. */
    "agent.command": AgentCommand;
  }
}
