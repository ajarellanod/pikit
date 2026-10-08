/**
 * How proposals-github reaches GitHub, in one place: which repository, and with which tokens. The rest
 * of the component asks this module and nothing else, so changing where access comes from (a
 * `github` contract: a GitHub App, a token) changes this file only.
 *
 * Today:
 * - **The repository** is a setting (`settings`, when a provider is installed: the dashboard's Settings
 *   → Self-improvement on GitHub), whose default is the config's `repository`, read at each call.
 * - **Two tokens, secrets read through `secrets`:** `tokenSecret` (`GITHUB_TOKEN`, the agent's own in
 *   execution-do) reads and opens pull requests; `mergeTokenSecret` (`PIKIT_MERGE_TOKEN`) merges,
 *   comments and closes, and is read only by approve and reject. The same secret name for both is
 *   refused at setup.
 */

import type { AppContext, Pikit } from "@pikit/core";
import Type from "typebox";

const NAME = "proposals-github";
/** `owner/name`, or empty: not connected. */
export const REPOSITORY = "^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?$";

/** Its settings: the repository, changed live from the dashboard's Settings → Self-improvement on GitHub. */
export type GitHubProposalsSettings = { repository: string };

const SettingsSchema = Type.Object(
  {
    repository: Type.String({
      pattern: REPOSITORY,
      title: "Repository",
      description: "The project's repository on GitHub, owner/name: where the agent pushes its branches and its pull requests are opened. Empty: self-improvement is off.",
    }),
  },
  { additionalProperties: false },
);

export interface GitHubAccessConfig {
  repository: string;
  tokenSecret: string;
  mergeTokenSecret: string;
}

export interface GitHubAccess {
  /** `owner/name` now; empty while none is set. */
  repository(ctx: AppContext): Promise<string>;
  /** The token that reads and opens pull requests; `undefined` while it is not set. */
  readToken(): Promise<string | undefined>;
  /** The token that merges, comments and closes; `undefined` while it is not set. */
  mergeToken(): Promise<string | undefined>;
  /** What each token is called in messages (a secret's name, never its value). */
  readonly readName: string;
  readonly mergeName: string;
  start(): void;
  stop(): void;
}

/** Called in `setup`: it declares what it uses (`secrets`, and `settings` if installed). */
export function createGitHubAccess(pikit: Pikit, config: GitHubAccessConfig): GitHubAccess {
  if (config.tokenSecret === config.mergeTokenSecret) {
    throw new Error(`proposals-github: mergeTokenSecret must name another secret than tokenSecret (both are ${config.tokenSecret}): the merge token is never the agent's`);
  }
  const secrets = pikit.use("secrets");
  const settings = pikit.useOptional("settings");
  let declared = false;
  const secret = async (name: string) => {
    const value = await secrets.get().get(name);
    return value === undefined || value === "" ? undefined : value;
  };
  return {
    async repository(ctx) {
      const store = settings.get();
      if (store === undefined || !declared) return config.repository;
      try {
        return (await store.get<GitHubProposalsSettings>(NAME, ctx)).repository;
      } catch (error) {
        ctx.logger.warn("proposals-github: its settings could not be read; the config's repository applies", { error: error instanceof Error ? error.message : String(error) });
        return config.repository;
      }
    },
    readToken: () => secret(config.tokenSecret),
    mergeToken: () => secret(config.mergeTokenSecret),
    readName: config.tokenSecret,
    mergeName: config.mergeTokenSecret,
    start() {
      const store = settings.get();
      if (store === undefined) return;
      store.declare(NAME, SettingsSchema, { repository: config.repository });
      declared = true;
    },
    stop() {
      declared = false;
    },
  };
}
