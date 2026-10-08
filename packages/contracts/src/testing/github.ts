/**
 * `github` conformance: what every provider guarantees to the components that ask it for the project's
 * repository and a token (`../github.ts`). Runner-independent:
 *
 *   for (const c of createGitHubConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture connects and disconnects a repository its own way (a fake GitHub behind the provider's
 * own path), and says whether its GitHub accepts a token for a repository. A case starts an App of the
 * fixture's components and a consumer that reads `github`, as admin-proposals does.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, type Logger, type Target } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { GITHUB_REPOSITORY, type GitHubAccess, isGitHubNotConnected } from "../github.ts";
import { checker, expecter } from "./assert.ts";

/** A provider under test, over one case's storage and GitHub. */
export interface GitHubFixture {
  /** The components of one App: the provider and what it needs. `logger` is the App's. */
  components(logger: Logger): ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The App's target; default `server`. */
  target?: Target;
  /** Connects `repository` (`owner/name`) the provider's own way, `ctx` the App's. */
  connect(repository: string, ctx: AppContext): Promise<void>;
  /** Disconnects it. */
  disconnect(ctx: AppContext): Promise<void>;
  /** Whether the fixture's GitHub accepts `token` for `repository` now. */
  accepts(token: string, repository: string): Promise<boolean>;
  /** How long the provider keeps an answer before asking again (ms); default 0. */
  freshMs?: number;
  dispose?(): Promise<void>;
}

const GROUP = "github";
const expect = expecter(GROUP);
const check = checker(GROUP);

const REPOSITORY = "ana/conformance-bot";
const OTHER = "ana/other-bot";

type Line = { level: string; message: string; fields?: Record<string, unknown> };

interface Running {
  github: GitHubAccess;
  ctx: AppContext;
  lines: Line[];
  stop(): Promise<void>;
}

async function boot(fixture: GitHubFixture): Promise<Running> {
  const lines: Line[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void lines.push({ level, message, ...(fields !== undefined && { fields }) });
  const logger: Logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
  let handle: Handle<GitHubAccess> | undefined;
  const consumer = defineComponent({ name: "github-conformance", setup: (pikit) => void (handle = pikit.use("github")) });
  const app = await defineApp({
    components: [...fixture.components(logger), consumer],
    logger,
    ...(fixture.config !== undefined && { config: fixture.config }),
    ...(fixture.target !== undefined && { target: fixture.target }),
  }).create();
  await app.start();
  if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
  return { github: handle.get(), ctx: app.context(), lines, stop: () => app.stop() };
}

/** `work`'s rejection, or `undefined` when it resolved. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error ?? new Error("rejected with nothing");
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGitHubConformance(factory: () => GitHubFixture | Promise<GitHubFixture>): readonly ConformanceCase[] {
  const githubCase = (name: string, run: (fixture: GitHubFixture, app: Running) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const app = await boot(fixture);
      try {
        await run(fixture, app);
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });
  /** Past the provider's bound: the next call asks again. */
  const settle = (fixture: GitHubFixture) => wait((fixture.freshMs ?? 0) + 10);

  return [
    githubCase("not connected: no repository, and token rejects not_connected saying how to connect", async (_fixture, { github, ctx }) => {
      expect(await github.repository(ctx), undefined, "repository() before connecting");
      const error = await rejection(github.token(ctx));
      check(isGitHubNotConnected(error), `token() to reject with not_connected, not ${String(error)}`);
      check(error instanceof Error && error.message.trim() !== "", "the rejection to say how to connect");
    }),

    githubCase("connected: the repository is owner/name, and its token is one GitHub accepts for it", async (fixture, { github, ctx }) => {
      await fixture.connect(REPOSITORY, ctx);
      await settle(fixture);
      const repository = await github.repository(ctx);
      expect(repository, REPOSITORY, "repository() once connected");
      check(GITHUB_REPOSITORY.test(repository ?? ""), "the repository to be owner/name");
      const token = await github.token(ctx);
      check(typeof token === "string" && token !== "", "token() to be a non-empty string");
      check(await fixture.accepts(token, REPOSITORY), "GitHub to accept the token for the repository");
    }),

    githubCase("a change applies to the next call: another repository, then disconnected", async (fixture, { github, ctx }) => {
      await fixture.connect(REPOSITORY, ctx);
      await settle(fixture);
      await github.token(ctx);
      await fixture.connect(OTHER, ctx);
      await settle(fixture);
      expect(await github.repository(ctx), OTHER, "repository() after connecting another");
      check(await fixture.accepts(await github.token(ctx), OTHER), "the token to be for the other repository");
      await fixture.disconnect(ctx);
      await settle(fixture);
      expect(await github.repository(ctx), undefined, "repository() after disconnecting");
      check(isGitHubNotConnected(await rejection(github.token(ctx))), "token() to reject with not_connected after disconnecting");
    }),

    githubCase("no token in a log line or an error", async (fixture, { github, ctx, lines }) => {
      await fixture.connect(REPOSITORY, ctx);
      await settle(fixture);
      const token = await github.token(ctx);
      await github.token(ctx);
      await fixture.disconnect(ctx);
      await settle(fixture);
      const error = await rejection(github.token(ctx));
      const seen = JSON.stringify(lines) + (error instanceof Error ? error.message : String(error));
      check(!seen.includes(token), "the token never to appear in the App's log lines or the error");
    }),
  ];
}
