import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorNote } from "@/components/pikit/error-note";
import { api, type ApiConversation, type ApiPage, useApi } from "@/lib/api";
import { formatAgo, formatCost } from "@/lib/format";
import { navigate } from "@/lib/router";

const PAGE = 100;

export function Status({ conversation }: { conversation: ApiConversation }) {
  if (conversation.current === false) return <Badge variant="outline">left behind</Badge>;
  if (conversation.busy) return <Badge>running</Badge>;
  return <Badge variant="secondary">idle</Badge>;
}

/** Every conversation of the runtime, the most recently active first. */
export function ConversationsPage() {
  const first = useApi<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}`, 5000);
  const [more, setMore] = useState<ApiConversation[]>([]);
  const [next, setNext] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (more.length === 0) setNext(first.data?.next);
  }, [first.data, more.length]);

  const loadMore = async () => {
    if (next === undefined) return;
    setLoadingMore(true);
    try {
      const page = await api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}&cursor=${encodeURIComponent(next)}`);
      setMore((items) => [...items, ...page.items]);
      setNext(page.next);
    } finally {
      setLoadingMore(false);
    }
  };

  const seen = new Set<string>();
  const items = [...(first.data?.items ?? []), ...more]
    .filter((each) => !seen.has(each.conversationId) && seen.add(each.conversationId))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversations</CardTitle>
        <CardDescription>Every conversation of the agent runtime. Open one to follow it live, steer it, stop it or reset it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {first.error !== undefined && <ErrorNote error={first.error} />}
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
            {items.length === 0 && !first.loading && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  No conversations yet: send your agent a message.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {next !== undefined && (
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
