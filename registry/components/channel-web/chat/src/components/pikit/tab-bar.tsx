/**
 * The tabs of the conversations opened (Beautiful UI's harness tabs): each with its title, a spinner
 * while its run goes, and its close button; then New chat's while it shows, and the "+" that opens a
 * new chat; at the right end, a page's actions (`actions`, or a portal into `actionsRef`: the
 * dashboard's `TabActions`). By props only: what the tabs are, which is shown and what a click does
 * are the app's (the dashboard's `useChats`), so the dashboard and channel-web's chat show them alike.
 */

import type { ReactNode } from "react";

/** One tab: a conversation opened. */
export interface TabItem {
  id: string;
  title: string;
  /** Its run goes. */
  busy?: boolean;
}

function CloseTab({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close tab"
      onClick={onClose}
      className="-my-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-[background-color,color] duration-100 hover:bg-hover-2 hover:text-ink"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

/**
 * The tab bar. `active` is the tab shown (none while New chat or another page shows); `newChat` is
 * New chat's tab, given while it shows. Closing a tab tells `onClose` whether it was the one shown:
 * the app then shows its neighbour, or a fresh New chat.
 */
export function TabBar({
  tabs,
  active,
  newChat,
  onSelect,
  onClose,
  onNewChat,
  actions,
  actionsRef,
}: {
  tabs: readonly TabItem[];
  active?: string | undefined;
  newChat?: { onClose: () => void } | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string, active: boolean) => void;
  onNewChat: () => void;
  actions?: ReactNode;
  /** The actions' element, for a page to portal into. */
  actionsRef?: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const shown = tab.id === active;
          return (
            <div
              key={tab.id}
              /* fixed width: every close button sits in the same spot */
              className={`group/tab flex h-7 w-36 shrink-0 items-center gap-0.5 rounded-[7px] pr-0.5 pl-2.5 text-[12.5px] font-medium transition-colors duration-100 ${shown ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
            >
              <button type="button" aria-pressed={shown} onClick={() => onSelect(tab.id)} title={tab.title} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                {tab.busy === true && <span aria-label="Running" className="size-2.5 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />}
                <span className="block truncate">{tab.title}</span>
              </button>
              <CloseTab onClose={() => onClose(tab.id, shown)} />
            </div>
          );
        })}
        {newChat !== undefined && (
          <div className="flex h-7 w-36 shrink-0 items-center gap-0.5 rounded-[7px] bg-hover-2 pr-0.5 pl-2.5 text-[12.5px] font-medium text-ink">
            <span aria-current="page" className="block min-w-0 flex-1 truncate">
              New chat
            </span>
            <CloseTab onClose={newChat.onClose} />
          </div>
        )}
        <button
          type="button"
          aria-label="New chat"
          onClick={onNewChat}
          className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div ref={actionsRef} className="flex shrink-0 items-center gap-1">
        {actions}
      </div>
    </div>
  );
}
