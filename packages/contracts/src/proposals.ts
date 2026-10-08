/**
 * `proposals`: the agent's changes to itself, waiting for an operator (SPEC §6,
 * features/self-improvement.md). The steward proposes a change the same way whatever the provider: it
 * clones the project from `remote()`, commits on a branch under the prefix (`pikit/self/<topic>`) and
 * pushes it there (its head commit's first line the title, the rest the description). An operator
 * reads it (its description, its diff, its checks) and approves or rejects it; an approved one is
 * deployed. Where the repository is, what approving does and how the deploy follows are the
 * provider's: a pull request on GitHub, opened by the provider for the pushed branch and merged through
 * GitHub's API (`proposals-github`, on Cloudflare), or a branch of a repository on the server that the
 * deployer next to the app merges, checks and deploys (`proposals-local`). Providers are
 * interchangeable: the steward, the dashboard and the steward's guide do not change with one.
 *
 *   const proposals = pikit.use("proposals");
 *   const { proposals: open } = await proposals.get().list(ctx);
 *   const outcome = await proposals.get().approve(id, { head, operator }, ctx);
 *
 * Its readers are the dashboard's routes (`admin-proposals`) and the steward's guide
 * (`extension-pikit-self`, through `remote`); the steward's workspace may use `remote` too, so no
 * `execution-*` knows where proposals go.
 *
 * What every provider guarantees:
 * - **Only proposals.** A branch outside the prefix, or anything that is not the project's own
 *   (a fork's pull request), is never listed, read, approved or rejected: reading one is
 *   `ProposalsError("not_found")`, acting on one the outcome `not_found`.
 * - **An id is the branch's topic** (`pikit/self/<topic>` → `<topic>`), on every provider.
 * - **An action is refused, as an outcome, before anything is written**: `not_found`, `not_open` (it
 *   was approved, merged or rejected already), `moved` (the branch's head is not the `head` the
 *   operator read), `checks_failing` (checks that run before an approval fail, run or never ran,
 *   unless `override`), `wrong_base`, `not_mergeable`. A refusal changes nothing.
 * - **An approval is the head the operator read**, and is recorded with the operator. A rejection
 *   closes the proposal, never deletes what the agent wrote without a trace.
 * - **Failures to reach where proposals live are `ProposalsError`**, typed (`not_connected` when it
 *   is not set up yet, `unavailable`, `rate_limited` with `retryAfter`…), with an HTTP status to
 *   answer and a message that names a secret, never holds one.
 * - **`status` never throws for a missing part**: it says what is missing, part by part.
 */

import type { AppContext } from "@pikit/core";
import type { Operator } from "./admin.ts";

/**
 * Where a proposal is: `open`; `approved` (the deploy is waiting or running); `merged` (approved,
 * and in the main branch: deployed, or deploying where the platform deploys merges); `failed` (approved,
 * and its deploy failed: not in the main branch); `closed` (rejected).
 */
export type ProposalState = "open" | "approved" | "merged" | "failed" | "closed";

/** One check of a proposal's head: a CI check run, a commit status, or a step the deployer ran. */
export interface ProposalCheck {
  name: string;
  state: "passing" | "failing" | "pending" | "skipped";
  /** What it said (`failure`, `in_progress`, `bun test exited with code 1`…). */
  detail: string;
  url?: string;
}

/** Every check, summed up: `failing` when one fails, else `pending` while one runs, else `passing` when one passed, else `none`. */
export interface ProposalChecks {
  state: "passing" | "failing" | "pending" | "none";
  passed: number;
  failed: number;
  pending: number;
  items: ProposalCheck[];
}

/** What happened to an approved proposal's deploy, when the provider knows (the deployer's record). */
export interface ProposalDeploy {
  /** `waiting` (not picked yet, or held: the message says why), `deploying`, `deployed`, `rolled back` (unhealthy), `failed` (refused, a conflict, a check failed). */
  outcome: "waiting" | "deploying" | "deployed" | "rolled back" | "failed";
  message: string;
  /** ISO 8601. */
  at: string;
}

export interface ProposalSummary {
  /** The branch's topic: `pikit/self/<topic>` → `<topic>`. */
  id: string;
  /** The pull request's number, where proposals are pull requests. */
  number?: number;
  title: string;
  /** Who proposed it (the agent's account, or its commits' author). */
  author: string;
  /** The branch, under the prefix. */
  branch: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  state: ProposalState;
  draft: boolean;
  /** Its head's checks, when read. */
  checks?: ProposalChecks;
  /** Where it is read elsewhere (the pull request on GitHub). */
  url?: string;
  /** A preview of the change when one is found (a Workers Builds preview). */
  previewUrl?: string;
  deploy?: ProposalDeploy;
}

/** `list`: where proposals are, then the open ones, then the recently closed ones, newest first. */
export interface ProposalList {
  /** Where they live, in words: `ana/bot on GitHub`, `this server's proposals repository`. */
  where: string;
  /** A page listing them elsewhere, when there is one. */
  url?: string;
  branchPrefix: string;
  /** Whether checks run on a proposal before it is approved (CI), or after (the deployer, before it deploys). */
  checksRun: "before-approval" | "after-approval";
  proposals: ProposalSummary[];
}

/** One changed file; `patch` cut at the provider's bound. */
export interface ProposalFile {
  path: string;
  /** `added`, `removed`, `modified`, `renamed`… */
  status: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  /** The unified diff's hunks; absent for a binary file, or past the bound. */
  patch?: string;
  /** Whether `patch` was cut or left out by the bound. */
  truncated: boolean;
}

/** `get`. */
export interface ProposalDetail extends ProposalSummary {
  /** The agent's description (markdown). */
  body: string;
  /** The branch it goes into, and the main branch: an approval needs them equal. */
  base: string;
  defaultBranch: string;
  /** The head commit: an approval sends it back. */
  head: string;
  /** Whether it merges cleanly; `null` while unknown. */
  mergeable: boolean | null;
  /** The provider's word for it (`clean`, `dirty`, `unknown`…). */
  mergeableState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The first files, bounded. */
  files: ProposalFile[];
  checks: ProposalChecks;
  checksRun: ProposalList["checksRun"];
}

export interface ApproveRequest {
  /** The head commit the operator read: `moved` when the branch moved since. */
  head?: string;
  /** Approve although the checks that run before an approval do not pass. */
  override?: boolean;
  operator: Operator;
}

export interface RejectRequest {
  /** Left for the agent to read (markdown). */
  comment?: string;
  operator: Operator;
}

export type ActionRefusal = "not_found" | "not_open" | "moved" | "checks_failing" | "wrong_base" | "not_mergeable";

export type ApproveOutcome =
  | {
      ok: true;
      id: string;
      /** The commit approved. */
      head: string;
      /** Whether it is in the main branch now (GitHub's merge), or waits for a deployer that merges it. */
      merged: boolean;
      /** What happens next, for the operator. */
      message: string;
    }
  | { ok: false; code: ActionRefusal; message: string };

export type RejectOutcome = { ok: true; id: string; message: string } | { ok: false; code: ActionRefusal; message: string };

/** One part of the setup, as `status` checks it. */
export interface ProposalsCheck {
  /** Stable: `repository`, `readToken`, `deployer`… */
  id: string;
  label: string;
  /** `ok`; `missing` (not set up yet); `failing` (set up, and wrong); `unknown` (not checked). */
  state: "ok" | "missing" | "failing" | "unknown";
  /** What was found, or what to do: names a secret, never holds one. */
  message: string;
}

/** A deploy the provider knows of (the deployer's last one, its last rollback). */
export interface DeployRecord {
  /** The commit. */
  head: string;
  /** The proposal's id, when it came from one. */
  id?: string;
  message: string;
  at: string;
}

/** `status`: whether proposals can be made and approved now, part by part. */
export interface ProposalsStatus {
  connected: boolean;
  where: string;
  branchPrefix: string;
  checks: ProposalsCheck[];
  /** The deploys that follow approvals, when the provider runs or reads them. */
  deploys?: {
    lastDeploy?: DeployRecord;
    lastRollback?: DeployRecord;
    lastFailure?: DeployRecord;
    /** A proposal being deployed now. */
    deploying?: string;
  };
}

/**
 * Where the steward's workspace clones the project from and pushes its branches to: on every target
 * the steward proposes the same way, `git push origin <prefix><topic>`, and the provider turns the
 * pushed branch into a proposal (it lists it, or opens its pull request). Trusted code applies
 * `authorization`; the agent never sees what it returns.
 */
export type ProposalsRemote =
  | {
      /** A repository on this machine, which plain git reaches by its path: no credential. */
      kind: "path";
      path: string;
      mainBranch: string;
      branchPrefix: string;
    }
  | {
      kind: "https";
      /** The repository's clone URL. */
      url: string;
      mainBranch: string;
      branchPrefix: string;
      /** The `Authorization` header git's requests carry, read when needed; `undefined` without one. */
      authorization(): Promise<string | undefined>;
    };

export type ProposalsErrorCode =
  | "not_found"
  | "not_connected"
  | "not_configured"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "missing_repository"
  | "unavailable"
  | "refused";

/** A failure to read or reach where proposals live. `status` is the HTTP status a route answers with. */
export class ProposalsError extends Error {
  readonly code: ProposalsErrorCode;
  readonly status: number;
  readonly retryAfter: number | undefined;
  constructor(code: ProposalsErrorCode, status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "ProposalsError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface Proposals {
  status(ctx: AppContext): Promise<ProposalsStatus>;
  list(ctx: AppContext): Promise<ProposalList>;
  /** Throws `ProposalsError("not_found")` for anything that is not a proposal. */
  get(id: string, ctx: AppContext): Promise<ProposalDetail>;
  approve(id: string, request: ApproveRequest, ctx: AppContext): Promise<ApproveOutcome>;
  reject(id: string, request: RejectRequest, ctx: AppContext): Promise<RejectOutcome>;
  /** Where the workspace clones from and pushes to; `undefined` while it is not connected. */
  remote(ctx: AppContext): Promise<ProposalsRemote | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    proposals: Proposals;
  }
}
