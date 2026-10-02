# Proposal for pi-durable: report when sleeping work is next due

Status: draft for upstream (`@earendil-works/pi-durable`, against 1.0.0). From pikit, which runs one
Harness per Cloudflare Durable Object.

## Motivation

pi-durable keeps every task durably, so a process that dies loses nothing: a reopened Harness finds
the task and `resume()` runs it again. But a task that **waits** waits in process memory.
`TaskRuntime.sleep(until)` is the scheduler's `#sleep`, a `setTimeout` loop on the Harness clock
(`scheduler.ts` `#sleep`, `delay`). Nothing outside the process knows that a wake-up is needed, or
when.

On a long-lived server that is fine. On a serverless host it is not. A Durable Object, a Lambda, or
any host that lives only while an event is in flight and is evicted between events cannot rely on an
in-process timer:

- If the host is evicted while a task sleeps, nothing wakes it. The run stalls until some unrelated
  event (the next user message) happens to reopen the Harness. Built-in sleeps that hit this:
  generation retry backoff (up to 60 s by default), deferred-response polling, compaction retry.
- If the host is *not* evicted, the pending timer keeps it resident. On workerd a pending timer
  prevents eviction, so the object is billed while it only waits. The work then also runs outside
  any event, where the platform may cut it at any time.

These hosts have a durable timer of their own (a Durable Object alarm, a scheduled queue message).
They need pi-durable to tell them **when**.

## Current workaround (pikit, `packages/pi-adapter/src/durable/wakeups.ts`)

`nextWakeAt(harness)` derives the time from `harness.inspect()`:

- a `ready` or `running` task (or an abort-marked one) is due now;
- otherwise, it reads the checkpoint of the built-ins that sleep: `pi.generation` phase `retry`
  (`until`) and phase `poll` (`pollAt`), and `pi.compaction` phase `retry` (`until`). `pi.live`
  mirrors these (`generation.retry.at`, `generation.deferred.pollAt`, `compactions[].retry.at`), but
  only for presentation;
- `waiting`, `completing` and `blocked` tasks are never due by themselves.

`driveSlice(harness, { until, signal })` calls `resume()`, waits on `subscribeCommits` for task
changes until nothing is due within the slice, and returns `{ idle, nextWakeAt }`. The host sets its
alarm from that value. When the alarm fires, the host reopens the Harness and runs another slice.

Limits of the workaround:

- It depends on the private checkpoint shapes of `pi.generation` and `pi.compaction`.
- A custom task's `runtime.sleep(until)` is invisible unless the task checkpoints `until` itself and
  the host is told how to read it (pikit's `dueAt` hook). Otherwise the task looks due now for its
  whole sleep, so the host spends slice after slice on it.
- There is no signal when a sleep begins, so the host must poll `inspect()` after each task commit.

## Proposal

Make "a sleeping task" first-class state, so the scheduler can answer the question itself. These
are three small, independent pieces. (1) alone fixes it for every host.

### 1. `harness.nextDueAt(context): Promise<number | undefined>`

The earliest time on the Harness clock at which any live task needs the process:

- `now()` if a task is ready, running and not sleeping, or has a pending abort;
- otherwise the minimum `until` over sleeping tasks;
- otherwise `undefined`.

This is exact only if sleeps are visible to the scheduler, which is the next point.

### 2. Sleeps the scheduler can see

When a task calls `runtime.sleep(until)`, the scheduler records it. In memory is enough for
`nextDueAt` while the process lives. To survive a reopen, the sleep is also persisted:

- **Option A (no schema change):** `inspect()` reports `{ kind: "sleeping", until }` for an
  invocation inside `sleep`. After a reopen, the built-ins already re-derive `until` from their
  checkpoints. For custom tasks, document that they must checkpoint before sleeping.
- **Option B (durable):** a task record carries an optional `wakeAt` in its pending/running state,
  set in the commit that precedes the sleep, either by `runtime.sleep` itself or by a
  `NextTaskState` field (`{ status: "running", checkpoint, wakeAt }`). `open()` reads it, and
  `nextDueAt` is then exact across reopens for any task. Storage needs one nullable column, or a
  field in the state JSON.

Option B also lets the scheduler skip dispatching a task that is not yet due after a reopen, instead
of starting its phase only for it to sleep again.

### 3. `HarnessOptions.onScheduled?(at: number | undefined): void`

Called, synchronously and outside the Session line, whenever the value of `nextDueAt` changes. That
covers a sleep starting, a task becoming ready, and the Harness going idle (`undefined`). Hosts then
need no polling:

```ts
const harness = await Harness.open(storage, {
  models, registry, now: () => clock.now(),
  onScheduled: (at) => void (at === undefined ? alarms.cancel() : alarms.setAt(at)),
}, context);
```

### Optional: `HarnessOptions.timers`

An injectable `sleep(until, signal)` (default: the current `setTimeout` loop). A host could then
satisfy short sleeps in process and turn long ones into a rejection that ends the invocation cleanly,
with the task left pending and due at `until`. That gives eviction-friendly behaviour without
holding a timer. It is not required once (1) to (3) exist.

## Sketch (scheduler)

```ts
// scheduler.ts
readonly #sleeping = new Map<TaskId, number>(); // invocation → until

async #sleep(invocation, until, context) {
  this.#sleeping.set(invocation.taskId, until);
  this.#notifyScheduled();
  try { /* existing loop */ } finally {
    this.#sleeping.delete(invocation.taskId);
    this.#notifyScheduled();
  }
}

nextDueAt(): number | undefined {
  let earliest: number | undefined;
  for (const record of this.#live.values()) {
    const due = this.#dueAt(record); // now / #sleeping / record wakeAt (option B) / undefined
    if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
  }
  return earliest;
}
```

`#notifyScheduled()` would also run from `#observe` (task changes) and on idle, debounced to one call
per changed value.

## Compatibility

Everything is additive. `inspect()` gains a state kind, which may break consumers that switch on it
exhaustively. It could appear as `running` with a `sleepingUntil` field instead.
