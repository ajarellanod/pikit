import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorNote } from "@/components/pikit/error-note";
import { api, type ApiConversation, type ApiPage } from "@/lib/api";
import { formatAgo, formatCost } from "@/lib/format";
import { navigate } from "@/lib/router";

const PAGE = 100;
/** At most this many pages are read: the runtime lists in creation order, so the latest are on the last page. */
const MAX_PAGES = 10;

/**
 * Every conversation (up to MAX_PAGES pages), read again every `everyMs`. The runtime lists them in
 * creation order (`agent.observe`), so all pages are read and sorted here by activity.
 */
function useAllConversations(everyMs: number) {
  const [items, setItems] = useState<ApiConversation[]>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<Error>();
  const read = useCallback(async () => {
    const all: ApiConversation[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      all.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined && ++pages < MAX_PAGES);
    return { all, truncated: cursor !== undefined };
  }, []);

  useEffect(() => {
    let live = true;
    const load = () =>
      read()
        .then(({ all, truncated }) => live && (setItems(all), setTruncated(truncated), setError(undefined)))
        .catch((thrown: unknown) => live && setError(thrown instanceof Error ? thrown : new Error(String(thrown))));
    void load();
    const timer = setInterval(() => void load(), everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [read, everyMs]);

  return { items, truncated, error };
}

export function Status({ conversation }: { conversation: ApiConversation }) {
  if (conversation.current === false) return <Badge variant="outline">left behind</Badge>;
  if (conversation.busy) return <Badge>running</Badge>;
  return <Badge variant="secondary">idle</Badge>;
}

/** Every conversation of the runtime, the most recently active first. */
export function ConversationsPage() {
  const { items: read, truncated, error } = useAllConversations(10_000);
  const items = [...(read ?? [])].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversations</CardTitle>
        <CardDescription>Every conversation of the agent runtime. Open one to follow it live, steer it, stop it or reset it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            {items.map((conversation) => (
              <TableRow key={conversation.conversationId} className="cursor-pointer" onClick={() => navigate(`/conversations/${encodeURIComponent(conversation.conversationId)}`)}>
                <TableCell className="font-medium">
                  {conversation.key ?? <span className="text-muted-foreground">no message yet</span>}
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
            {items.length === 0 && read !== undefined && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  No conversations yet: send your agent a message.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {truncated && <p className="text-sm text-muted-foreground">Showing the first {PAGE * MAX_PAGES} conversations the runtime keeps.</p>}
      </CardContent>
    </Card>
  );
}
