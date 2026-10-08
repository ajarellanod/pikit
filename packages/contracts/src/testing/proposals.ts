/**
 * `proposals` conformance: what every provider guarantees to the dashboard's routes and to the
 * steward's guide (`../proposals.ts`). Runner-independent:
 *
 *   for (const c of createProposalsConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * Making a proposal is the fixture's (a branch pushed to a repository on this machine, a pull request
 * on a fake GitHub), and so is moving its head (the agent pushing again): the suite checks what every
 * provider then says and refuses. Approvals pass `override`: a provider whose checks run before an
 * approval is not asked to run them here.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger, type Target } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Operator } from "../admin.ts";
import type { Proposals } from "../proposals.ts";
import { checker, expecter } from "./assert.ts";

export interface ProposalsFixture {
  /** The components of an App that provides `proposals`, connected (its repository and credentials there). */
  components(): ComponentDefinition[];
  config?: Record<string, unknown>;
  /** Default `server`. */
  target?: Target;
  /**
   * Makes a proposal from the main branch: a branch `<prefix><topic>` whose one commit adds `file`
   * with `text`, titled `title`, described by `body`. Resolves with its id and head commit.
   */
  propose(input: { topic: string; title: string; body: string; file: string; text: string }): Promise<{ id: string; head: string }>;
  /** Moves proposal `id`'s branch to a new commit, as the agent pushing again; resolves with the new head. */
  pushAgain(id: string): Promise<string>;
  /** Makes a branch outside the prefix, which is never a proposal. */
  other(branch: string): Promise<void>;
  dispose?(): Promise<void>;
}

const GROUP = "proposals";
const expect = expecter(GROUP);
const check = checker(GROUP);
const OPERATOR: Operator = { id: "operator-1" };

interface Running {
  proposals: Proposals;
  ctx: AppContext;
  fixture: ProposalsFixture;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : `not a ProposalsError: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createProposalsConformance(factory: () => ProposalsFixture | Promise<ProposalsFixture>): readonly ConformanceCase[] {
  const proposalsCase = (name: string, run: (running: Running) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      let handle: Handle<Proposals> | undefined;
      const consumer = defineComponent({ name: "proposals-conformance", setup: (pikit) => void (handle = pikit.use("proposals")) });
      const app = await defineApp({
        components: [...fixture.components(), consumer],
        logger: silentLogger,
        ...(fixture.config !== undefined && { config: fixture.config }),
        ...(fixture.target !== undefined && { target: fixture.target }),
      }).create();
      try {
        await app.start();
        if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
        await run({ proposals: handle.get(), ctx: app.context(), fixture });
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });
  const stateOf = async ({ proposals, ctx }: Running, id: string) => (await proposals.list(ctx)).proposals.find((each) => each.id === id)?.state;

  return [
    proposalsCase("status says where proposals live and their prefix, part by part", async ({ proposals, ctx }) => {
      const status = await proposals.status(ctx);
      check(status.connected, "a connected fixture to be connected");
      check(status.where !== "" && status.branchPrefix !== "", "where and the prefix to be said");
      for (const part of status.checks) check(["ok", "missing", "failing", "unknown"].includes(part.state) && part.id !== "" && part.message !== "", `a check to have an id, a state and a message (${JSON.stringify(part)})`);
    }),

    proposalsCase("a proposal is listed open with its title, its branch under the prefix; another branch never is", async (running) => {
      const { proposals, ctx, fixture } = running;
      const made = await fixture.propose({ topic: "greeting", title: "Say hello", body: "Why: a warmer start.", file: "src/hello.ts", text: "export const hello = 1;\n" });
      await fixture.other("feature/not-a-proposal");
      const list = await proposals.list(ctx);
      const found = list.proposals.find((each) => each.id === made.id);
      check(found !== undefined, "the proposal to be listed");
      expect(found?.state, "open", "its state");
      expect(found?.title, "Say hello", "its title");
      check(found?.branch.startsWith(list.branchPrefix) === true, "its branch to be under the prefix");
      check(!list.proposals.some((each) => each.branch === "feature/not-a-proposal"), "a branch outside the prefix not to be listed");
      check(list.checksRun === "before-approval" || list.checksRun === "after-approval", "checksRun to be said");
    }),

    proposalsCase("get reads its description, its files with their patch and its head; anything else is not_found", async ({ proposals, ctx, fixture }) => {
      const made = await fixture.propose({ topic: "notes", title: "Add notes", body: "Adds a notes file.", file: "NOTES.md", text: "remember the milk\n" });
      const detail = await proposals.get(made.id, ctx);
      expect(detail.head, made.head, "its head");
      check(detail.body.includes("Adds a notes file."), "its description to hold the body");
      const file = detail.files.find((each) => each.path === "NOTES.md");
      check(file !== undefined && file.additions >= 1 && (file.patch ?? "").includes("+remember the milk"), "the file with its patch");
      expect(await codeOf(proposals.get("no-such-proposal", ctx)), "not_found", "get of nothing");
    }),

    proposalsCase("approve refuses a head that moved since it was read, and changes nothing", async (running) => {
      const { proposals, ctx, fixture } = running;
      const made = await fixture.propose({ topic: "moving", title: "Moving", body: "", file: "moving.txt", text: "one\n" });
      await fixture.pushAgain(made.id);
      const outcome = await proposals.approve(made.id, { head: made.head, override: true, operator: OPERATOR }, ctx);
      expect(outcome.ok ? "approved" : outcome.code, "moved", "approving a moved head");
      expect(await stateOf(running, made.id), "open", "its state after the refusal");
    }),

    proposalsCase("approve takes the head the operator read; acting on it again is not_open", async (running) => {
      const { proposals, ctx, fixture } = running;
      const made = await fixture.propose({ topic: "approved", title: "Approve me", body: "", file: "a.txt", text: "a\n" });
      const outcome = await proposals.approve(made.id, { head: made.head, override: true, operator: OPERATOR }, ctx);
      check(outcome.ok, `the approval to succeed (${JSON.stringify(outcome)})`);
      if (outcome.ok) expect(outcome.head, made.head, "the head approved");
      const state = await stateOf(running, made.id);
      check(state === "approved" || state === "merged", `its state to be approved or merged, not ${state}`);
      const again = await proposals.approve(made.id, { head: made.head, override: true, operator: OPERATOR }, ctx);
      expect(again.ok ? "approved" : again.code, "not_open", "approving it again");
      const reject = await proposals.reject(made.id, { operator: OPERATOR }, ctx);
      expect(reject.ok ? "rejected" : reject.code, "not_open", "rejecting it after");
    }),

    proposalsCase("reject closes it, and it can no longer be approved", async (running) => {
      const { proposals, ctx, fixture } = running;
      const made = await fixture.propose({ topic: "rejected", title: "Reject me", body: "", file: "r.txt", text: "r\n" });
      const outcome = await proposals.reject(made.id, { comment: "Not now.", operator: OPERATOR }, ctx);
      check(outcome.ok, `the rejection to succeed (${JSON.stringify(outcome)})`);
      expect(await stateOf(running, made.id), "closed", "its state after");
      const approve = await proposals.approve(made.id, { head: made.head, override: true, operator: OPERATOR }, ctx);
      expect(approve.ok ? "approved" : approve.code, "not_open", "approving it after");
    }),

    proposalsCase("approving or rejecting what is not a proposal is not_found", async ({ proposals, ctx }) => {
      const approve = await proposals.approve("no-such-proposal", { override: true, operator: OPERATOR }, ctx);
      expect(approve.ok ? "approved" : approve.code, "not_found", "approve");
      const reject = await proposals.reject("no-such-proposal", { operator: OPERATOR }, ctx);
      expect(reject.ok ? "rejected" : reject.code, "not_found", "reject");
    }),

    proposalsCase("remote says where the workspace clones from and pushes to, under the same prefix", async ({ proposals, ctx }) => {
      const remote = await proposals.remote(ctx);
      check(remote !== undefined, "a connected fixture to have a remote");
      const status = await proposals.status(ctx);
      expect(remote?.branchPrefix, status.branchPrefix, "the remote's prefix");
      check(remote?.kind === "path" ? remote.path !== "" : remote?.kind === "https" && remote.url.startsWith("https://"), "a path, or an https URL");
    }),
  ];
}
