/**
 * `agent.directory` conformance: what every provider guarantees to a runtime and a router that ask it
 * for agents by name (`../agent-directory.ts`). Runner-independent:
 *
 *   for (const c of createAgentDirectoryConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The contract only reads; how agents get in is the provider's (agents-live: its settings, an
 * operator's). The fixture's `put` is that way in: an operator replacing the directory's agents.
 */

import type { AppContext } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { AgentDirectory, DirectoryAgent } from "../agent-directory.ts";
import { defineAgent } from "../agent.ts";
import { checker, expecter } from "./assert.ts";

/** A provider under test, started, for one case. */
export interface AgentDirectoryFixture {
  directory: AgentDirectory;
  ctx: AppContext;
  /** Replaces every agent of the directory with `agents`, as an operator does; rejects, storing nothing, for agents it refuses. */
  put(agents: readonly DirectoryAgent[]): Promise<void>;
  /** A model the App's providers have (`provider/modelId`). */
  model: string;
  /** A tool the App has, when it has one. */
  tool?: string;
  /** The name of one of the App's `agent.definition`s: a directory never holds it. */
  definedAgent: string;
  dispose?(): Promise<void>;
}

const GROUP = "agent.directory";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** Whether `work` rejects. */
const rejects = async (work: Promise<unknown>): Promise<boolean> => {
  try {
    await work;
    return false;
  } catch {
    return true;
  }
};

export function createAgentDirectoryConformance(factory: () => AgentDirectoryFixture | Promise<AgentDirectoryFixture>): readonly ConformanceCase[] {
  const directoryCase = (name: string, run: (fixture: AgentDirectoryFixture, ctx: AppContext) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture, fixture.ctx);
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  const two = (fixture: AgentDirectoryFixture): DirectoryAgent[] => [
    {
      name: "support",
      description: "Answers customers",
      model: fixture.model,
      systemPrompt: "Be kind.",
      ...(fixture.tool !== undefined && { tools: [fixture.tool] }),
    },
    { name: "billing", model: fixture.model },
  ];

  return [
    directoryCase("an empty directory lists nothing, and has no agent of any name", async ({ directory }, ctx) => {
      expect(await directory.list(ctx), [], "list() of an empty directory");
      expect(await directory.get("support", ctx), undefined, "get() of a name nothing holds");
    }),

    directoryCase("list is every agent stored, by name; get is list's entry", async (fixture, ctx) => {
      const [support, billing] = two(fixture) as [DirectoryAgent, DirectoryAgent];
      await fixture.put([support, billing]);
      expect(await fixture.directory.list(ctx), [billing, support], "list() after storing two agents");
      expect(await fixture.directory.get("support", ctx), support, 'get("support")');
      expect(await fixture.directory.get("billing", ctx), billing, 'get("billing")');
      expect(await fixture.directory.get("nobody", ctx), undefined, 'get("nobody")');
    }),

    directoryCase("each agent listed is one defineAgent accepts", async (fixture, ctx) => {
      await fixture.put(two(fixture));
      for (const agent of await fixture.directory.list(ctx)) {
        let problem: string | undefined;
        try {
          defineAgent(agent);
        } catch (error) {
          problem = error instanceof Error ? error.message : String(error);
        }
        check(problem === undefined, `"${agent.name}" to be an agent defineAgent accepts (${problem})`);
      }
    }),

    directoryCase("a change replaces what was there: an agent left out is gone, a changed one reads changed", async (fixture, ctx) => {
      const [support, billing] = two(fixture) as [DirectoryAgent, DirectoryAgent];
      await fixture.put([support, billing]);
      const changed = { ...support, systemPrompt: "Be brief." };
      await fixture.put([changed]);
      expect(await fixture.directory.list(ctx), [changed], "list() after billing was taken out and support changed");
      expect(await fixture.directory.get("billing", ctx), undefined, 'get("billing") once taken out');
    }),

    directoryCase("an agent of the code's name, of a name no agent may have, or marked steward is refused, and nothing is stored", async (fixture, ctx) => {
      const [support] = two(fixture) as [DirectoryAgent];
      await fixture.put([support]);
      check(await rejects(fixture.put([support, { name: fixture.definedAgent, model: fixture.model }])), `storing an agent named "${fixture.definedAgent}", an agent.definition's name, to be refused`);
      check(await rejects(fixture.put([support, { name: "Not An Agent", model: fixture.model }])), "storing an agent named \"Not An Agent\" to be refused");
      check(await rejects(fixture.put([support, { name: "steward", model: fixture.model, steward: true } as DirectoryAgent])), "storing an agent marked steward to be refused: a live agent never is");
      expect(await fixture.directory.list(ctx), [support], "list() after the refusals");
      expect(await fixture.directory.get(fixture.definedAgent, ctx), undefined, "get() of the agent.definition's name");
    }),

    directoryCase("an answer is a copy: changing it changes nothing stored", async (fixture, ctx) => {
      const [support] = two(fixture) as [DirectoryAgent];
      await fixture.put([support]);
      const listed = await fixture.directory.list(ctx);
      (listed[0] as DirectoryAgent).systemPrompt = "Changed by a reader.";
      const got = await fixture.directory.get("support", ctx);
      if (got !== undefined) got.model = "changed/by-a-reader";
      expect(await fixture.directory.get("support", ctx), support, 'get("support") after changing earlier answers');
    }),
  ];
}
