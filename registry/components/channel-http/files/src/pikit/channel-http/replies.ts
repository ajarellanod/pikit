/**
 * POSTs waiting for their answer. Only a cache: the answer is in the conversation's session whether
 * or not anyone waits, so losing this map (a restart, a timeout) loses no answer, only the chance
 * to return it in the same HTTP response.
 *
 * A run answers every request it took (`AgentResult.requestIds`): the one that started it and each
 * message queued into it. So a POST whose message joined a busy conversation receives the same
 * answer as the POST that started the run.
 *
 * Waiters are keyed by session and request id: a client may reuse its message ids across
 * conversations, and duplicates are per conversation.
 */

import type { AgentResult } from "@pikit/core";

export type Outcome = { kind: "answered"; result: AgentResult } | { kind: "timeout" } | { kind: "cancelled" };

export interface Waiter {
  /** Wait for the answer, at most `timeoutMs`, or until `signal` fires. Settles once. */
  wait(timeoutMs: number, signal: AbortSignal | undefined): Promise<Outcome>;
  /** Stop waiting (the message was a duplicate, or its dispatch failed). */
  cancel(): void;
}

export class Replies {
  private readonly waiting = new Map<string, Set<(result: AgentResult) => void>>();

  /** Register before dispatching, so an answer that comes at once is not missed. */
  expect(sessionId: string, requestId: string): Waiter {
    const key = keyOf(sessionId, requestId);
    let deliver!: (result: AgentResult) => void;
    const answered = new Promise<AgentResult>((resolve) => (deliver = resolve));
    const set = this.waiting.get(key) ?? new Set();
    set.add(deliver);
    this.waiting.set(key, set);
    const cancel = (): void => {
      set.delete(deliver);
      if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
    };

    return {
      cancel,
      wait: (timeoutMs, signal) => {
        // A cancellable timer: the clock's `sleep` cannot be cancelled, and an answered POST must
        // not leave a two-minute timer behind.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const outcome = new Promise<Outcome>((resolve) => {
          void answered.then((result) => resolve({ kind: "answered", result }));
          timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          if (signal !== undefined) {
            onAbort = () => resolve({ kind: "cancelled" });
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        return outcome.finally(() => {
          clearTimeout(timer);
          if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
          cancel();
        });
      },
    };
  }

  /** Deliver a run's answer to every POST waiting for one of the requests it took. */
  answer(result: AgentResult): void {
    for (const requestId of result.requestIds) {
      const key = keyOf(result.conversation.sessionId, requestId);
      const set = this.waiting.get(key);
      if (set === undefined) continue;
      this.waiting.delete(key);
      for (const deliver of set) deliver(result);
    }
  }

  /** How many POSTs are waiting (tests). */
  get size(): number {
    let count = 0;
    for (const set of this.waiting.values()) count += set.size;
    return count;
  }
}

function keyOf(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}
