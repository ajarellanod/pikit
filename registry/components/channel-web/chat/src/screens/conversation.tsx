/**
 * One conversation, live: its messages (newest at the bottom, older pages on demand), the answer as
 * it is written (`partial` events, markdown), the tool running now (its name), a stop button while a
 * run goes, and the composer (text and images).
 *
 * A message sent shows at once, where it goes: "Sending", then "Queued" when it waits for the run
 * going, or "Not sent" with why and "Send again" (the same request id: never answered twice). One the
 * run failed on says so, with "Send again" (a new message). The messages are read again when the live
 * stream says one was stored, after a reconnection, and every few seconds while an answer is awaited
 * without a stream.
 */

import { EditPencil, Trash } from "iconoir-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import LoadingState, { LoaderGrid } from "@/components/bui/LoadingState";
import PromptBar, { type ComposerMessage } from "@/components/bui/PromptBar";
import { ErrorNote } from "@/components/pikit/error-note";
import { Reply, UserBubble, type UserMessage } from "@/components/pikit/message";
import { every, usePolling } from "@/lib/activity";
import type { ChatConversation, ChatImage, ChatMessage, ChatPage } from "@/lib/chat-api";
import { get, post, useGet } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { asError, ChatFailure } from "@/lib/errors";
import { imageLimits, messageProblem } from "@/lib/images";
import { useLive } from "@/lib/live";
import { liveTexts } from "@/lib/live-state";
import { discard, type Outgoing, sendTo, settle, useOutbox } from "@/lib/outbox";
import { usePageTitle, useSession } from "@/lib/session";
import { titleOf, useChatActions } from "./layout";

const PAGE = 50;
/** Without a live stream, how often the messages are read while an answer is awaited. */
const POLL_MS = 5000;

/** A message as the shared bubble takes it (pi-ai's user message). */
export const userMessageOf = (text: string, images: readonly ChatImage[] = []): UserMessage => ({
  role: "user",
  content: [...(text === "" ? [] : [{ type: "text" as const, text }]), ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data }))],
});

/** An answer, as the shared reply shows one: its markdown. */
function Answer({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <Reply segments={[{ kind: "text", text, streaming }]} />;
}

/** `page`'s messages, then those of `kept` it does not have: both newest first, as the API gives them. */
const newestFirst = (page: ChatMessage[], kept: ChatMessage[]): ChatMessage[] => {
  const ids = new Set(page.map((message) => message.id));
  return [...page, ...kept.filter((message) => !ids.has(message.id))];
};

/**
 * The messages' latest page, read again on `read()`, and older pages on demand; what was read stays.
 * `onRead` is told each read's messages and the `changes` it started at.
 */
function useMessages(chatId: string, changes: number, onRead: (changes: number, messages: ChatMessage[]) => void) {
  const [kept, setKept] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error>();
  const [cursor, setCursor] = useState<string | null>();
  const changesNow = useRef(changes);
  changesNow.current = changes;
  const told = useRef(onRead);
  told.current = onRead;
  const base = `/conversations/${encodeURIComponent(chatId)}/messages?limit=${PAGE}`;

  const read = useCallback(() => {
    const at = changesNow.current;
    get<ChatPage<ChatMessage>>(base).then(
      (page) => {
        setKept((items) => newestFirst(page.items, items));
        setCursor((current) => (current === undefined ? (page.next ?? null) : current));
        setLoaded(true);
        setError(undefined);
        told.current(at, page.items);
      },
      (thrown: unknown) => setError(asError(thrown)),
    );
  }, [base]);

  useEffect(read, [read]);
  useEffect(() => {
    if (changes === 0) return;
    const timer = setTimeout(read, 250);
    return () => clearTimeout(timer);
  }, [changes, read]);

  const loadOlder = async () => {
    if (cursor === undefined || cursor === null) return;
    try {
      const older = await get<ChatPage<ChatMessage>>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      setKept((items) => newestFirst(items, older.items));
      setCursor(older.next ?? null);
    } catch (thrown) {
      setError(asError(thrown));
    }
  };

  return { messages: [...kept].reverse(), loaded, error, hasOlder: typeof cursor === "string", loadOlder, read };
}

/** The thread follows its end while the person is there; scrolling up to read releases it. */
function useStickToBottom(scroller: RefObject<HTMLDivElement | null>, id: string) {
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

/** A quiet line under a message of the user's, with its actions. */
function MessageNote({ tone = "quiet", children, actions }: { tone?: "quiet" | "problem"; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-1 chat-text-11.5 ${tone === "problem" ? "text-red" : "text-ink-3"}`}>
      <span className="[overflow-wrap:anywhere]">{children}</span>
      {actions}
    </div>
  );
}

function NoteButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="rounded-[6px] px-1.5 py-0.5 font-medium text-ink-2 shadow-btn transition-colors duration-100 hover:bg-hover hover:text-ink">
      {children}
    </button>
  );
}

function OutgoingRow({ chatId, item, onSent }: { chatId: string; item: Outgoing; onSent: () => void }) {
  return (
    <div className={`mx-auto flex w-full max-w-[720px] flex-col items-end gap-1 transition-opacity duration-200 ${item.status === "sending" || item.queued === true ? "opacity-70" : ""}`}>
      <UserBubble message={userMessageOf(item.text, item.images)} animate />
      {item.status === "sending" && <MessageNote>Sending…</MessageNote>}
      {item.status === "sent" && item.queued === true && <MessageNote>Queued: it runs once the answer going ends</MessageNote>}
      {item.status === "failed" && (
        <MessageNote
          tone="problem"
          actions={
            <>
              <NoteButton onClick={() => void sendTo(chatId, { requestId: item.requestId, text: item.text, images: item.images }).then(onSent)}>Send again</NoteButton>
              <NoteButton onClick={() => discard(chatId, item.requestId)}>Remove</NoteButton>
            </>
          }
        >
          Not sent: {item.error ?? "it failed"}
        </MessageNote>
      )}
    </div>
  );
}

export function ConversationScreen({ chatId }: { chatId: string }) {
  const { config } = useSession();
  const conversations = useConversations();
  const actions = useChatActions();
  const live = useLive(chatId);
  const summary = useGet<ChatConversation>(`/conversations/${encodeURIComponent(chatId)}`);
  const { dispatch } = live;
  const thread = useMessages(
    chatId,
    live.changes,
    useCallback(
      (changes: number, messages: ChatMessage[]) => {
        dispatch({ type: "read", changes, texts: messages.filter((message) => message.role === "assistant").map((message) => message.text) });
        settle(chatId, new Set(messages.map((message) => message.id)));
      },
      [chatId, dispatch],
    ),
  );
  const outbox = useOutbox(chatId);
  const [actionError, setActionError] = useState<Error>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(120);
  const conversation = summary.data?.id === chatId ? summary.data : undefined;
  usePageTitle(config.name, conversation === undefined ? undefined : titleOf(conversation));

  // The list's busy flags and titles follow what happens here.
  const { reload: reloadSummary } = summary;
  const { reload: reloadList } = conversations;
  useEffect(() => {
    if (live.changes === 0) return;
    const timer = setTimeout(() => (reloadSummary(), reloadList()), 400);
    return () => clearTimeout(timer);
  }, [live.changes, reloadSummary, reloadList]);

  useStickToBottom(scrollRef, chatId);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const measure = () => setComposerH(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const read = new Set(thread.messages.map((message) => message.id));
  const unsent = outbox.filter((item) => !read.has(item.requestId));
  const answers = thread.messages.filter((message) => message.role === "assistant").map((message) => message.text);
  const { ended, partial } = liveTexts(live, answers);
  const busy = live.connected ? live.busy : (conversation?.busy ?? false);
  const lastUser = [...thread.messages].reverse().find((message) => message.role === "user");
  const awaiting = lastUser?.state === "pending" || unsent.some((item) => item.status !== "failed");
  const waiting = busy || unsent.some((item) => item.status === "sent" && item.queued !== true);
  const tool = live.tools.at(-1);
  const activity = tool !== undefined ? `Running ${tool}` : partial !== undefined && partial !== "" ? "Writing" : "Thinking";
  const since = unsent.at(-1)?.at ?? lastUser?.at;

  // Without a stream (paused, or failing), an answer awaited is polled for.
  usePolling(thread.read, !live.connected && !live.paused && (busy || awaiting) ? every(POLL_MS) : undefined);

  const send = async ({ text, images }: ComposerMessage) => {
    const chatImages = images.map(({ mimeType, data }) => ({ mimeType, data }));
    const problem = messageProblem(text, chatImages, config.target);
    if (problem !== undefined) {
      setActionError(new Error(problem));
      throw new Error(problem);
    }
    setActionError(undefined);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
    // Read again once it is taken, in case the live stream is not there to say so.
    void sendTo(chatId, { text, images: chatImages }).then(thread.read);
  };
  const sendAgain = (message: ChatMessage) => void sendTo(chatId, { text: message.text, images: message.images ?? [] }).then(thread.read);
  const stop = () => {
    post(`/conversations/${encodeURIComponent(chatId)}/abort`).then(
      () => setActionError(undefined),
      (thrown: unknown) => setActionError(asError(thrown)),
    );
  };

  if (summary.error !== undefined && conversation === undefined) {
    const missing = summary.error instanceof ChatFailure && summary.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-[720px] p-6 sm:p-8">
        <ErrorNote error={summary.error} title={missing ? "No such conversation" : "This conversation cannot be read"} />
        <a href="#/" className="mt-4 inline-block text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-2">
          Start a new one
        </a>
      </div>
    );
  }

  return (
    <div className="chat relative flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3 sm:px-4">
        <h1 className="min-w-0 flex-1 truncate chat-text-13.5 font-medium text-ink">{conversation === undefined ? "" : titleOf(conversation)}</h1>
        {conversation !== undefined && (
          <>
            <button
              type="button"
              aria-label="Rename the conversation"
              title="Rename"
              onClick={() => actions.rename(conversation)}
              className="flex size-8 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
            >
              <EditPencil width={16} height={16} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              aria-label="Delete the conversation"
              title="Delete"
              onClick={() => actions.remove(conversation)}
              className="flex size-8 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-red"
            >
              <Trash width={16} height={16} strokeWidth={1.9} />
            </button>
          </>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-live="polite" aria-busy={waiting}>
        <div className="flex flex-col gap-8 px-4 pt-8 sm:px-8 lg:px-12" style={{ paddingBottom: composerH + 48 }}>
          {thread.hasOlder && (
            <div className="mx-auto w-full max-w-[720px]">
              <button type="button" onClick={() => void thread.loadOlder()} className="mx-auto flex h-7 items-center rounded-full px-3 chat-text-12.5 font-medium text-ink-2 shadow-btn transition-colors duration-100 hover:bg-hover">
                Earlier messages
              </button>
            </div>
          )}
          {thread.error !== undefined && (
            <div className="mx-auto w-full max-w-[720px]">
              <ErrorNote error={thread.error} title="The messages cannot be read" />
            </div>
          )}
          {!thread.loaded && thread.error === undefined && unsent.length === 0 && (
            <div className="mx-auto flex w-full max-w-[720px] items-center gap-2.5 chat-text-13 text-ink-3">
              <LoaderGrid /> Loading the conversation
            </div>
          )}
          {thread.messages.map((message) => (
            <div key={message.id} className="mx-auto flex w-full max-w-[720px] flex-col gap-1">
              {message.role === "user" ? (
                <>
                  <UserBubble message={userMessageOf(message.text, message.images)} />
                  {message.state === "failed" && (
                    <MessageNote tone="problem" actions={<NoteButton onClick={() => sendAgain(message)}>Send again</NoteButton>}>
                      Not answered: something failed
                    </MessageNote>
                  )}
                  {message.state === "aborted" && <MessageNote>Stopped</MessageNote>}
                </>
              ) : (
                <Answer text={message.text} />
              )}
            </div>
          ))}
          {unsent.map((item) => (
            <OutgoingRow key={item.requestId} chatId={chatId} item={item} onSent={thread.read} />
          ))}
          {ended.map((text, i) => (
            <div key={`ended-${i}`} className="mx-auto w-full max-w-[720px]">
              <Answer text={text} />
            </div>
          ))}
          {partial !== undefined && partial !== "" && (
            <div className="mx-auto w-full max-w-[720px]">
              <Answer text={partial} streaming />
            </div>
          )}
          {waiting && (
            <div className="mx-auto -mt-4 flex min-h-6 w-full max-w-[720px] items-center" style={{ animation: "fade-in 200ms ease-out both" }}>
              <LoadingState label={activity} variant="Dots" since={since} />
            </div>
          )}
          {thread.loaded && thread.messages.length === 0 && unsent.length === 0 && !waiting && <p className="mx-auto w-full max-w-[720px] chat-text-13.5 text-ink-3">No messages yet.</p>}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: composerH + 32, background: "linear-gradient(to top, var(--page) 64%, transparent)" }} />

      <div ref={composerRef} className="absolute inset-x-0 bottom-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8 sm:pb-6 lg:px-12">
        <div className="mx-auto flex max-w-[720px] flex-col gap-2">
          {actionError !== undefined && <ErrorNote error={actionError} title="That did not work" />}
          <PromptBar compact placeholder={busy ? "Reply: it runs after the answer going" : "Reply"} images={imageLimits(config.target)} busy={busy} onStop={stop} onSend={send} />
        </div>
      </div>
    </div>
  );
}
