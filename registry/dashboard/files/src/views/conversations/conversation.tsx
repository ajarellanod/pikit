/**
 * One conversation, live: its transcript, the answer being written, the thinking and the tools
 * running; and what an operator does to it (SPEC §5): a message (with images, a web search), a stop,
 * a reset. Its top bar holds nothing but two buttons: the Context panel (the images sent in it, what
 * its web searches and fetches found) and a menu with the reset. Its composer shows its assistant: a
 * conversation never changes agent, so picking another starts a new chat with it.
 *
 * The dashboard is a channel of its own: a message from here is a follow-up (it waits for a run
 * going) whose answer stays here. In another channel's conversation nothing said here reaches that
 * channel's chat (the agent reads that the message is the operator's, and that the user sees neither
 * it nor the answer); a run that also answers a user's message is delivered to the user, as always.
 */

import { MoreHoriz, Refresh, SidebarExpand } from "iconoir-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import GlideMenu from "@/components/bui/GlideMenu";
import { LoaderGrid } from "@/components/bui/LoadingState";
import PromptBar, { type ComposerMessage } from "@/components/bui/PromptBar";
import { ErrorNote } from "@/components/pikit/error-note";
import { type Message, Reply, turnsOf, UserBubble, userText } from "@/components/pikit/message";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isDashboardKey } from "@/lib/admin-api";
import { api, type ApiConversation, type ApiPage, type ApiResetResponse, type ApiSendResponse, type ApiTranscriptEntry, post, useApi } from "@/lib/api";
import { agentsOf, useChats } from "@/lib/chats";
import { navigate, pagePath } from "@/lib/router";
import { SidePanel, TabActions, useShell } from "@/lib/shell";
import { attachmentsOf, composerCommands, imageLimits, webSearchOf } from "./composer";
import { ContextPanel } from "./context";
import { useLive } from "./live";
import { imagesOf, sourcesOf } from "./sources";

const PAGE = 50;
const CONTEXT = "pikit-context";

/** The transcript's latest page, read again when the conversation changes, and older pages on demand. */
function useTranscript(id: string, changes: number) {
  const latest = useApi<ApiPage<ApiTranscriptEntry>>(`/conversations/${encodeURIComponent(id)}/transcript?limit=${PAGE}`);
  const [older, setOlder] = useState<ApiTranscriptEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const { reload } = latest;

  useEffect(() => {
    if (changes === 0) return;
    const timer = setTimeout(reload, 250);
    return () => clearTimeout(timer);
  }, [changes, reload]);

  const next = cursor === undefined ? latest.data?.next : (cursor ?? undefined);
  const loadOlder = async () => {
    if (next === undefined) return;
    const page = await api<ApiPage<ApiTranscriptEntry>>(`/conversations/${encodeURIComponent(id)}/transcript?limit=${PAGE}&cursor=${encodeURIComponent(next)}`);
    setOlder((items) => [...items, ...page.items]);
    setCursor(page.next ?? null);
  };

  // Newest first from the API; shown oldest first.
  const seen = new Set<string>();
  const entries = [...(latest.data?.items ?? []), ...older].filter((entry) => !seen.has(entry.id) && seen.add(entry.id)).reverse();
  return { entries, loaded: latest.data !== undefined, error: latest.error, hasOlder: next !== undefined, loadOlder };
}

/** Whether the Context panel shows (remembered in this browser; closed at first). */
function useContextOpen(): [boolean, (open: boolean) => void] {
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

/** The conversation's menu: its reset, which `onReset` confirms first. */
function ConversationMenu({ actionable, onReset }: { actionable: boolean; onReset: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-conversation-menu]")) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div data-conversation-menu className="relative">
      <button
        type="button"
        aria-label="Conversation actions"
        aria-expanded={open}
        disabled={!actionable}
        onClick={() => setOpen((current) => !current)}
        className="flex size-7 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-40"
      >
        <MoreHoriz width={16} height={16} strokeWidth={2} />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1.5 w-56 rounded-[14px] bg-surface p-1.5 shadow-overlay" style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}>
          <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
            <button
              data-menu-row
              type="button"
              onClick={() => {
                setOpen(false);
                onReset();
              }}
              className="relative z-10 flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[13.5px] text-red"
            >
              <Refresh width={16} height={16} strokeWidth={1.9} />
              Reset conversation…
            </button>
          </GlideMenu>
        </div>
      )}
    </div>
  );
}

/** The reset, confirmed: the key starts again in a new conversation, which the page follows. */
function ResetDialog({ conversation, open, onOpenChange, onError }: { conversation: ApiConversation; open: boolean; onOpenChange: (open: boolean) => void; onError: (error: Error | undefined) => void }) {
  const chats = useChats();
  const reset = async () => {
    onError(undefined);
    try {
      const done = await post<ApiResetResponse>(`/conversations/${encodeURIComponent(conversation.conversationId)}/reset`);
      chats.replaced(conversation.conversationId, done.conversationId);
      chats.reload();
      navigate(pagePath("/conversations", done.conversationId), { replace: true });
    } catch (thrown) {
      onError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset this conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            {isDashboardKey(conversation.key) ? "This chat" : conversation.key} starts again with an empty history. This conversation is kept and stays readable here; a run still going finishes in it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-red text-white hover:bg-red/90" onClick={() => void reset()}>
            Reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The thread follows its end while the operator is there; scrolling up to read releases it. */
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

export function ConversationPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const chats = useChats();
  const { app, agents: described, views, newChat } = useShell();
  const agents = agentsOf(app);
  const live = useLive(id);
  const summary = useApi<ApiConversation>(`/conversations/${encodeURIComponent(id)}`);
  const transcript = useTranscript(id, live.changes);
  const [contextOpen, setContextOpen] = useContextOpen();
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<Error>();
  const [note, setNote] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(150);
  const { reload } = summary;
  const conversation = summary.data?.conversationId === id ? summary.data : undefined;

  useEffect(() => {
    if (live.changes === 0) return;
    const timer = setTimeout(reload, 250);
    return () => clearTimeout(timer);
  }, [live.changes, live.busy, reload]);

  const { openTab, setTitle } = chats;
  useEffect(() => {
    if (conversation !== undefined) openTab(conversation);
  }, [conversation, openTab]);

  const messages = transcript.entries.flatMap((entry) => entry.messages as Message[]);
  const turns = turnsOf(messages, live);

  // A dashboard key is titled by the first words written in it, once read (a title it has is kept).
  const firstText = transcript.hasOlder ? undefined : turns.map((turn) => (turn.kind === "user" ? userText(turn.message).text.trim() : "")).find((text) => text !== "");
  useEffect(() => {
    if (conversation?.key !== undefined && isDashboardKey(conversation.key) && firstText !== undefined) setTitle(conversation.key, firstText);
  }, [conversation, firstText, setTitle]);

  useStickToBottom(scrollRef, id);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const measure = () => setComposerH(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [conversation?.current]);

  useEffect(() => {
    if (note === undefined) return;
    const timer = setTimeout(() => setNote(undefined), 6000);
    return () => clearTimeout(timer);
  }, [note]);

  if (summary.error !== undefined) {
    return (
      <div className="mx-auto w-full max-w-[720px] p-8">
        <ErrorNote error={summary.error} title="This conversation cannot be read" />
      </div>
    );
  }

  // Waiting for the model: the run goes and nothing is being written or run.
  const streaming = live.partial !== undefined || live.tools.length > 0;
  const waiting = live.busy && !streaming;
  const last = turns.at(-1);
  const since = [...messages].reverse().find((message) => message.timestamp !== undefined)?.timestamp;
  const dashboardOwn = isDashboardKey(conversation?.key);
  const actionable = conversation?.current === true;
  const webSearch = webSearchOf(described, conversation?.agent);
  const send = async ({ text, images, webSearch: search }: ComposerMessage) => {
    if (conversation === undefined) return;
    try {
      const sent = await post<ApiSendResponse>(`/conversations/${encodeURIComponent(conversation.conversationId)}/messages`, {
        text,
        ...(images.length > 0 && { attachments: attachmentsOf(images) }),
        ...(search && { webSearch: true }),
      });
      setActionError(undefined);
      setNote(sent.admission === "queued" ? "Sent: it runs once the run going ends." : sent.admission === "duplicate" ? "Already sent." : undefined);
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      throw thrown;
    }
  };
  const stop = () => {
    if (conversation === undefined) return;
    post(`/conversations/${encodeURIComponent(conversation.conversationId)}/abort`).then(
      () => setActionError(undefined),
      (thrown: unknown) => setActionError(thrown instanceof Error ? thrown : new Error(String(thrown))),
    );
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {conversation !== undefined && (
        <TabActions>
          <button
            type="button"
            aria-label="Context"
            aria-pressed={contextOpen}
            title="Context: the images sent here, and what its web searches and fetches found"
            onClick={() => setContextOpen(!contextOpen)}
            className={`hidden size-7 items-center justify-center rounded-[7px] transition-colors duration-100 lg:flex ${contextOpen ? "bg-hover-2 text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
          >
            <SidebarExpand width={16} height={16} strokeWidth={1.9} />
          </button>
          <ConversationMenu actionable={actionable} onReset={() => setConfirming(true)} />
        </TabActions>
      )}
      {conversation !== undefined && <ResetDialog conversation={conversation} open={confirming} onOpenChange={setConfirming} onError={setActionError} />}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-8 px-4 pt-8 sm:px-8 lg:px-12" style={{ paddingBottom: composerH + 16 }}>
          {transcript.hasOlder && (
            <div className="mx-auto w-full max-w-[720px]">
              <button type="button" onClick={() => void transcript.loadOlder()} className="mx-auto flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium text-ink-2 shadow-btn transition-colors duration-100 hover:bg-hover">
                Earlier messages
              </button>
            </div>
          )}
          {transcript.error !== undefined && (
            <div className="mx-auto w-full max-w-[720px]">
              <ErrorNote error={transcript.error} />
            </div>
          )}
          {!transcript.loaded && transcript.error === undefined && (
            <div className="mx-auto flex w-full max-w-[720px] items-center gap-2.5 text-[13px] text-ink-3">
              <LoaderGrid /> Loading the conversation
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={turn.key} className="mx-auto w-full max-w-[720px]">
              {turn.kind === "user" ? (
                <UserBubble message={turn.message} from={conversation?.key} />
              ) : (
                <Reply segments={turn.segments} waiting={waiting && i === turns.length - 1} since={since} />
              )}
            </div>
          ))}
          {waiting && last?.kind !== "reply" && (
            <div className="mx-auto w-full max-w-[720px]">
              <Reply segments={[]} waiting since={since} />
            </div>
          )}
          {transcript.loaded && turns.length === 0 && !live.busy && <p className="mx-auto w-full max-w-[720px] text-[13.5px] text-ink-3">No messages yet.</p>}
        </div>
      </div>

      {/* soft fade so content dissolves into the bar instead of hard-clipping */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: composerH + 32, background: "linear-gradient(to top, var(--page) 64%, transparent)" }} />

      {/* the composer floats over the thread; content scrolls behind it */}
      <div ref={composerRef} className="absolute inset-x-0 bottom-0 px-4 pb-6 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-[720px] flex-col gap-2">
          {actionError !== undefined && <ErrorNote error={actionError} title="That did not work" />}
          {conversation !== undefined && conversation.current !== true ? (
            <p className="rounded-card bg-inset px-3 py-2.5 text-[13px] text-ink-2 shadow-hairline">
              {conversation.current === false ? "A reset left this conversation behind: it can be read, not talked to." : "No message has reached this conversation yet."}
            </p>
          ) : (
            <>
              <PromptBar
                placeholder={live.busy ? "Reply: it runs after the run going" : "Reply"}
                disabled={conversation === undefined}
                picker={
                  conversation?.agent === undefined
                    ? undefined
                    : {
                        label: "assistant",
                        options: (agents.includes(conversation.agent) ? agents : [conversation.agent, ...agents]).map((name) => ({
                          key: name,
                          name,
                          ...(name !== conversation.agent && { tag: "new chat" }),
                        })),
                        value: conversation.agent,
                        onChange: (agent) => newChat(agent),
                        note: "A chat keeps its assistant: another one starts a new chat with it.",
                      }
                }
                images={imageLimits(app)}
                webSearch={webSearch}
                commands={composerCommands({
                  views,
                  newChat: () => newChat(),
                  ...(live.busy && { stop }),
                  ...(actionable && { reset: () => setConfirming(true) }),
                  webSearch: webSearch.available,
                  assistants: agents.length > 1,
                })}
                busy={live.busy}
                onStop={stop}
                onSend={send}
              />
              {(note !== undefined || (conversation !== undefined && !dashboardOwn)) && (
                <p className="px-1 text-center text-[12px] text-ink-3">
                  {note ?? `Only you see what you write here, and its answer: nothing reaches ${conversation?.key}'s chat.`}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {contextOpen && conversation !== undefined && (
        <SidePanel>
          <ContextPanel images={imagesOf(messages)} sources={sourcesOf(messages)} onClose={() => setContextOpen(false)} />
        </SidePanel>
      )}
    </div>
  );
}
