# approvals-sql

Approvals of exact actions, recorded by code: an action (`{ type, payload }`) waits for a person the
proposer named to approve or reject it, and an approved action is claimed at most once by the call
that runs it. It declares the kind `approvals` and the capability `approvals`; its type and protocol
are `contract.ts`, which every component that uses `approvals` carries as an identical copy.

- **Provides:** `approvals` (declared here).
- **Requires:** `storage.sql`, `actor.mailbox`, `actor.inbox` (on a server: storage-sqlite and
  mailbox-local).
- **Targets:** `server`. Every operation already goes through one actor (below), the path a Durable
  Object would take on Cloudflare, but that is not tested yet.
- **Installs to:** `src/pikit/approvals-sql/` (`index.ts`, `contract.ts`, `conformance.ts`, its test).

## The contract (`contract.ts`)

```ts
interface ApprovalStore {
  propose(request, ctx): Promise<Approval>;   // idempotent by request.idempotencyKey
  list({ status?, cursor?, limit? }, ctx): Promise<{ items: Approval[]; next?: string }>;  // newest first
  decide(id, { verdict: "approve" | "reject", by: Sender }, ctx): Promise<DecideOutcome>;
  claim({ actionHash, conversationId, claimant }, ctx): Promise<Approval | undefined>;
  settle(claimant, { kind: "executed" | "failed", detail? }, ctx): Promise<Approval | undefined>;
}
```

Guarantees, each enforced here and checked by the suite (`conformance.ts`):
- **One exact action per approval.** Its `actionHash` is SHA-256 of the canonical JSON of
  `{ type, payload }` (`actionHash`, `canonicalJson`: sorted keys, Web Crypto). The same
  `idempotencyKey` and action give the same approval; the same key with another action is refused
  (`code: "conflict"`); a malformed request or one with no approvers is refused (`code: "invalid"`).
- **Who decides is the proposer's policy, held here.** `approvers` are the whole sender
  `<channel>:<id>`, or `<channel>:*` for anyone on exactly that channel. A channel instance
  (`telegram:ops`) is a channel of its own: `telegram:ops:12345` and `telegram:ops:*` name its
  senders, `telegram:*` does not. A `Sender` that matches none is `forbidden`, and nothing is recorded. A decision is
  taken once: the same verdict again answers `ok` unchanged (an answer delivered twice), the other one
  `not_pending`; an unknown id is `not_found`.
- **Expiry is read, never timed**: a pending or approved approval past `expiresAt` (the owning App's
  clock) reads `expired` and can be neither decided (`expired`) nor claimed.
- **At most once.** `claim` takes, in one transaction, one approved, unexpired, unclaimed approval of
  that hash proposed from that conversation; the same `claimant` again gets the same one (a hook run
  again after a crash), anyone else none. `settle` records the outcome once, by the claimant.

## How it works
- One owner: the actor `approvals-sql:approvals`. Every method is
  `actor.mailbox.call(APPROVALS_KEY, "approvals-sql.<op>", …)`, answered by the handlers it registers
  with `actor.inbox` in `start`; a call that reaches another key is refused (`invalid`). On a server
  that actor is the App itself.
- One table, `approvals_sql`, created in `start`: the action, its hash, the approvers, who asked, and
  the state (`pending` → `approved` | `rejected`, `approved` → `claimed` → `executed` | `failed`).
  `idempotency_key` and `claimed_by` are unique columns. Nothing is kept in memory.

## Tests
`approvals-sql.test.ts` runs the `approvals` suite over SQLite and the in-memory mailbox: idempotent
proposals and conflicts, invalid requests, decisions once, strangers forbidden (`<channel>:*` included, channel instances apart),
not found, expiry, claims once (same claimant, another claimant, another conversation, other
arguments, a rejected one, four claimants at once), settle once, a restart, pages and statuses. Plus
what setup declares, the owner-only key and `isApprover`. Each guarantee was checked to fail on a
provider broken on purpose (the approvers check, the unclaimed condition) and pass once restored.
Not covered: a `storage.sql` other than SQLite, and Cloudflare.
