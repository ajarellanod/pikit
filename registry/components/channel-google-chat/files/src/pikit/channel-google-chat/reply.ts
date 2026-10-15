// Owner: shared. What a chat is told about a run, in one place: answer delivery's `text` (index.ts) and the placeholder (placeholder.ts) read it.
/**
 * - `replyText`: a run's answer, or that it failed; nothing for an aborted or empty one. A message
 *   the runtime abandoned is never answered: the user is asked to send it again. A failed run's words
 *   replace its placeholder.
 * - `nothingToSend`: whether answer delivery sends nothing for a run, decided by delivery's own rule
 *   (`answerContent` from `@pikit/contracts`) on `replyText`: it says nothing and the run has no parts
 *   (a completed run's parts go without text: a question). The placeholder of such a run is deleted.
 */

import { answerContent, type RunSettlement } from "@pikit/contracts";

/** What a chat is told about a run (above), or `undefined` for nothing. */
export function replyText(answer: Pick<RunSettlement, "kind" | "text" | "error">): string | undefined {
  if (answer.kind === "failed" && answer.error?.code === "abandoned") return "Sorry, we could not answer your message. Please send it again.";
  if (answer.kind === "failed") return `Sorry, something went wrong while answering (${answer.error?.code ?? "error"}). Try again in a moment.`;
  if (answer.kind === "completed" && (answer.text ?? "").trim() !== "") return answer.text;
  return undefined;
}

/** Whether answer delivery sends nothing for `run` (above): an aborted run, an empty answer with no parts. */
export function nothingToSend(run: Pick<RunSettlement, "kind" | "text" | "error" | "parts">): boolean {
  return answerContent(run, replyText(run)) === undefined;
}
