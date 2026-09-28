/**
 * At start, resume the conversations holding a message nobody answered (SPEC §7), with
 * `agent.submissions` installed. The platform was told "received" (Telegram will not send the message
 * again), the process died, and without this the user would wait until they write again.
 *
 * Each conversation is opened as a new message would open it: a run the dead process left open is
 * resumed, a message waiting in Pi's inbox gets a run, and a run that ended without its end recorded is
 * settled from the session (`recover`, in the adapter). A few at a time, in the background: start does
 * not wait for them, and stop aborts what has not started.
 */

import type { AppContext } from "@pikit/core";
import type { AgentSubmissions } from "@pikit/contracts";
import type { PiRuntime } from "@pikit/pi-adapter";

/** Conversations resumed at once: each may run the model, and a restart should not flood the provider. */
export const RESUME_AT_ONCE = 4;

/** Resumes every pending conversation; `ctx`'s cancellation stops taking new ones. Never rejects. */
export async function resumePending(runtime: PiRuntime, submissions: AgentSubmissions, ctx: AppContext): Promise<void> {
  const logger = ctx.logger;
  let pending: Awaited<ReturnType<AgentSubmissions["pending"]>>;
  try {
    pending = await submissions.pending(ctx);
  } catch (error) {
    logger.error("runtime-pi: could not read the conversations with unanswered messages; they resume when they get a new one", { error: String(error) });
    return;
  }
  if (pending.length === 0) return;
  const messages = pending.reduce((sum, p) => sum + p.requestIds.length, 0);
  logger.info("runtime-pi: resuming conversations with unanswered messages", { conversations: pending.length, messages });

  const stopped = (): boolean => ctx.abortSignal?.aborted === true;
  let next = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length && !stopped()) {
      const { conversation, requestIds } = pending[next++] as (typeof pending)[number];
      try {
        await runtime.recover(conversation, requestIds, ctx);
      } catch (error) {
        if (stopped()) return;
        failed++;
        logger.error("runtime-pi: a conversation with unanswered messages could not be resumed; it is tried again at the next start", {
          conversation: conversation.key,
          requests: requestIds,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESUME_AT_ONCE, pending.length) }, worker));
  if (stopped()) {
    logger.info("runtime-pi: stopped resuming conversations; the rest resume at the next start", { started: next, of: pending.length });
    return;
  }
  logger.info("runtime-pi: resumed the conversations with unanswered messages", { conversations: pending.length, failed });
}
