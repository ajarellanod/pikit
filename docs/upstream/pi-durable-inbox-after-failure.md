# Proposal for pi-durable: place queued inputs when a run fails

Status: draft for upstream (`@earendil-works/pi-durable`, against 1.0.0). From pikit, which runs Pi
agents behind chat channels.

## Problem

A follow-up submitted while a run is going waits in the inbox and is placed when the run answers. If
the run ends **without** an answer (`unanswered` with `model_error`, `faulted`, `orphaned`, …), the
follow-ups stay queued and nothing places them. They move only when someone submits again. The
README says so ("If a run fails, queued items stay in the inbox until the next submission places
them, oldest first").

In a chat that means: a message sent while the agent was failing is never answered until the user
writes once more, and its answer then comes before the new message's. Nothing reports the
conversation as stuck: `harness.waitForIdle()` resolves, `pi.live.run` is absent, and the queued
submission's status stays `queued`.

## Repro

`packages/pi-adapter/src/durable/pi-facts.test.ts`, "a run that fails leaves the follow-ups in the
inbox", on pi-ai's faux provider:

1. submit input `r1`; its model call is held, then returns `stopReason: "error"`;
2. while it is held, submit input `r2` (queued in `pi.inbox`);
3. `r1` settles `unanswered` / `model_error`; `harness.waitForIdle()` resolves;
4. `r2`'s status is still `queued`, and no run is going;
5. any submission (pikit uses a write) places `r2`, which then runs and settles `done`.

## pikit's workaround

`packages/pi-adapter/src/durable/runtime.ts`, `reconcileInbox`: after an input settles unanswered,
and after opening a Harness, the runtime looks at `pi.live` and `pi.inbox`. With no run going and an
input queued, it submits `{ type: "write", entry: { kind: "pikit.inbox-kick" } }`: an entry without
model messages, so the model never sees it, whose admission boundary places the oldest input and
starts its run.

Costs: one meaningless entry in the transcript per failure; a dependency on the admission boundary
placing follow-ups; reads of two internal documents (`pi.live`, `pi.inbox`) after every failure.

## Proposal

### 1. Default: a run that ends places what is queued

When a run ends, whatever the reason, pi-durable runs the same `final` boundary it runs after an
answer: follow-ups are placed according to `followUpMode`, and the next run starts. An abort is the
exception, since it already withdraws queued inputs.

If keeping a failed conversation quiet is sometimes wanted, make it a setting:

```ts
type HarnessSettings = {
  // …
  /** After a run ends unanswered (not aborted): "continue" places queued follow-ups; "hold" keeps them. */
  readonly afterFailure?: "continue" | "hold"; // default "continue"
};
```

### 2. On `resume()`, idle conversations with queued inputs start

A Harness reopened over a conversation that is idle with queued follow-ups (the process died between
the failure and the next submission) places them, as in (1).

### 3. Optional: an explicit drain

`conversation.drain(context): Promise<boolean>` places queued inputs if the conversation is idle and
reports whether a run started. It lets a host with `"hold"` resume a conversation without writing an
entry.

## Compatibility

(1) changes behaviour for callers that relied on queued inputs waiting after a failure; the
`"hold"` setting keeps that. (2) and (3) are additive.
