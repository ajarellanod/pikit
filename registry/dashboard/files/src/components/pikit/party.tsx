/**
 * Who a conversation is with (its party, `ApiConversation.party`): the channel it came through, the
 * person or chat on the other side, and the ids an operator may need. The dashboard shows it once per
 * conversation, never above each message: an info button in the conversation's header (`PartyChip`:
 * the icon alone, square like the header's other buttons, saying who it is in its label and tooltip)
 * that opens its Details (the channel, the name and the detail, every id with a copy button, a link
 * to where the channel shows that person), and the channel's icon before each row of the lists
 * (`ChannelIcon`). `CHANNELS` is the one place a channel's kind gets its icon and label.
 *
 * A conversation without a party (no key yet, or an older server) gets one made from its key
 * (`<kind>:<rest>`), so a raw key never shows as a name.
 */

import { Antenna, ArrowUpRight, ChatLines, Check, Code, Copy, Globe, InfoCircle, Telegram, User } from "iconoir-react";
import { Popover } from "radix-ui";
import { type ComponentType, type SVGProps, useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import type { ApiConversation, ApiParty } from "@/lib/api";

export type { ApiParty };
import { navigate } from "@/lib/router";


type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** Each channel's icon and label, by kind; another kind shows an antenna and its own name. */
export const CHANNELS: Readonly<Record<string, { icon: Icon; label: string }>> = {
  web: { icon: Globe, label: "Web chat" },
  telegram: { icon: Telegram, label: "Telegram" },
  googlechat: { icon: ChatLines, label: "Google Chat" },
  http: { icon: Code, label: "HTTP API" },
  dashboard: { icon: User, label: "Dashboard" },
};

const channelOf = (kind: string): { icon: Icon; label: string } => CHANNELS[kind] ?? { icon: Antenna, label: kind };

/** The party of `conversation`: the API's, else one made from its key (its channel, the key and the id). */
export function partyOf(conversation: ApiConversation): ApiParty {
  const given = conversation.party;
  if (given !== undefined) return given;
  const key = conversation.key;
  const kind = key === undefined ? "" : key.slice(0, Math.max(0, key.indexOf(":")));
  return {
    channel: { kind, label: kind === "" ? "Conversation" : channelOf(kind).label },
    ids: [...(key === undefined ? [] : [{ label: "Key", value: key }]), { label: "Conversation", value: conversation.conversationId }],
  };
}

/** A channel's icon, small and muted, labelled for a screen reader (its channel's label). */
export function ChannelIcon({ kind, label, size = 14, className = "" }: { kind: string; label?: string; size?: number; className?: string }) {
  const channel = channelOf(kind);
  const Glyph = channel.icon;
  return <Glyph width={size} height={size} strokeWidth={1.8} role="img" aria-label={label ?? channel.label} className={`shrink-0 ${className}`} />;
}

/** "Telegram · support": the channel, and its instance when it has one. */
const channelLine = (party: ApiParty): string => (party.channel.instance === undefined ? party.channel.label : `${party.channel.label} · ${party.channel.instance}`);

/**
 * Copies `text`: the clipboard API is a secure context's only (a dashboard over plain http has none),
 * then a textarea inside `within` (so a popover keeps its focus), selected and copied.
 */
async function copyText(text: string, within: HTMLElement): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The fallback below.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  within.append(field);
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  field.select();
  try {
    return document.execCommand("copy");
  } finally {
    field.remove();
    back?.focus();
  }
}

/** One id: its label, its value in monospace (whole in its title), and a copy button that says "Copied" a moment. */
function IdRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex h-8 min-w-0 items-center gap-2">
      <dt className="w-[92px] shrink-0 truncate text-[12.5px] text-ink-3">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">
        <span title={value} className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {value}
        </span>
        <button
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={(event) => {
            const row = event.currentTarget.parentElement ?? document.body;
            void copyText(value, row).then(setCopied);
          }}
          className={`flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[12px] transition-colors duration-100 hover:bg-hover-2 ${copied ? "text-green" : "text-ink-3 hover:text-ink"}`}
        >
          {copied ? <Check width={13} height={13} strokeWidth={2.2} aria-hidden /> : <Copy width={13} height={13} strokeWidth={1.8} aria-hidden />}
          {copied && <span aria-hidden>Copied</span>}
        </button>
        <span aria-live="polite" className="sr-only">
          {copied ? `${label} copied` : ""}
        </span>
      </dd>
    </div>
  );
}

/** The conversation's party in its header: an info button (who it is in its label and tooltip) that opens its Details. */
export function PartyChip({ party }: { party: ApiParty }) {
  const [open, setOpen] = useState(false);
  // Without a name, the channel ("Telegram · support") is the title, said once.
  const title = party.name ?? channelLine(party);
  const said = [title, ...(party.detail === undefined ? [] : [party.detail]), ...(party.name === undefined ? [] : [channelLine(party)])];
  const link = party.link !== undefined && party.link.path.startsWith("/") && !party.link.path.startsWith("//") ? party.link : undefined;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Details: ${said.join(", ")}`}
          title={said.join(" · ")}
          className={`flex size-7 shrink-0 items-center justify-center rounded-[7px] transition-colors duration-100 ${open ? "bg-hover-2 text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
        >
          <InfoCircle width={16} height={16} strokeWidth={1.8} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Details"
          className="z-50 w-[340px] max-w-[calc(100vw-16px)] rounded-[14px] bg-surface p-3 shadow-overlay outline-none"
          style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "var(--radix-popover-content-transform-origin)" }}
        >
          <div className="flex min-w-0 items-start gap-2.5 px-0.5">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-inset text-ink-2 shadow-hairline">
              <ChannelIcon kind={party.channel.kind} label={party.channel.label} size={15} />
            </span>
            <div className={`flex min-w-0 flex-1 flex-col gap-0.5 ${party.name === undefined && party.detail === undefined ? "self-center" : ""}`}>
              {party.name !== undefined && <span className="truncate text-[12px] text-ink-3">{channelLine(party)}</span>}
              <span className="truncate text-[14px] font-semibold text-ink">{title}</span>
              {party.detail !== undefined && <span className="truncate text-[12.5px] text-ink-2">{party.detail}</span>}
            </div>
          </div>
          {party.ids.length > 0 && (
            <dl className="mt-2.5 flex flex-col border-t border-line px-0.5 pt-1.5">
              {party.ids.map((id) => (
                <IdRow key={`${id.label}:${id.value}`} label={id.label} value={id.value} />
              ))}
            </dl>
          )}
          {link !== undefined && (
            <Button
              size="xs"
              className="mt-2 w-full"
              onClick={() => {
                setOpen(false);
                navigate(link.path);
              }}
            >
              {link.label}
              <ArrowUpRight width={13} height={13} strokeWidth={2} aria-hidden />
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
