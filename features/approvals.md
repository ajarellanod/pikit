# Approvals

**Public appeal:** ⭐ The agent asks a person before a risky action and waits for the answer in the
chat. Hermes has command approval; OpenClaw approves requests from the chat or its CLI.

**Specified:** partly (moved from the former SPEC §18; the former §4.5 named the `approvals`
capability)

**Needed by:** nothing required directly. Self-improvement needs a human's approval of every
self-change (SPEC §6); whether that approval is this component or the git host's review is open
below. The dashboard answers approvals only when this exists (SPEC §5).

## What it gives
A decision the agent cannot take alone is recorded, shown to a person where they can answer it, and
resumed when they answer, minutes or days later, across restarts and deploys. The lifecycle is
deterministic: proposed → approved/rejected → executed → verified, with reminders, escalation when
it stalls, and expiry.

## How it fits pikit
- Components: `approvals-sql` on `storage.sql` (server) and `approvals-workflows` on Cloudflare
  Workflows, which the former SPEC §9.2 named for "anything that waits > 15 min" (an alarm gets 15
  minutes of wall clock, C4). The kind `approvals` is new: a naming decision (`KINDS` in
  `packages/cli/src/registry/checks.ts`).
- Capability `approvals` (`ApprovalStore`), its conformance suite written first.
- It binds a decision to the message that carries it by reading `outbound.queue`'s `receipts` feed
  and `answerKey` (`Feed`, SPEC K3; `packages/contracts/src/outbound.ts`). The answer comes back as
  an `InboundMessage` with `replyTo` to a `choice` part ([rich content](rich-content.md)).
- A tool that waits for a decision is `replay: "never"`, and the decision is keyed by
  `${sessionId}:${runId}:${toolCallId}`.
- Absent, nothing waits for a person. A question that needs an answer now is
  [interaction](interaction.md), not an approval.

## Pi first
Pi's durable runtime has durable tasks with phases, waits (`sleep(until)`), memos and an abort
protocol (`pico-v5.md` §5): a run can wait days for a decision with no task engine in pikit. pikit
builds only the surface (where the question goes, how the answer comes back) and the record of
decisions across conversations. `pi-durable` 0.99.0 ships these tasks, but the adapter does not run
on it yet (`features/pi-durable-migration.md`); until it does, a wait is `state.phase` plus tools.

## Open questions
- Is the approval of a self-change (SPEC §6) an `approvals` decision, or the git host's
  review, with the dashboard as its surface?
- Once Pi's durable tasks exist, do decisions stay in a pikit table, or become Pi's task records
  plus a cross-session index (as `agent.submissions` does for messages)?
- Who may answer: the conversation's actor, or a role ([policy tools](policy-tools.md),
  [pairing](pairing.md))?

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `approvals` | Deterministic decision lifecycle: proposed → approved/rejected → executed → verified, with retries, reminders, stalled escalation, TTL/abandonment, and **delivery-time binding** of a decision to the message/thread where a human can answer it (a decision created by a scheduled job cannot know its answer surface until the result is sent). It binds by reading `outbound.queue`'s receipts (§4.8, §5). |
