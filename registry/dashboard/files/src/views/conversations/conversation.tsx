/**
 * One conversation, live: its transcript, the answer being written and the tools running, its cost;
 * and what an operator does to it (SPEC §5): a message that steers the run, an abort, a reset.
 */

import { ArrowLeft, Loader2, RotateCcw, Send, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote } from "@/components/pikit/error-note";
import { type Message, MessageView } from "@/components/pikit/message";
import { api, type ApiConversation, type ApiPage, type ApiResetResponse, type ApiSendResponse, type ApiTranscriptEntry, post, useApi } from "@/lib/api";
import { formatCost, formatTokens } from "@/lib/format";
import { Link, navigate } from "@/lib/router";
import { useLive } from "./live";
import { Status } from "./list";

const PAGE = 50;

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
  return { entries, error: latest.error, hasOlder: next !== undefined, loadOlder };
}

function Actions({ conversation, busy }: { conversation: ApiConversation; busy: boolean }) {
  const [error, setError] = useState<Error>();
  const [working, setWorking] = useState(false);
  const actionable = conversation.current === true;
  const path = `/conversations/${encodeURIComponent(conversation.conversationId)}`;

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setError(undefined);
    try {
      await action();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!actionable || !busy || working} onClick={() => void run(() => post(`${path}/abort`))}>
          <Square /> Abort run
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={!actionable || working}>
              <RotateCcw /> Reset
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset this conversation?</AlertDialogTitle>
              <AlertDialogDescription>
                {conversation.key} starts again with an empty history. This conversation is kept and stays readable here; a run still going finishes in it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void run(async () => {
                    const reset = await post<ApiResetResponse>(`${path}/reset`);
                    navigate(`/conversations/${encodeURIComponent(reset.conversationId)}`, { replace: true });
                  })
                }
              >
                Reset
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {error !== undefined && <ErrorNote error={error} title="The action failed" />}
    </div>
  );
}

function Composer({ conversation, busy }: { conversation: ApiConversation; busy: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<Error>();

  if (conversation.current !== true) {
    return (
      <p className="text-sm text-muted-foreground">
        {conversation.current === false ? "A reset left this conversation behind: it can be read, not talked to." : "No message has reached this conversation yet."}
      </p>
    );
  }

  const send = async () => {
    if (text.trim() === "") return;
    setSending(true);
    setError(undefined);
    try {
      const sent = await post<ApiSendResponse>(`/conversations/${encodeURIComponent(conversation.conversationId)}/messages`, {
        text,
        requestId: `ui:${crypto.randomUUID()}`,
        whenBusy: "steer",
      });
      setText("");
      setNote(sent.admission === "queued" ? "Sent: it joins the run going at its next step." : "Sent: a run started.");
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          placeholder={busy ? "Steer the run going…" : "Talk to the agent…"}
          className="min-h-11"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
          }}
        />
        <Button onClick={() => void send()} disabled={sending || text.trim() === ""}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />} Send
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {note ?? `Your message joins the conversation: its answer also goes to ${conversation.key}'s chat. ⌘/Ctrl+Enter sends.`}
      </p>
      {error !== undefined && <ErrorNote error={error} title="Not sent" />}
    </div>
  );
}

export function ConversationPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const live = useLive(id);
  const summary = useApi<ApiConversation>(`/conversations/${encodeURIComponent(id)}`);
  const transcript = useTranscript(id, live.changes);
  const bottom = useRef<HTMLDivElement>(null);
  const { reload } = summary;

  useEffect(() => {
    if (live.changes === 0) return;
    const timer = setTimeout(reload, 250);
    return () => clearTimeout(timer);
  }, [live.changes, live.busy, reload]);

  const messages = transcript.entries.flatMap((entry) => entry.messages as Message[]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, live.partial, live.tools.length]);

  const conversation = summary.data;
  if (summary.error !== undefined) return <ErrorNote error={summary.error} title="This conversation cannot be read" />;
  if (conversation === undefined) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link to="/conversations" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Conversations
          </Link>
          <h1 className="text-xl font-semibold">{conversation.key ?? conversation.conversationId}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {conversation.agent !== undefined && <Badge variant="outline">{conversation.agent}</Badge>}
            <Status conversation={{ ...conversation, busy: live.busy }} />
            <span className="tabular-nums">
              {formatCost(conversation.usage)} · {formatTokens(conversation.usage.totalTokens)} tokens
            </span>
            <span className="flex items-center gap-1">
              <span className={`size-2 rounded-full ${live.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
              {live.connected ? "live" : "reconnecting"}
            </span>
          </div>
        </div>
        <Actions conversation={conversation} busy={live.busy} />
      </div>

      <Card>
        <CardContent className="space-y-4">
          {transcript.hasOlder && (
            <Button variant="ghost" size="sm" className="w-full" onClick={() => void transcript.loadOlder()}>
              Load earlier messages
            </Button>
          )}
          {transcript.error !== undefined && <ErrorNote error={transcript.error} />}
          {messages.map((message, i) => (
            <MessageView key={i} message={message} />
          ))}
          {live.partial !== undefined && <MessageView message={live.partial} streaming />}
          {live.tools.map((tool) => (
            <div key={tool.callId} className="rounded-md border border-dashed p-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> <Wrench className="size-3.5" /> {tool.name} running
              </div>
              {tool.output !== "" && <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap">{tool.output}</pre>}
            </div>
          ))}
          {messages.length === 0 && live.partial === undefined && <p className="py-6 text-center text-muted-foreground">No messages yet.</p>}
          <div ref={bottom} />
        </CardContent>
      </Card>

      <Composer conversation={conversation} busy={live.busy} />
    </div>
  );
}
