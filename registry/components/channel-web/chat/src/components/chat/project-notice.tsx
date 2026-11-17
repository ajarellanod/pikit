/**
 * What was added to a chat's project from it (`GET .../conversations/:id/notices`: the project's logs'
 * entries whose author worked in this chat), under the answer that made it: "trader added to the
 * project: rule “Target CPA 18 EUR” · Undo". From the logs, so it shows whatever the assistant said;
 * Undo brings back what was there before (the store's restore, itself in History); once undone, it says
 * by whom.
 */

import { Folder, Undo } from "iconoir-react";
import { useState } from "react";
import type { ChatChange } from "@/lib/chat-api";
import { authorName } from "@/lib/project";

const KINDS: Record<string, string> = { rule: "rule", note: "note", file: "file", link: "link", document: "document", summary: "summary", instructions: "instructions", member: "member" };

export function ProjectNoticeRow({ change, me, projectHref, onUndo }: { change: ChatChange; me: string; projectHref: string; onUndo?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const verb = change.action === "added" ? "added to the project" : change.action === "removed" ? "removed from the project" : change.action === "restored" ? "brought back in the project" : "changed in the project";
  const kind = KINDS[change.item.kind] ?? change.item.kind;
  return (
    <div role="note" className="flex items-center gap-2.5 rounded-card bg-inset px-3 py-2 shadow-hairline" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <a href={projectHref} aria-label="The project" className="shrink-0 text-ink-3 hover:text-ink">
        <Folder width={14} height={14} strokeWidth={1.9} aria-hidden />
      </a>
      <p className="min-w-0 flex-1 chat-text-13 leading-5 text-ink-2 [overflow-wrap:anywhere]">
        <span className="text-ink">{authorName(change.by, me)}</span> {verb}: {kind} “{change.item.title}”
        {change.undone !== undefined && <span className="text-ink-3"> · undone by {authorName(change.undone.by, me)}</span>}
      </p>
      {onUndo !== undefined && change.restorable && change.action !== "restored" && change.undone === undefined && (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => {
            setBusy(true);
            onUndo().finally(() => setBusy(false));
          }}
          className="flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 chat-text-12 font-medium text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
        >
          <Undo width={12} height={12} strokeWidth={2} aria-hidden /> Undo
        </button>
      )}
    </div>
  );
}
