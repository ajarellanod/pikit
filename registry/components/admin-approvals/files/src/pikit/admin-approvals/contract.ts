/**
 * The `approvals` capability: exact actions waiting for a person's approval, recorded by trusted code.
 * Declared by `approvals-sql` (its `component.json`); every component that uses it carries an identical
 * copy of this file (a component never imports another's files; `tsc` refuses copies that differ).
 *
 * - **An approval is one exact action** (`{ type, payload }`), immutable once proposed, identified by
 *   its `actionHash` (`actionHash`: SHA-256 of its canonical JSON). `propose` is idempotent by
 *   `idempotencyKey`: the same key and action give the same approval; the same key with another action
 *   is refused (`code: "conflict"`). A malformed request is refused (`code: "invalid"`), and so is one
 *   with no approvers.
 * - **Who may decide is the proposer's policy, held by the store**: `approvers` are patterns
 *   `<channel>:<id>` or `<channel>:*`, matched against the deciding `Sender`; anyone else is
 *   `forbidden` and nothing is recorded. A decision is taken once: the same verdict again is answered
 *   `ok` with the approval as it is (a redelivered answer), the other verdict `not_pending`.
 * - **Expiry** is read with the clock of the App that owns the approvals, never by a timer: a pending or
 *   approved approval whose `expiresAt` has passed is `expired`, and can be neither decided nor claimed.
 * - **An approved action runs at most once**: `claim` takes one approved, unexpired, unclaimed approval
 *   of that hash, proposed from that conversation, for one `claimant` (a tool call); the same claimant
 *   asking again gets the same approval (a hook that runs again after a crash), any other gets none.
 *   `settle` records what became of it, once, by its claimant.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationRef, JsonValue, Sender } from "@pikit/contracts";

/** What is approved: a kind (`tool:bash`) and its exact arguments. */
export type ApprovalAction = { type: string; payload: JsonValue };

/** What a component asks a person to approve. Types, not interfaces: it crosses `actor.mailbox` as JSON. */
export type ApprovalRequest = {
  /** The same key again (a replayed tool call) is the same approval. */
  idempotencyKey: string;
  action: ApprovalAction;
  /** One line a person reads. */
  title: string;
  /** Why, for the person who decides. */
  summary?: string;
  /**
   * Who may decide: the whole sender `<channel>:<id>`, or `<channel>:*` for anyone on exactly that channel
   * (`telegram:12345`, `telegram:ops:12345`, `dashboard:*`). A channel instance (`telegram:ops`) is a
   * channel of its own: `telegram:*` does not cover it. One or more.
   */
  approvers: string[];
  /** The conversation that asked (where the action may be claimed), and who it was answering. */
  requestedBy: { conversation: ConversationRef; sender?: Sender };
  /** Epoch ms, by the owning App's clock; absent: never expires. */
  expiresAt?: number;
};

/** `expired` is read, never stored: a pending or approved approval past its `expiresAt`. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "claimed" | "executed" | "failed";

export type Approval = ApprovalRequest & {
  id: string;
  actionHash: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedBy?: Sender;
  decidedAt?: number;
  claimedBy?: string;
  claimedAt?: number;
  settledAt?: number;
  /** What `settle` said of a failure. */
  detail?: string;
};

export type ApprovalVerdict = "approve" | "reject";

export type DecideOutcome = { ok: true; approval: Approval } | { ok: false; code: "not_found" | "not_pending" | "expired" | "forbidden" };

/** Newest first; `next` is the cursor of the following page, absent on the last. */
export type ApprovalPage = { items: Approval[]; next?: string };

export interface ApprovalStore {
  propose(request: ApprovalRequest, ctx: AppContext): Promise<Approval>;
  list(query: { status?: ApprovalStatus; cursor?: string; limit?: number }, ctx: AppContext): Promise<ApprovalPage>;
  decide(id: string, decision: { verdict: ApprovalVerdict; by: Sender }, ctx: AppContext): Promise<DecideOutcome>;
  /** The approval `claimant` now holds for this action and conversation, or `undefined`: refuse the action. */
  claim(claim: { actionHash: string; conversationId: string; claimant: string }, ctx: AppContext): Promise<Approval | undefined>;
  /** Records what became of the claimed action; `undefined` when `claimant` holds none. */
  settle(claimant: string, outcome: { kind: "executed" | "failed"; detail?: string }, ctx: AppContext): Promise<Approval | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    approvals: ApprovalStore;
  }
}

/** `value` as JSON with every object's keys sorted, `undefined` properties left out: the same text for the same value. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item: JsonValue) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as { readonly [key: string]: JsonValue };
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The action's identity: SHA-256 (Web Crypto) of the canonical JSON of `{ type, payload }`, in hex. */
export async function actionHash(action: ApprovalAction): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ type: action.type, payload: action.payload })));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
