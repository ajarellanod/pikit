/**
 * `agent.command` conformance: what every component that provides slash commands guarantees to whoever
 * runs them (`../command.ts`), and what `runAgentCommand` does with them. Runner-independent:
 *
 *   for (const c of createAgentCommandConformance(() => myCommandsFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite starts an App of the fixture's components and two commands of its own (one that answers
 * with what it was given, one that fails), and runs each command the fixture names in the fixture's
 * conversation, through `runAgentCommand`, as admin-api does.
 */

import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, type KeyedHandle, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { ConversationRef } from "../agent.ts";
import { type AgentCommand, type CommandOutcome, commandProblem, listAgentCommands, runAgentCommand } from "../command.ts";
import { checker, expecter } from "./assert.ts";

/** The commands under test, in an App built for one case. */
export interface AgentCommandFixture {
  /** The components that provide the commands, and what they use. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The conversation the commands run in, once the App started (a key resolved through `conversations.registry`). */
  conversation(app: App, ctx: AppContext): Promise<ConversationRef>;
  /**
   * Each command to run, with its arguments: it must run (`ran`); `check` then sees what it did, in its
   * conversation (`outcome.text` is its note).
   */
  runs: { name: string; args?: string; check?(outcome: Extract<CommandOutcome, { kind: "ran" }>, conversation: ConversationRef, app: App, ctx: AppContext): Promise<void> }[];
  /** Commands with arguments they cannot do: each must fail with a message. */
  failures?: { name: string; args: string }[];
  dispose?(): Promise<void>;
}

const GROUP = "agent.command";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** The suite's own commands: one answers what it was given, one fails. */
const ECHO = "conformance-echo";
const FAILS = "conformance:fails";
const probes = defineComponent({
  name: "agent-command-conformance-probes",
  setup(pikit) {
    const echo: AgentCommand = {
      description: "Answers with its conversation and its arguments",
      argumentHint: "<anything>",
      run: async (conversation, args) => ({ text: `${conversation.key} ${conversation.conversationId} [${args}]` }),
    };
    const fails: AgentCommand = {
      description: "Always fails",
      run: async () => {
        throw new Error("this command cannot run here");
      },
    };
    pikit.provideKeyed("agent.command", ECHO, echo);
    pikit.provideKeyed("agent.command", FAILS, fails);
  },
});

export function createAgentCommandConformance(factory: () => AgentCommandFixture | Promise<AgentCommandFixture>): readonly ConformanceCase[] {
  const commandCase = (name: string, run: (commands: KeyedHandle<AgentCommand>, conversation: ConversationRef, fixture: AgentCommandFixture, app: App, ctx: AppContext) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      let commands: KeyedHandle<AgentCommand> | undefined;
      const consumer = defineComponent({
        name: "agent-command-conformance",
        setup(pikit) {
          commands = pikit.useKeyed("agent.command");
        },
      });
      const app = await defineApp({
        components: [...fixture.components, probes, consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      await app.start();
      try {
        const ctx = app.context();
        await run(commands as KeyedHandle<AgentCommand>, await fixture.conversation(app, ctx), fixture, app, ctx);
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    commandCase("every command is provided under a command name, with a one-line description, and listed", async (commands, _conversation, fixture) => {
      for (const name of commands.keys()) expect(commandProblem(name, commands.get(name)), undefined, `the command "${name}"'s problem`);
      const listed = listAgentCommands(commands).map((each) => each.name);
      for (const { name } of fixture.runs) check(listed.includes(name), `"${name}" among the commands listed (${listed.join(", ")})`);
    }),

    commandCase("a command runs in the conversation it is given, with its arguments trimmed, and its text comes back", async (commands, conversation, _fixture, _app, ctx) => {
      const outcome = await runAgentCommand(commands, ECHO, conversation, "  two words  ", ctx);
      expect(outcome, { kind: "ran", text: `${conversation.key} ${conversation.conversationId} [two words]` }, "the probe command's outcome");
    }),

    commandCase("each command of the fixture runs in its conversation, its note a string when it has one", async (commands, conversation, fixture, app, ctx) => {
      for (const each of fixture.runs) {
        const outcome = await runAgentCommand(commands, each.name, conversation, each.args ?? "", ctx);
        if (outcome.kind !== "ran") throw new Error(`${GROUP}: /${each.name} ${each.args ?? ""}: expected it to run, got ${JSON.stringify(outcome)}`);
        check(outcome.text === undefined || (typeof outcome.text === "string" && outcome.text.trim() !== ""), `/${each.name}'s note to be a non-empty string or absent`);
        await each.check?.(outcome, conversation, app, ctx);
      }
    }),

    commandCase("a failing command is reported with its message, never thrown", async (commands, conversation, fixture, _app, ctx) => {
      expect(await runAgentCommand(commands, FAILS, conversation, "", ctx), { kind: "failed", message: "this command cannot run here" }, "the failing probe's outcome");
      for (const each of fixture.failures ?? []) {
        const outcome = await runAgentCommand(commands, each.name, conversation, each.args, ctx);
        check(outcome.kind === "failed" && outcome.message.trim() !== "", `/${each.name} ${each.args} to fail with a message (got ${JSON.stringify(outcome)})`);
      }
    }),

    commandCase("an unknown or malformed name is refused, and runs nothing", async (commands, conversation, _fixture, _app, ctx) => {
      for (const name of ["no-such-command", "Conformance-Echo", "/conformance-echo", "conformance echo", ""]) {
        expect(await runAgentCommand(commands, name, conversation, "", ctx), { kind: "unknown" }, `the outcome of "${name}"`);
      }
    }),
  ];
}
