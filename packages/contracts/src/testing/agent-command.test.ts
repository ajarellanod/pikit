// The agent.command suite catches commands that break the contract (admin-api's and runtime-pi's own
// tests run it on theirs): a malformed one, one that fails what it should do, one that does not fail.

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ConversationRef } from "../agent.ts";
import { type AgentCommand, listAgentCommands, runAgentCommand } from "../command.ts";
import { createAgentCommandConformance } from "./agent-command.ts";

const CONVERSATION: ConversationRef = { key: "test:1", agent: "assistant", conversationId: "c1" };

/** A `rename` command over `titles`, with the given flaws. */
function commands(titles: Map<string, string>, flaws: { badDescription?: boolean; neverFails?: boolean; alwaysFails?: boolean } = {}) {
  return defineComponent({
    name: "commands-test",
    setup(pikit) {
      const rename: AgentCommand = {
        description: flaws.badDescription === true ? "Two\nlines" : "Names the conversation",
        argumentHint: "<title>",
        async run(conversation, args) {
          if (flaws.alwaysFails === true || (args === "" && flaws.neverFails !== true)) throw new Error("Write the title: /rename <title>");
          titles.set(conversation.key, args);
          return { text: `Named "${args}".` };
        },
      };
      pikit.provideKeyed("agent.command", "rename", rename);
    },
  });
}

async function failing(flaws: Parameters<typeof commands>[1]): Promise<string[]> {
  const failed: string[] = [];
  for (const c of createAgentCommandConformance(() => {
    const titles = new Map<string, string>();
    return {
      components: [commands(titles, flaws)],
      conversation: async () => CONVERSATION,
      runs: [
        {
          name: "rename",
          args: "Lisbon trip",
          check: async (outcome, conversation) => {
            if (titles.get(conversation.key) !== "Lisbon trip" || outcome.text !== 'Named "Lisbon trip".') throw new Error("not renamed");
          },
        },
      ],
      failures: [{ name: "rename", args: "" }],
    };
  })) {
    await c.run().catch(() => failed.push(c.name));
  }
  return failed;
}

test("a correct provider passes every case", async () => {
  expect(await failing({})).toEqual([]);
});

test("a command with a description of two lines is caught", async () => {
  expect(await failing({ badDescription: true })).toEqual([
    "every command is provided under a command name, with a one-line description, and listed",
    "each command of the fixture runs in its conversation, its note a string when it has one",
    "a failing command is reported with its message, never thrown",
  ]);
});

test("a command that does not do what it is asked, or does not refuse what it cannot do, is caught", async () => {
  expect(await failing({ alwaysFails: true })).toEqual(["each command of the fixture runs in its conversation, its note a string when it has one"]);
  expect(await failing({ neverFails: true })).toEqual(["a failing command is reported with its message, never thrown"]);
});

test("runAgentCommand: the note, a failure's message, an unknown name; listAgentCommands leaves a malformed one out", async () => {
  const good: AgentCommand = { description: "Good", run: async (_c, args) => ({ text: args }) };
  const quiet: AgentCommand = { description: "Quiet", run: async () => undefined };
  const odd: AgentCommand = { description: "Odd", run: async () => ({ text: 42 }) as never };
  const thrower: AgentCommand = { description: "Throws", run: async () => Promise.reject("plain") };
  const all = new Map<string, AgentCommand>([["good", good], ["quiet", quiet], ["odd", odd], ["throws", thrower], ["Bad", good], ["empty", { description: "", run: good.run }]]);
  const lookup = { keys: () => [...all.keys()], get: (name: string) => all.get(name) };
  const context = (await defineApp({ components: [], logger: silentLogger }).create()).context();

  expect(await runAgentCommand(lookup, "good", CONVERSATION, "  hi  ", context)).toEqual({ kind: "ran", text: "hi" });
  expect(await runAgentCommand(lookup, "good", CONVERSATION, "   ", context)).toEqual({ kind: "ran" });
  expect(await runAgentCommand(lookup, "quiet", CONVERSATION, "", context)).toEqual({ kind: "ran" });
  expect(await runAgentCommand(lookup, "odd", CONVERSATION, "", context)).toEqual({ kind: "ran" });
  expect(await runAgentCommand(lookup, "throws", CONVERSATION, "", context)).toEqual({ kind: "failed", message: "plain" });
  expect(await runAgentCommand(lookup, "Bad", CONVERSATION, "", context)).toEqual({ kind: "unknown" });
  expect(await runAgentCommand(lookup, "empty", CONVERSATION, "", context)).toEqual({ kind: "unknown" });
  expect(listAgentCommands(lookup).map((each) => each.name)).toEqual(["good", "odd", "quiet", "throws"]);
});
