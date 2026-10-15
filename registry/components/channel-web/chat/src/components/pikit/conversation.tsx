/**
 * One conversation, live, whatever serves it (features/completed/chat-parity.md): its transcript, the answer
 * being written, the thinking and the tools running, the messages sent and not shown yet, a composer
 * floating over the thread, and the Context panel. The data is the app's: a `ConversationSource` reads
 * the transcript (entries newest first, paged), follows the live events (a `snapshot` first) and sends
 * or stops; the dashboard's reads the admin API, channel-web's chat its own. Everything here takes its
 * data by props and never fetches by itself, so both show a conversation alike.
 *
 * The thread is the transcript plus the live state (`lib/transcript.ts`): what the live stream
 * announces (a message written, an entry appended) shows before the transcript is read again, and an
 * answer that ended between two snapshots stays as last seen until the transcript has it; nothing is
 * swapped when an answer ends. A message sent shows at once, where it goes (marked while it waits for
 * the run going), until the transcript has it (`SentMessages`, kept by the app above its pages, so New
 * chat's first message shows in the conversation it opens).
 *
 * What is the app's own goes in slots: the header's actions (`actions`, given the Context button), where
 * the Context panel goes (`side`), rows of its own in the thread (`notes`: the dashboard's commands'
 * notes), what replaces the composer when the conversation cannot be talked to (`closed`), and the
 * composer's own props (the picker, the commands, web search, images).
 *
 * The live stream is open only while the page is active (`useActive`: the tab visible, the person there
 * in the last minutes): on Cloudflare an open stream keeps the conversation's Durable Object in memory.
 * It reconnects when it ends (an object evicted or redeployed) and when the person comes back.
 */

import { type ComponentProps, Fragment, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import LoadingState, { LoaderGrid } from "@/components/bui/LoadingState";
import PromptBar, { type ComposerMessage } from "@/components/bui/PromptBar";
import { ContextButton, ContextPanel } from "@/components/pikit/context-panel";
import { ErrorNote } from "@/components/pikit/error-note";
import { type Message, Reply, ToolDetailsContext, turnsOf, UserBubble, type UserMessage, userText } from "@/components/pikit/message";
import { useActive } from "@/lib/activity";
import { imagesOf, sourcesOf } from "@/lib/sources";
import { INITIAL, type LiveEvent, type LiveState, reduce, type TranscriptEntry, type TranscriptPage } from "@/lib/transcript";

export type { LiveEvent, LiveState, TranscriptEntry, TranscriptPage };

/** What a conversation's view reads and does, each app its own way. */
export interface ConversationSource {
  /** The conversation: everything read of another one is dropped when it changes. */
  readonly id: string;
  /** A page of its transcript: the latest without `cursor`, older ones with the `next` of the one before. */
  transcript(page: { limit: number; cursor?: string }): Promise<TranscriptPage>;
  /** Follows its live events, a `snapshot` first, until `signal` aborts or the stream ends (resolves) or fails (throws). */
  follow(onEvent: (event: LiveEvent) => void, signal: AbortSignal): Promise<void>;
  /** Sends a message: `queued` when it waits for the run going, `duplicate` when it was already there. */
  send(message: ComposerMessage): Promise<{ admission: string }>;
  /** Stops the run going. */
  abort(): Promise<void>;
}

/** A message sent from here, shown in its conversation until the transcript has it. */
export interface SentMessage {
  id: number;
  text: string;
  images: { mimeType: string; data: string }[];
  /** Messages of the same text the conversation showed when it was sent: one more is this one. */
  before: number;
  /** It waits for the run going (`admission: "queued"`). */
  queued: boolean;
  /** Epoch ms: when it was sent. */
  at: number;
}

/** The messages sent and not shown yet, by conversation: kept above the pages (`useSentMessages`). */
export interface SentMessages {
  /** The messages sent to conversation `id` it does not show yet, oldest first. */
  sentOf(id: string): SentMessage[];
  /** A message sent to conversation `id`; answers its id. */
  addSent(id: string, message: Omit<SentMessage, "id" | "queued" | "at">): number;
  /** What became of one: queued, or gone (refused, a duplicate, or in the transcript now). */
  updateSent(id: string, sent: number, change: "queued" | "gone"): void;
  /** Epoch ms of the last message sent to conversation `id` from this page, if one was. */
  lastSentAt(id: string): number | undefined;
}

let nextSent = 0;

/** The messages sent, held by the component that calls it (the app's provider, above its pages). */
export function useSentMessages(): SentMessages {
  const [sent, setSent] = useState<Record<string, SentMessage[]>>({});
  const [lastSent, setLastSent] = useState<Record<string, number>>({});
  const sentOf = useCallback((id: string): SentMessage[] => sent[id] ?? [], [sent]);
  const lastSentAt = useCallback((id: string): number | undefined => lastSent[id], [lastSent]);
  const addSent = useCallback((id: string, message: Omit<SentMessage, "id" | "queued" | "at">) => {
    const each = { ...message, id: nextSent++, queued: false, at: Date.now() };
    setSent((all) => ({ ...all, [id]: [...(all[id] ?? []), each] }));
    setLastSent((all) => ({ ...all, [id]: each.at }));
    return each.id;
  }, []);
  const updateSent = useCallback((id: string, which: number, change: "queued" | "gone") => {
    setSent((all) => {
      const list = all[id] ?? [];
      if (!list.some((each) => each.id === which)) return all;
      return { ...all, [id]: change === "gone" ? list.filter((each) => each.id !== which) : list.map((each) => (each.id === which ? { ...each, queued: true } : each)) };
    });
  }, []);
  return { sentOf, addSent, updateSent, lastSentAt };
}

const PAGE = 50;
/** How long after a message sent from here its run is expected, before it is seen going. */
const ANSWER_EXPECTED_MS = 30_000;
const CONTEXT = "pikit-context";

const errorOf = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

/** Follows `source` live while mounted and active, reconnecting after a dropped stream. */
export function useLive(source: Pick<ConversationSource, "id" | "follow">): LiveState & { paused: boolean } {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const active = useActive();
  const follow = useRef(source.follow);
  follow.current = source.follow;
  const id = source.id;

  // Another conversation: nothing of this one's stays.
  useEffect(() => dispatch({ type: "reset" }), [id]);

  useEffect(() => {
    if (!active) return;
    const stop = new AbortController();
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          const started = follow.current((event) => dispatch({ type: "event", event }), stop.signal);
          dispatch({ type: "connected" });
          await started;
        } catch {
          // Reconnect below.
        }
        // A stream stopped by this cleanup says nothing: the next one (another id, or a return) owns the state.
        if (stop.signal.aborted) return;
        dispatch({ type: "disconnected" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })();
    return () => stop.abort();
  }, [id, active]);

  return { ...state, paused: !active };
}

/** `page`'s entries, then the ones of `kept` it does not have: both newest first, as a source gives them. */
const newestFirst = (page: TranscriptEntry[], kept: TranscriptEntry[]): TranscriptEntry[] => {
  const ids = new Set(page.map((entry) => entry.id));
  return [...page, ...kept.filter((entry) => !ids.has(entry.id))];
};

/**
 * The transcript's latest page, read again `changes` after (the live stream said it changed), and
 * older pages on demand. What was read stays: as the conversation grows past a page, the latest page
 * leaves its oldest entries behind, and the thread keeps them (never losing its start, its turns never
 * shifting). Entries oldest first.
 */
export function useTranscript(source: Pick<ConversationSource, "id" | "transcript">, changes: number) {
  const id = source.id;
  const read = useRef(source.transcript);
  read.current = source.transcript;
  const [latest, setLatest] = useState<{ id: string; page: TranscriptPage }>();
  const [error, setError] = useState<Error>();
  const [round, setRound] = useState(0);
  const [kept, setKept] = useState<TranscriptEntry[]>([]);
  // Older pages read on from the first latest page's end: the later ones start past what is kept.
  const [cursor, setCursor] = useState<string | null>();
  const reload = useCallback(() => setRound((n) => n + 1), []);
  const page = latest?.id === id ? latest.page : undefined;

  useEffect(() => {
    setKept([]);
    setCursor(undefined);
    setError(undefined);
  }, [id]);

  useEffect(() => {
    let live = true;
    read.current({ limit: PAGE }).then(
      (value) => live && (setLatest({ id, page: value }), setError(undefined)),
      (thrown: unknown) => live && setError(errorOf(thrown)),
    );
    return () => {
      live = false;
    };
  }, [id, round]);

  useEffect(() => {
    if (page === undefined) return;
    setKept((items) => newestFirst(page.items, items));
    setCursor((current) => (current === undefined ? (page.next ?? null) : current));
  }, [page]);

  useEffect(() => {
    if (changes === 0) return;
    const timer = setTimeout(reload, 250);
    return () => clearTimeout(timer);
  }, [changes, reload]);

  const next = cursor === undefined ? page?.next : (cursor ?? undefined);
  const loadOlder = async () => {
    if (next === undefined) return;
    try {
      const older = await read.current({ limit: PAGE, cursor: next });
      setKept((items) => newestFirst(items, older.items));
      setCursor(older.next ?? null);
    } catch (thrown) {
      setError(errorOf(thrown));
    }
  };

  // Newest first from the source; shown oldest first.
  const entries = newestFirst(page?.items ?? [], kept).reverse();
  return { entries, loaded: page !== undefined, error, hasOlder: next !== undefined, loadOlder, reload };
}

/** The thread follows its end while the person is there; scrolling up to read releases it. */
export function useStickToBottom(scroller: RefObject<HTMLDivElement | null>, id: string) {
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    let stick = true;
    let raf = 0;
    const onScroll = () => {
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    const pin = () => {
      if (!stick) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(pin);
    resize.observe(content);
    const mutate = new MutationObserver(pin);
    mutate.observe(content, { childList: true, subtree: true, characterData: true });
    pin();
    return () => {
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
      mutate.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [scroller, id]);
}

/** Whether the Context panel shows (remembered in this browser; closed at first). */
export function useContextOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(CONTEXT) === "open";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(CONTEXT, next ? "open" : "closed");
    } catch {
      // Not remembered.
    }
  };
  return [open, set];
}

/** The transcript's entries and, after them, the ones the live stream announced it does not have yet. */
function mergedEntries(transcript: TranscriptEntry[], live: TranscriptEntry[]): TranscriptEntry[] {
  const read = new Set(transcript.map((entry) => entry.id));
  return [...transcript, ...live.filter((entry) => !read.has(entry.id))];
}

/** A message sent from here, as the transcript will have it. */
const sentMessage = (sent: SentMessage): UserMessage => ({
  role: "user",
  content: [...(sent.text === "" ? [] : [{ type: "text" as const, text: sent.text }]), ...sent.images.map((image) => ({ type: "image" as const, ...image }))],
});

/** A row of the app's own in the thread: before the first message written after `at`, else at its end. */
export interface ThreadNote {
  key: string;
  /** Epoch ms. */
  at: number;
  node: ReactNode;
}

/** What the app's composer takes besides what the view gives it (the send, the stop, whether a run goes). */
export type ComposerProps = Omit<ComponentProps<typeof PromptBar>, "onSend" | "busy" | "onStop" | "compact" | "placeholder"> & {
  /** The placeholder, given whether a run goes. */
  placeholder?: (busy: boolean) => string;
};

export interface ConversationViewProps {
  source: ConversationSource;
  /** The messages sent and not shown yet: the app's, kept above its pages. */
  sent: SentMessages;
  /** Who wrote the person's messages, when it is not the one reading (the dashboard: the conversation's key). */
  from?: string | undefined;
  composer?: ComposerProps;
  /** In place of the composer: why the conversation cannot be talked to (a reset left it behind). */
  closed?: ReactNode;
  /** Whether the Context panel may show (the dashboard: always; the chat: as the operator's policy says). */
  context?: boolean;
  /** Whether a tool call opens to what it returned (`ToolDetailsContext`); off where results are withheld. Default on. */
  toolDetails?: boolean;
  /** The header's actions, given the Context button when there is context to show: the app puts them where it wants. */
  actions?: (contextButton: ReactNode) => ReactNode;
  /** Where the Context panel goes (the dashboard: its side panel). Absent, right where the view is. */
  side?: (panel: ReactNode) => ReactNode;
  /** Rows of the app's own in the thread (the dashboard's commands' notes). */
  notes?: readonly ThreadNote[];
  /** The live stream said the conversation changed (a message, its usage): read what the app shows of it again. */
  onChange?: () => void;
  /** The first words written in it, once its start is read: its name until it has a title. */
  onFirstText?: (text: string) => void;
}

/** The thread, the activity line, the floating composer and the Context panel of one conversation. */
export function ConversationView({ source, sent, from, composer = {}, closed, context = true, toolDetails = true, actions, side, notes = [], onChange, onFirstText }: ConversationViewProps) {
  const id = source.id;
  const live = useLive(source);
  const transcript = useTranscript(source, live.changes);
  const [contextOpen, setContextOpen] = useContextOpen();
  const [actionError, setActionError] = useState<Error>();
  const [note, setNote] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(150);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    if (live.changes === 0) return;
    const timer = setTimeout(() => changed.current?.(), 250);
    return () => clearTimeout(timer);
  }, [live.changes, live.busy]);

  const read = mergedEntries(transcript.entries, live.entries).flatMap((entry) => entry.messages as Message[]);
  // An answer that ended between two snapshots (a reconnect) stays as it was last seen until the transcript has it.
  const ended = live.ended.filter(
    (each) => each.timestamp !== live.partial?.timestamp && !read.some((message) => message.role === "assistant" && message.timestamp === each.timestamp),
  );
  const messages = ended.length === 0 ? read : [...read, ...ended];
  const turns = turnsOf(messages, live);

  // The messages sent from here the conversation does not show yet.
  const sameText = (text: string) => messages.filter((message) => message.role === "user" && userText(message).text.trim() === text).length;
  const allSent = sent.sentOf(id);
  const sentShown = allSent.filter((each) => sameText(each.text) <= each.before);
  const { updateSent } = sent;
  const arrived = allSent
    .filter((each) => !sentShown.includes(each))
    .map((each) => each.id)
    .join();
  useEffect(() => {
    for (const each of arrived.split(",")) if (each !== "") updateSent(id, Number(each), "gone");
  }, [arrived, id, updateSent]);
  // The texts of the messages sent the thread has just shown (in the render that swaps the sent bubble
  // for its own, before the effect above lets them go): that bubble mounts still, the sent one rose in.
  const arrivedTexts = new Set(allSent.filter((each) => !sentShown.includes(each)).map((each) => each.text));

  // The first words written in it, once its start is read.
  const firstText = transcript.hasOlder ? undefined : turns.map((turn) => (turn.kind === "user" ? userText(turn.message).text.trim() : "")).find((text) => text !== "");
  useEffect(() => {
    if (firstText !== undefined) onFirstText?.(firstText);
  }, [firstText, onFirstText]);

  useStickToBottom(scrollRef, id);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const measure = () => setComposerH(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (note === undefined) return;
    const timer = setTimeout(() => setNote(undefined), 6000);
    return () => clearTimeout(timer);
  }, [note]);

  // The run goes, said once at the thread's end until it ends, so an answer between two snapshots (a
  // reconnect) never looks finished before it is. A message sent from here starts one at once: from the
  // send, through its arrival in the transcript, to the run seen going, it never blinks off.
  const last = turns.at(-1);
  const sentAt = sent.lastSentAt(id);
  const answering = last?.kind === "user" && sentAt !== undefined && Date.now() - sentAt < ANSWER_EXPECTED_MS;
  const waiting = live.busy || sentShown.some((each) => !each.queued) || answering;
  // Once the reply ends on its thinking and calls, that group's header says the run goes, until text
  // follows it (between two steps too, while nothing streams): no second line, and no blinking from one
  // to the other.
  const lastSegment = last?.kind === "reply" ? last.segments.at(-1) : undefined;
  const stepsGoing = waiting && (lastSegment?.kind === "thinking" || lastSegment?.kind === "tools");
  const activity = stepsGoing ? undefined : live.partial?.content.at(-1)?.type === "text" ? "Writing" : "Thinking";
  // One count per answer: from the message it answers, not from each of its steps.
  const since = sentShown.at(-1)?.at ?? (answering ? sentAt : [...messages].reverse().find((message) => message.role === "user" && message.timestamp !== undefined)?.timestamp);

  const send = async (message: ComposerMessage) => {
    const { text, images } = message;
    const sentId = sent.addSent(id, { text, images: images.map(({ mimeType, data }) => ({ mimeType, data })), before: sameText(text) });
    // Sending follows the thread to its end, wherever the person had scrolled.
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
    try {
      const answer = await source.send(message);
      setActionError(undefined);
      if (answer.admission === "duplicate") {
        updateSent(id, sentId, "gone");
        setNote("Already sent.");
      } else if (answer.admission === "queued") updateSent(id, sentId, "queued");
      // In case the live stream is not there to announce it.
      transcript.reload();
    } catch (thrown) {
      updateSent(id, sentId, "gone");
      setActionError(errorOf(thrown));
      throw thrown;
    }
  };
  const stop = () => {
    source.abort().then(
      () => setActionError(undefined),
      (thrown: unknown) => setActionError(errorOf(thrown)),
    );
  };
  const { onCommand, placeholder, ...rest } = composer;
  const runCommand =
    onCommand === undefined
      ? undefined
      : async (name: string, args: string) => {
          try {
            await onCommand(name, args);
            setActionError(undefined);
          } catch (thrown) {
            setActionError(errorOf(thrown));
            throw thrown;
          }
        };

  // The Context button shows only when there is something to show there.
  const contextImages = context ? imagesOf(messages) : [];
  const contextSources = context ? sourcesOf(messages) : [];
  const hasContext = contextImages.length > 0 || contextSources.length > 0;
  const panel = contextOpen && hasContext ? <ContextPanel images={contextImages} sources={contextSources} onClose={() => setContextOpen(false)} /> : undefined;

  /** The app's notes before turn `i`: written after the user turn before it, at most at its message. */
  const notesBefore = (i: number, at: number | undefined) =>
    notes.filter((each) => each.at <= (at ?? 0) && !turns.slice(0, i).some((before) => before.kind === "user" && each.at <= (before.message.timestamp ?? 0)));

  return (
    <ToolDetailsContext.Provider value={toolDetails}>
    <div className="chat relative flex min-h-0 flex-1 flex-col">
      {actions?.(hasContext ? <ContextButton open={contextOpen} onToggle={() => setContextOpen(!contextOpen)} /> : undefined)}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* room between the thread's end and the composer floating over it */}
        <div className="flex flex-col gap-8 px-4 pt-8 sm:px-8 lg:px-12" style={{ paddingBottom: composerH + 56 }}>
          {transcript.hasOlder && (
            <div className="mx-auto w-full max-w-[720px]">
              <button type="button" onClick={() => void transcript.loadOlder()} className="btn btn-outline btn-xs mx-auto flex chat-text-12.5 text-ink-2 hover:text-ink">
                Earlier messages
              </button>
            </div>
          )}
          {transcript.error !== undefined && (
            <div className="mx-auto w-full max-w-[720px]">
              <ErrorNote error={transcript.error} />
            </div>
          )}
          {!transcript.loaded && transcript.error === undefined && sentShown.length === 0 && (
            <div className="mx-auto flex w-full max-w-[720px] items-center gap-2.5 chat-text-13 text-ink-3">
              <LoaderGrid /> Loading the conversation
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={turn.key} className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
              {turn.kind === "user" && notesBefore(i, turn.message.timestamp).map((each) => <Fragment key={each.key}>{each.node}</Fragment>)}
              {turn.kind === "user" ? <UserBubble message={turn.message} animate={!arrivedTexts.has(userText(turn.message).text.trim())} {...(from !== undefined && { from })} /> : <Reply segments={turn.segments} going={stepsGoing && i === turns.length - 1} />}
            </div>
          ))}
          {notes
            .filter((each) => !turns.some((turn) => turn.kind === "user" && each.at <= (turn.message.timestamp ?? 0)))
            .map((each) => (
              <div key={each.key} className="mx-auto w-full max-w-[720px]">
                {each.node}
              </div>
            ))}
          {sentShown.map((each) => (
            <div key={`sent-${each.id}`} className={`mx-auto flex w-full max-w-[720px] flex-col items-end gap-1 transition-opacity duration-200 ${each.queued ? "opacity-60" : ""}`}>
              <UserBubble message={sentMessage(each)} />
              {each.queued && <span className="px-1 chat-text-11.5 text-ink-3">Queued: it runs once the run going ends</span>}
            </div>
          ))}
          {/* one line at the end, whatever comes before it: it stays put, and never mounts again as the thread grows */}
          {waiting && activity !== undefined && (
            <div key="activity" className="mx-auto -mt-4 flex min-h-6 w-full max-w-[720px] items-center" style={{ animation: "fade-in 150ms ease-out both" }}>
              <LoadingState label={activity} variant="Dots" since={since} />
            </div>
          )}
          {transcript.loaded && turns.length === 0 && notes.length === 0 && sentShown.length === 0 && !live.busy && <p className="mx-auto w-full max-w-[720px] chat-text-13.5 text-ink-3">No messages yet.</p>}
        </div>
      </div>

      {/* soft fade so content dissolves into the bar instead of hard-clipping */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: composerH + 32, background: "linear-gradient(to top, var(--page) 64%, transparent)" }} />

      {/* the composer floats over the thread; content scrolls behind it */}
      <div ref={composerRef} className="absolute inset-x-0 bottom-0 px-4 pb-6 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-[720px] flex-col gap-2">
          {actionError !== undefined && <ErrorNote error={actionError} title="That did not work" />}
          {closed ?? (
            <>
              <PromptBar
                compact
                placeholder={placeholder?.(live.busy) ?? (live.busy ? "Reply: it runs after the run going" : "Reply")}
                {...rest}
                {...(runCommand !== undefined && { onCommand: runCommand })}
                busy={live.busy}
                onStop={stop}
                onSend={send}
              />
              {note !== undefined && <p className="px-1 text-center chat-text-12 text-ink-3">{note}</p>}
            </>
          )}
        </div>
      </div>

      {panel !== undefined && (side === undefined ? panel : side(panel))}
    </div>
    </ToolDetailsContext.Provider>
  );
}
