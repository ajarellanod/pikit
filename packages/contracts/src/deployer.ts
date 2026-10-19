/**
 * `@pikit/contracts/deployer`: the files self-improvement's deployer and the app share on a server
 * (SPEC §6). The app's `proposals` provider (`proposals-local`) writes the operator's decisions; the
 * deployer next to the app (`deployment-docker`'s `deployer.ts`) reads them, deploys the approved heads,
 * and writes back what happened, which the provider reads. Both sides use these shapes; neither
 * imports the other.
 *
 * The deployer runs in an image with none of the project's packages, so it imports only the types
 * here (`import type`), and keeps its own copy of the file names: the protocol's suite
 * (`createDeployerProtocolConformance`) runs both sides against each other on these names.
 *
 * Both files are JSON in the shared directory (the app's `.pikit/self`). A reader takes a file it
 * cannot read or parse as empty; nothing else validates them.
 */

import type { DeployRecord, ProposalDeploy } from "./proposals.ts";

export type { DeployRecord };

/** The operator's decisions, newest first: `{ "decisions": Decision[] }`. Written by the app, read by the deployer. */
export const DECISIONS_FILE = "decisions.json";
/** What the deployer did (`DeployerState`). Written by the deployer, read by the app. */
export const DEPLOYER_STATE_FILE = "deployer.json";

/** An operator's decision on a proposal's head. The deployer deploys `head`, of `branch`, only when `approved`. */
export interface Decision {
  /** The proposal's id (its branch's topic). */
  id: string;
  branch: string;
  /** The commit the operator read and decided on: the deployer deploys this one, never what the branch holds later. */
  head: string;
  decision: "approved" | "rejected";
  /** The operator's id. */
  operator: string;
  /** ISO 8601. */
  at: string;
  /** The head commit's subject. */
  title: string;
  /** The operator's comment, with a rejection. */
  comment?: string;
}

/** A step the deployer ran on an approved head; the provider shows them as the proposal's checks. */
export interface DeployerCheck {
  name: string;
  state: "passing" | "failing" | "pending" | "skipped";
  detail: string;
}

/** What happened to one approved head (`ProposalDeploy`), with the decision's id and the steps run. */
export interface Outcome extends ProposalDeploy {
  id?: string;
  checks?: DeployerCheck[];
}

/** `deployer.json`. */
export interface DeployerState {
  startedAt?: string;
  /** ISO 8601: written on every poll; the app takes the deployer as running while it is recent. */
  heartbeatAt?: string;
  /** Whether the project's checkout can be deployed from, and why not. */
  project?: { ok: boolean; message: string };
  /** The id of the proposal being deployed now. */
  deploying?: string;
  /** Each approved head's outcome, by head commit. */
  outcomes?: Record<string, Outcome>;
  lastDeploy?: DeployRecord;
  lastRollback?: DeployRecord;
  lastFailure?: DeployRecord;
}
