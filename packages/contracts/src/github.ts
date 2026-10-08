/**
 * `github`: the project's own repository on GitHub, and a short-lived token for it (SPEC §6: the
 * agent proposes its changes as pull requests there, the operator approves them from the dashboard).
 * A provider connects it its own way (`github-app`: a GitHub App the operator creates and installs from
 * the dashboard, whose installation tokens the app mints itself); its consumers only ask:
 *
 *   const github = pikit.useOptional("github");
 *   // when used:
 *   const repository = await github.get()?.repository(ctx);   // "ana/my-bot", or undefined
 *   const token = await github.get().token(ctx);               // for that repository
 *
 * Consumers: admin-proposals (every GitHub call: reading, approving, rejecting), execution-do's `git`
 * (clone, push, pull request; the connected repository is one more it may push to), and
 * extension-pikit-self (tells the steward its repository). Without a provider each falls back to a
 * `GITHUB_TOKEN` secret and a repository it is configured with.
 *
 * What every provider guarantees:
 * - **`repository` is the connected one**, `owner/name` (`GITHUB_REPOSITORY`), or `undefined` while
 *   none is. It is read when asked: connecting, choosing another repository or disconnecting applies
 *   to the next call of every App of the deployment (within the provider's bound, a second).
 * - **`token` is for that repository**, with at least `GITHUB_TOKEN_MIN_LIFE_MS` left when it
 *   resolves: GitHub accepts it for its contents and pull requests (what the provider was granted).
 *   The same token may be answered again while it lasts. While no repository is connected, it rejects
 *   with `GitHubNotConnectedError` (`code: "not_connected"`), whose message says how to connect.
 * - **A token is a secret**: never in a log line, an error message, `describe()` or config. It is sent
 *   only to GitHub. A consumer keeps it in memory, and asks again rather than storing it.
 * - Any other rejection is the provider's: GitHub refused or did not answer, its storage failed. The
 *   message says which, never with a token.
 */

import type { AppContext } from "@pikit/core";

/** A repository's name on GitHub: `owner/name`. */
export const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** How long, at least, a token `token` answers still lasts: enough for a clone, a push, a merge. */
export const GITHUB_TOKEN_MIN_LIFE_MS = 5 * 60 * 1000;

/** `token` while no repository is connected: the message says how to connect it. */
export class GitHubNotConnectedError extends Error {
  readonly code = "not_connected";
  constructor(message = "GitHub is not connected") {
    super(message);
    this.name = "GitHubNotConnectedError";
  }
}

/** Whether `error` is `GitHubNotConnectedError`, also once it crossed a call (its `code`). */
export function isGitHubNotConnected(error: unknown): boolean {
  return error instanceof GitHubNotConnectedError || (error as { code?: unknown } | null)?.code === "not_connected";
}

export interface GitHubAccess {
  /** The connected repository, `owner/name`, or `undefined` while none is. */
  repository(ctx: AppContext): Promise<string | undefined>;
  /** A token for `repository()`, lasting at least `GITHUB_TOKEN_MIN_LIFE_MS`; `GitHubNotConnectedError` while none is connected. */
  token(ctx: AppContext): Promise<string>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    github: GitHubAccess;
  }
}
