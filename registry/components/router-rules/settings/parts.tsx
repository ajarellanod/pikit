/**
 * The pieces both views of the Routing section use: how a channel reads, the names of the chats the
 * dashboard has seen, an id as a chip, a box that takes several ids at once, and a rule's note.
 */

import { ArrowRight, InfoCircle, Plus, Trash, WarningTriangle, Xmark } from "iconoir-react";
import { type ReactNode, useEffect, useState } from "react";
import { ActionsMenu, type ActionsMenuItem } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import { CHANNELS } from "@/components/pikit/party";
import { api, type ApiConversation, type ApiPage } from "@/lib/api";
import { DENIED, idsIn, type Problem } from "./rules";

/** How a channel reads: its platform's name, and an account after it ("Telegram: support"). */
export function channelLabel(channel: string | undefined): string {
  if (channel === undefined || channel === "") return "Any channel";
  const [kind = channel, account] = channel.split(/:(.*)/s);
  const platform = CHANNELS[kind]?.label ?? kind;
  return account === undefined || account === "" ? platform : `${platform}: ${account}`;
}

/** "1 chat", "63 chats". */
export const counted = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The conversations read for their names: at most this many pages of the most recently active. */
const PAGES = 4;
const PAGE = 500;
/** The ids of a party that are a rule's chat (`InboundMessage.conversationId`): a Google Chat space, a Telegram or web chat. */
const CHAT_IDS = new Set(["Space", "Chat id"]);

/**
 * The names of the chats the dashboard knows (their channel's `conversation.describe`, `ApiParty`):
 * a chat's id (a space, `spaces/AAQA6yBxAgA`; a chat id) to its name ("Zafiro Hoteles"), from the most
 * recently active conversations, read once. A chat no conversation of them names shows as its id;
 * names that cannot be read are no error (the ids show).
 */
export function useChatNames(): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    (async () => {
      const found = new Map<string, string>();
      let cursor: string | undefined;
      for (let page = 0; page < PAGES; page++) {
        const read = await api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
        for (const { party } of read.items) {
          const name = party?.name?.trim();
          if (name === undefined || name === "") continue;
          for (const id of party?.ids ?? []) if (CHAT_IDS.has(id.label) && !found.has(id.value)) found.set(id.value, name);
        }
        cursor = read.next;
        if (cursor === undefined) break;
      }
      if (live) setNames(found);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return names;
}

/** A problem's text, the chat it names (`Problem.shadowed`'s one id) said by its name when known. */
export function named(problem: Problem, names: ReadonlyMap<string, string>): string {
  const [one, other] = problem.shadowed ?? [];
  const name = one === undefined || other !== undefined ? undefined : names.get(one.id);
  return name === undefined || one === undefined ? problem.text : problem.text.replace(one.id, `${name} (${one.id})`);
}

/** Whether `query` (its words, any case) is in any of `texts`. */
export function found(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * An id of a rule's list as a chip: the chat's name when known (its id in the tooltip), else the id in
 * monospace. `shadowed` marks one an earlier rule takes first (orange); `actions`, its menu (move it);
 * `onRemove`, its ×.
 */
export function IdChip({ id, name, shadowed, actions, onRemove, label }: { id: string; name?: string; shadowed?: string; actions?: readonly ActionsMenuItem[]; onRemove?: () => void; label: string }) {
  const tone = shadowed !== undefined ? "bg-orange-tint text-orange" : "bg-inset text-ink-2 shadow-hairline";
  return (
    <span title={[name === undefined ? id : `${name} · ${id}`, shadowed].filter(Boolean).join("\n")} className={`inline-flex h-6 max-w-full min-w-0 items-center gap-0.5 rounded-[7px] pr-0.5 pl-2 text-[12.5px] ${tone}`}>
      {shadowed !== undefined && <WarningTriangle width={12} height={12} strokeWidth={2} className="mr-1 shrink-0" />}
      <span className={`min-w-0 truncate ${name === undefined ? "font-mono text-[11.5px]" : ""}`}>{name ?? id}</span>
      {actions !== undefined && actions.length > 0 && (
        <ActionsMenu
          label={`${label}: actions`}
          iconSize={12}
          width="w-56"
          actions={actions}
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover-2 hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink"
        />
      )}
      {onRemove !== undefined && (
        <button type="button" aria-label={`Remove ${label}`} title="Remove" onClick={onRemove} className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover-2 hover:text-ink">
          <Xmark width={11} height={11} strokeWidth={2.2} />
        </button>
      )}
    </span>
  );
}

/** The menu of an id: move it to each of `targets` (an agent's name, or refused), and remove it. */
export function idActions(targets: readonly { value: string; label: string }[], move: (target: string) => void, remove: () => void): ActionsMenuItem[] {
  return [
    ...targets.map((target) => ({ key: `to:${target.value}`, label: target.value === DENIED ? "Refuse it instead" : `Move to ${target.label}`, icon: <ArrowRight />, onSelect: () => move(target.value) })),
    { key: "remove", label: "Remove", icon: <Trash />, danger: true, onSelect: remove },
  ];
}

/** At most this many chips of a list show until "Show all". */
const SHOWN = 24;

/** Chips of a list, the first `SHOWN` until "Show all" (all while a search narrows them). */
export function ChipList({ count, all = false, children }: { count: number; all?: boolean; children: (shown: number) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open || all ? count : Math.min(count, SHOWN);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {children(shown)}
      {shown < count && (
        <button type="button" onClick={() => setOpen(true)} className="h-6 rounded-[7px] px-2 text-[12.5px] text-ink-3 hover:bg-hover-2 hover:text-ink">
          {`+${(count - shown).toLocaleString()} more`}
        </button>
      )}
    </div>
  );
}

/**
 * Takes ids: a button ("Add chats") that opens a box where several are typed or pasted at once (one
 * per line, or separated by spaces or commas), added with Add or Enter; `extra` goes before Add (where
 * they go).
 */
export function AddIds({ what, placeholder, onAdd, extra, notice, open: startOpen = false }: { what: string; placeholder: string; onAdd: (ids: string[]) => void; extra?: ReactNode; notice?: (ids: string[]) => string | undefined; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState("");
  const ids = idsIn(text);
  const add = () => {
    if (ids.length === 0) return;
    onAdd(ids);
    setText("");
    if (!startOpen) setOpen(false);
  };
  if (!open) {
    return (
      <Button size="xs" variant="quiet" onClick={() => setOpen(true)} className="self-start text-ink-3">
        <Plus width={12} height={12} strokeWidth={2} />
        {`Add ${what}`}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-control bg-inset p-2 shadow-hairline">
      <textarea
        aria-label={`Add ${what}: ids`}
        value={text}
        rows={Math.min(6, Math.max(2, text.split("\n").length))}
        placeholder={placeholder}
        autoFocus={!startOpen}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            add();
          }
          if (event.key === "Escape" && !startOpen) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className="control min-h-14 resize-y py-1.5 font-mono text-[12px] leading-[18px]"
      />
      {notice?.(ids) !== undefined && <Note tone="info">{notice(ids)}</Note>}
      <div className="flex flex-wrap items-center gap-2">
        {extra}
        <span className="ml-auto text-[12px] text-ink-3">{ids.length === 0 ? "One per line, or separated by spaces or commas" : `${ids.length.toLocaleString()} to add`}</span>
        {!startOpen && (
          <Button size="xs" variant="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
        <Button size="xs" variant="secondary" disabled={ids.length === 0} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** A note under a rule: an error (red), a warning (orange), or only information. */
export function Note({ tone, children, className = "" }: { tone: "error" | "warning" | "info"; children: ReactNode; className?: string }) {
  const colors = tone === "error" ? "bg-red-tint text-red" : tone === "warning" ? "bg-orange-tint text-orange" : "text-ink-3";
  const Icon = tone === "info" ? InfoCircle : WarningTriangle;
  return (
    <p className={`flex items-start gap-2 rounded-control text-[12.5px] leading-[18px] ${tone === "info" ? "px-0.5" : "px-2.5 py-1.5"} ${colors} ${className}`}>
      <Icon width={14} height={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
