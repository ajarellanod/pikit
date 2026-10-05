import { Loader2, Plus, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote } from "@/components/pikit/error-note";
import { every, usePolling } from "@/lib/activity";
import { isDashboardKey } from "@/lib/admin-api";
import { api, type ApiApp, type ApiConversation, type ApiPage, type ApiStartResponse, post, useApi } from "@/lib/api";
import { formatAgo, formatCost } from "@/lib/format";
import { navigate, pagePath } from "@/lib/router";

const PAGE = 50;

/**
 * The conversations, the most recently active first, as the API pages them (its index): the first
 * page read again every `everyMs` while the dashboard is active, older pages on demand.
 */
function useConversations(everyMs: number) {
  const [first, setFirst] = useState<ApiPage<ApiConversation>>();
  const [older, setOlder] = useState<ApiConversation[]>([]);
  const [next, setNext] = useState<string | null>();
  const [error, setError] = useState<Error>();

  const read = useCallback(() => {
    api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}`)
      .then((page) => (setFirst(page), setError(undefined)))
      .catch((thrown: unknown) => setError(thrown instanceof Error ? thrown : new Error(String(thrown))));
  }, []);
  useEffect(read, [read]);
  usePolling(read, everyMs);

  const cursor = next === undefined ? first?.next : (next ?? undefined);
  const loadOlder = async () => {
    if (cursor === undefined) return;
    try {
      const page = await api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
      setOlder((items) => [...items, ...page.items]);
      setNext(page.next ?? null);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    }
  };

  // A conversation active again since the older pages were read is on the first page: shown once.
  const seen = new Set<string>();
  const items = first === undefined ? undefined : [...first.items, ...older].filter((each) => !seen.has(each.conversationId) && seen.add(each.conversationId));
  return { items, error, hasOlder: cursor !== undefined, loadOlder };
}

export function Status({ conversation }: { conversation: ApiConversation }) {
  if (conversation.current === false) return <Badge variant="outline">left behind</Badge>;
  if (conversation.busy) return <Badge>running</Badge>;
  return <Badge variant="secondary">idle</Badge>;
}

/** The dashboard's own conversations are labeled: what is said there reaches no other channel. */
export function DashboardBadge({ conversation }: { conversation: ApiConversation }) {
  return isDashboardKey(conversation.key) ? <Badge variant="outline">dashboard</Badge> : null;
}

/** The App's agents: the keys of `agent.definition`. */
export const agentsOf = (app: ApiApp | undefined): string[] => Object.keys(app?.capabilities["agent.definition"]?.keys ?? {}).sort();

/** A new conversation of the dashboard's own: an agent of the App, and the first message. */
function NewConversation({ onCancel }: { onCancel: () => void }) {
  const { data: app } = useApi<ApiApp>("/app");
  const agents = agentsOf(app);
  const [agent, setAgent] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error>();
  const chosen = agent ?? agents[0];

  const start = async () => {
    if (chosen === undefined || text.trim() === "") return;
    setSending(true);
    setError(undefined);
    try {
      const started = await post<ApiStartResponse>("/conversations", { agent: chosen, text });
      navigate(pagePath("/conversations", started.conversationId));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      setSending(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="new-conversation-agent" className="font-medium">
          Agent
        </label>
        <select
          id="new-conversation-agent"
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          value={chosen ?? ""}
          disabled={agents.length === 0}
          onChange={(event) => setAgent(event.target.value)}
        >
          {agents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {app !== undefined && agents.length === 0 && <span className="text-muted-foreground">The App has no agent.</span>}
      </div>
      <Textarea
        value={text}
        placeholder="The first message…"
        className="min-h-20"
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
        }}
      />
      <p className="text-xs text-muted-foreground">A conversation of the dashboard's own: only you see it and its answers, here. No other channel can continue it.</p>
      {error !== undefined && <ErrorNote error={error} title="Not started" />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void start()} disabled={sending || chosen === undefined || text.trim() === ""}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />} Start
        </Button>
      </div>
    </div>
  );
}

/** Every conversation of the runtime, the most recently active first. */
export function ConversationsPage() {
  const { items, error, hasOlder, loadOlder } = useConversations(every(10_000));
  const [creating, setCreating] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle>Conversations</CardTitle>
          <CardDescription>Every conversation, the most recently active first. Open one to follow it live, talk to its agent, stop it or reset it.</CardDescription>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New conversation
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {creating && <NewConversation onCancel={() => setCreating(false)} />}
        {error !== undefined && <ErrorNote error={error} />}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Conversation</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items ?? []).map((conversation) => (
              <TableRow key={conversation.conversationId} className="cursor-pointer" onClick={() => navigate(pagePath("/conversations", conversation.conversationId))}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {conversation.key ?? <span className="text-muted-foreground">no message yet</span>}
                    <DashboardBadge conversation={conversation} />
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">{conversation.conversationId}</div>
                </TableCell>
                <TableCell>{conversation.agent ?? "—"}</TableCell>
                <TableCell>
                  <Status conversation={conversation} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatAgo(conversation.lastActivity)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCost(conversation.usage)}</TableCell>
              </TableRow>
            ))}
            {items !== undefined && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  No conversations yet: send your agent a message, or start one here.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {hasOlder && (
          <Button variant="ghost" size="sm" className="w-full" onClick={() => void loadOlder()}>
            Older conversations
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
