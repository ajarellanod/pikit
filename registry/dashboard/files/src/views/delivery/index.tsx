/**
 * Delivery (SPEC §5): the answers that did not reach their person yet (stuck: retrying, or waiting
 * longer than a minute) or ever (abandoned: the queue gave them up), and, folded, those that may have
 * reached it twice. Per answer, never per piece, as `lib/delivery.ts` works them out from the outbound
 * queue (`lib/delivery-feed.ts`). An answer delivered is not listed: when nothing needs a look the page
 * says so, with how many answers were delivered as far as the queue's receipts go (it prunes them).
 * Each row opens its conversation. The sidebar's dot (`badge`) says an answer is stuck, or was given up
 * within a day. Shown when an `outbound.queue` is installed (outbound-durable); there is nothing to
 * retry from here (`outbound.queue` has no such operation): the queue retries on its own.
 */

import { ChatBubble, CheckCircle, Clock, DeliveryTruck, Hashtag, NavArrowDown, Repeat, Timer, WarningTriangle } from "iconoir-react";
import { useState } from "react";
import EmptyState from "@/components/bui/EmptyState";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn } from "@/components/bui/RecordsTable";
import { SidebarDot } from "@/components/bui/SidebarNav";
import { StatusDot } from "@/components/bui/StatusDot";
import { ErrorNote } from "@/components/pikit/error-note";
import { ChannelIcon } from "@/components/pikit/party";
import { useChats } from "@/lib/chats";
import { type AnswerRef, type DeliveryProblems, type DuplicateAnswer, needsAttention, RECENT_MS, type StuckAnswer, type UndeliveredAnswer } from "@/lib/delivery";
import { type DeliveryFeed, useDelivery } from "@/lib/delivery-feed";
import { formatAgo } from "@/lib/format";
import { Link, pagePath } from "@/lib/router";
import { defineView } from "@/lib/views";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const when = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The answer's conversation: its channel's icon, its title (the list's, else its key's), a link to it. */
function ConversationCell({ answer }: { answer: AnswerRef }) {
  const chats = useChats();
  const known = answer.conversationId === undefined ? undefined : (chats.items ?? []).find((each) => each.conversationId === answer.conversationId);
  const colon = answer.conversationKey.indexOf(":");
  const name = known !== undefined ? chats.titleOf(known) : answer.conversationKey.slice(colon + 1) || answer.conversationKey;
  return (
    <span className="flex min-w-0 items-center gap-2" title={`${answer.conversationKey} (${answer.channel})`}>
      <ChannelIcon kind={answer.channel.split(":")[0] ?? answer.channel} className="text-ink-3" />
      {answer.conversationId === undefined ? (
        <span className="records-name">{name}</span>
      ) : (
        <Link to={pagePath("/conversations", answer.conversationId)} className="records-name hover:underline">
          {name}
        </Link>
      )}
    </span>
  );
}

const conversationColumn = <T extends AnswerRef>(): RecordColumn<T> => ({
  key: "conversation",
  label: "Conversation",
  icon: <ChatBubble />,
  width: 240,
  sort: (a, b) => a.conversationKey.localeCompare(b.conversationKey),
  cell: (answer) => <ConversationCell answer={answer} />,
});

const stuckColumns: RecordColumn<StuckAnswer>[] = [
  conversationColumn<StuckAnswer>(),
  {
    key: "state",
    label: "State",
    icon: <Timer />,
    width: 160,
    cell: (answer) => (
      <StatusDot
        tone={answer.retrying ? "orange" : "neutral"}
        title={
          answer.retrying
            ? `Tried; it goes again on its own${answer.possibleDuplicate ? ". Its next send may repeat one that reached the platform" : ""}`
            : "Not tried yet: its channel has no transport attached, or it waits behind another answer of its conversation"
        }
      >
        {answer.retrying ? "retrying" : "waiting"}
        {answer.possibleDuplicate && " · may repeat"}
      </StatusDot>
    ),
  },
  { key: "attempts", label: "Attempts", icon: <Repeat />, width: 100, end: true, cell: (answer) => answer.attempts },
  { key: "error", label: "Last error", icon: <WarningTriangle />, width: 240, muted: (answer) => answer.lastError === undefined, title: (answer) => answer.lastError, cell: (answer) => answer.lastError ?? "—" },
  {
    key: "next",
    label: "Next try",
    icon: <Timer />,
    width: 120,
    muted: (answer) => answer.nextAttemptAt === undefined,
    cell: (answer) => (answer.nextAttemptAt === undefined ? "—" : answer.nextAttemptAt <= Date.now() ? "due now" : formatAgo(answer.nextAttemptAt)),
  },
  { key: "since", label: "Since", icon: <Clock />, width: 130, sort: (a, b) => a.since - b.since, cell: (answer) => <span className="text-ink-2">{formatAgo(answer.since)}</span> },
];

const undeliveredColumns: RecordColumn<UndeliveredAnswer>[] = [
  conversationColumn<UndeliveredAnswer>(),
  { key: "reason", label: "Why", icon: <WarningTriangle />, width: 300, title: (answer) => answer.reason, cell: (answer) => answer.reason },
  {
    key: "pieces",
    label: "Pieces",
    icon: <Hashtag />,
    width: 170,
    cell: (answer) => (
      <span className="text-ink-2">
        {answer.abandoned} not delivered{answer.delivered > 0 && `, ${answer.delivered} delivered`}
      </span>
    ),
  },
  { key: "attempts", label: "Attempts", icon: <Repeat />, width: 100, end: true, cell: (answer) => answer.attempts },
  { key: "when", label: "Given up", icon: <Clock />, width: 130, sort: (a, b) => a.at - b.at, cell: (answer) => <span className="text-ink-2">{formatAgo(answer.at)}</span> },
];

const duplicateColumns: RecordColumn<DuplicateAnswer>[] = [
  conversationColumn<DuplicateAnswer>(),
  { key: "pieces", label: "Pieces", icon: <Hashtag />, width: 140, end: true, cell: (answer) => answer.pieces },
  { key: "when", label: "Delivered", icon: <Clock />, width: 140, sort: (a, b) => a.at - b.at, cell: (answer) => <span className="text-ink-2">{formatAgo(answer.at)}</span> },
];

/** How many answers were delivered, as far as the receipts the queue keeps go, said honestly. */
function deliveredLine(feed: DeliveryFeed, problems: DeliveryProblems): string {
  if (!feed.caughtUp) return "Reading the queue's receipts.";
  const onTheirWay = problems.onTheirWay > 0 ? ` ${plural(problems.onTheirWay, "answer")} on ${problems.onTheirWay === 1 ? "its" : "their"} way now.` : "";
  if (problems.since === undefined) return `No answer delivered in the receipts the queue keeps.${onTheirWay}`;
  const pruned = feed.gap ? " Some were pruned before this page read them: more were delivered than counted." : " Older ones are pruned.";
  return `${plural(problems.delivered, "answer")} delivered since ${when.format(problems.since)}, as far as the queue's receipts go.${pruned}${onTheirWay}`;
}

/** The answers that may have reached their person twice: a line, the table on demand. */
function Duplicates({ answers }: { answers: DuplicateAnswer[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Possibly delivered twice"
      meta={answers.length}
      tools={
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="btn btn-outline btn-xs text-ink-2 hover:text-ink">
          {open ? "Hide" : "Show"}
          <NavArrowDown width={13} height={13} strokeWidth={2.2} className="transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : undefined }} />
        </button>
      }
    >
      <p className="text-[12.5px] text-ink-3">
        Delivered, after a send the platform may have received (a timeout, a restart): the person may have seen a piece twice. Nothing to do.
      </p>
      {open && <RecordsTable label="Answers possibly delivered twice" columns={duplicateColumns} rows={answers} rowKey={(answer) => answer.key} maxHeight={360} empty={null} />}
    </Section>
  );
}

function DeliveryPage() {
  const { feed, problems } = useDelivery(true, 10_000);
  const description = "The answers that did not reach their person yet (stuck, retrying) or ever (abandoned), and those that may have reached it twice. An answer delivered is not listed. Never their text.";

  if (feed.unavailable !== undefined) {
    return (
      <Page eyebrow="Delivery" title="Nothing to read here" description={description}>
        <p className="text-[13px] text-ink-3">{feed.unavailable}</p>
      </Page>
    );
  }
  if (problems === undefined) {
    if (feed.error !== undefined) {
      return (
        <Page eyebrow="Delivery">
          <ErrorNote error={feed.error} title="The queue cannot be read" />
        </Page>
      );
    }
    return <PageLoading eyebrow="Delivery" />;
  }

  const count = problems.stuck.length + problems.undelivered.length;
  const line = deliveredLine(feed, problems);
  return (
    <Page eyebrow="Delivery" title={count === 0 ? "Every answer was delivered" : `${plural(count, "answer")} not delivered`} description={description}>
      {feed.error !== undefined && <ErrorNote error={feed.error} title="The queue cannot be read now: this is what it said last" />}
      {feed.pendingMore && <p className="text-[12.5px] text-ink-3">The queue holds more pieces than this page reads: only the oldest are shown.</p>}

      {count === 0 && (
        <div className="records-shell">
          <EmptyState icon={<CheckCircle />} title="Nothing stuck, nothing given up" hint={line} />
        </div>
      )}

      {problems.stuck.length > 0 && (
        <Section title="Stuck" meta="not delivered yet: the queue keeps trying on its own">
          <RecordsTable label="Answers not delivered yet" columns={stuckColumns} rows={problems.stuck} rowKey={(answer) => answer.key} maxHeight={420} empty={null} />
        </Section>
      )}

      {problems.undelivered.length > 0 && (
        <Section title="Not delivered" meta="given up by the queue: they will not be sent">
          <RecordsTable label="Answers not delivered" columns={undeliveredColumns} rows={problems.undelivered} rowKey={(answer) => answer.key} maxHeight={420} empty={null} />
        </Section>
      )}

      {problems.duplicates.length > 0 && <Duplicates answers={problems.duplicates} />}

      {count > 0 && <p className="text-[12.5px] text-ink-3">{line}</p>}
    </Page>
  );
}

/** The sidebar's dot: an answer stuck (orange), or one given up within a day (red). */
function DeliveryBadge() {
  const { feed, problems } = useDelivery(true);
  if (problems === undefined || feed.readAt === undefined || !needsAttention(problems, feed.readAt)) return null;
  const undelivered = problems.undelivered.some((answer) => feed.readAt !== undefined && feed.readAt - answer.at <= RECENT_MS);
  return <SidebarDot tone={undelivered ? "red" : "orange"} label={undelivered ? "An answer was not delivered" : "An answer is stuck"} />;
}

export default defineView({
  id: "delivery",
  title: "Delivery",
  icon: DeliveryTruck,
  requires: ["outbound.queue"],
  order: 30,
  pages: [{ path: "/delivery", component: DeliveryPage, fill: true }],
  badge: DeliveryBadge,
});
