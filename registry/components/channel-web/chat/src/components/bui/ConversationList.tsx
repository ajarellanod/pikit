import type { MouseEvent } from "react";
import { formatAgo } from "@/lib/format";
import { ActionsMenu, type ActionsMenuItem } from "./ActionsMenu";
import { Badge } from "./Badge";

/* ---------------------------------------------------------
 * CONVERSATION LIST
 * A page's list of conversations, compact (44px rows): the
 * title on the left, a spinner while one runs, a tag, the time
 * of its last activity small and muted on the right, then its
 * "…" menu (`ActionsMenu`), shown on hover or focus (always on
 * touch). The whole row opens it. The dashboard's and the
 * chat's Conversations pages, the same look.
 * --------------------------------------------------------- */

export type ConversationListItem = {
  id: string;
  title: string;
  /** its page, for a new tab; a plain click calls `onOpen` when given */
  href: string;
  /** epoch ms */
  lastActivity?: number | undefined;
  busy?: boolean | undefined;
  /** a quiet tag after the title ("Archived") */
  tag?: string | undefined;
  actions: ActionsMenuItem[];
};

/** A plain left click follows `onOpen`; any other (a new tab) follows the link. */
function follow(event: MouseEvent, onOpen: (() => void) | undefined) {
  if (onOpen === undefined || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen();
}

export function ConversationList({ items, onOpen }: { items: readonly ConversationListItem[]; onOpen?: (id: string) => void }) {
  return (
    <ul className="records-shell flex flex-col divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="group/row relative flex h-11 items-center gap-3 pr-1.5 pl-4 transition-colors duration-100 hover:bg-hover has-[a:focus-visible]:bg-hover">
          <a
            href={item.href}
            title={item.title}
            onClick={(event) => follow(event, onOpen === undefined ? undefined : () => onOpen(item.id))}
            className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink outline-none after:absolute after:inset-0 after:content-['']"
          >
            {item.title}
          </a>
          {item.busy === true && <span aria-label="Running" className="spinner size-3 shrink-0" />}
          {item.tag !== undefined && <Badge className="shrink-0">{item.tag}</Badge>}
          <time className="shrink-0 text-[12px] text-ink-3 tabular-nums" dateTime={item.lastActivity === undefined ? undefined : new Date(item.lastActivity).toISOString()}>
            {formatAgo(item.lastActivity)}
          </time>
          <ActionsMenu
            actions={item.actions}
            label={`Actions for ${item.title}`}
            className="relative z-10 size-7 shrink-0 rounded-[7px] text-ink-3 opacity-0 transition-[opacity,background-color,color] duration-100 group-hover/row:opacity-100 group-has-[a:focus-visible]/row:opacity-100 hover:bg-hover-2 hover:text-ink focus-visible:opacity-100 aria-expanded:bg-hover-2 aria-expanded:text-ink aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </li>
      ))}
    </ul>
  );
}
