/**
 * What a command typed in a conversation answered (`/rules …`): a quiet note in its thread, as the
 * dashboard shows its commands' notes. It is this page's only: never in the transcript, never sent to
 * the assistant.
 */

import type { CommandNote } from "@/lib/conversations";

export function CommandNoteRow({ note }: { note: CommandNote }) {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-card bg-inset px-3 py-2.5 shadow-hairline" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <span className="mt-px flex h-5 shrink-0 items-center rounded-chip bg-surface px-1.5 font-mono chat-text-11.5 text-ink-2 shadow-hairline">/{note.command}</span>
      <p className={`min-w-0 flex-1 chat-text-13 leading-5 [overflow-wrap:anywhere] ${note.failed ? "text-red" : "text-ink-2"}`}>{note.text}</p>
      <span className="mt-0.5 shrink-0 chat-text-11 text-ink-3">Only you see this</span>
    </div>
  );
}
