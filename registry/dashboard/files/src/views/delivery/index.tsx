/**
 * Delivery (SPEC §5): the answers' pieces not delivered yet (queued, being sent, waiting for a retry)
 * and those that settled (delivered, possibly twice, or abandoned), as the outbound queue keeps them.
 * Shown when an `outbound.queue` is installed (outbound-durable).
 */

import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorNote } from "@/components/pikit/error-note";
import { api, type ApiPage, type ApiPendingPiece, type ApiReceipt, type ApiReceiptsPage, useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { defineView } from "@/lib/views";

/** Receipts kept in the page: the most recent ones. */
const KEPT = 500;

/** Every receipt from the oldest the queue keeps, then each new one, every `everyMs`. */
function useReceipts(everyMs: number) {
  const [receipts, setReceipts] = useState<ApiReceipt[]>([]);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let live = true;
    let after: string | undefined;
    const readOn = async () => {
      for (let pages = 0; pages < 20; pages++) {
        const page = await api<ApiReceiptsPage>(`/delivery/receipts?limit=200${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`);
        if (!live) return;
        if (page.gap) setGap(true);
        if (page.items.length > 0) setReceipts((kept) => [...kept, ...page.items].slice(-KEPT));
        after = page.next ?? after;
        if (page.items.length < 200) return;
      }
    };
    const tick = () => readOn().then(() => live && setError(undefined)).catch((thrown: unknown) => live && setError(thrown instanceof Error ? thrown : new Error(String(thrown))));
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [everyMs]);

  return { receipts, gap, error };
}

function PendingState({ piece }: { piece: ApiPendingPiece }) {
  if (piece.state === "sending") return <Badge>sending</Badge>;
  if (piece.state === "retrying") return <Badge variant="destructive">retrying</Badge>;
  return <Badge variant="secondary">queued</Badge>;
}

function Outcome({ receipt }: { receipt: ApiReceipt }) {
  if (receipt.outcome.kind === "abandoned") return <Badge variant="destructive">abandoned</Badge>;
  if (receipt.outcome.possibleDuplicate) return <Badge variant="outline">delivered, possibly twice</Badge>;
  return <Badge variant="secondary">delivered</Badge>;
}

function DeliveryPage() {
  const pending = useApi<ApiPage<ApiPendingPiece>>("/delivery/pending?limit=500", 5000);
  const { receipts, gap, error } = useReceipts(5000);
  const settled = [...receipts].reverse();
  const abandoned = receipts.filter((r) => r.outcome.kind === "abandoned").length;
  const duplicates = receipts.filter((r) => r.outcome.kind === "delivered" && r.outcome.possibleDuplicate).length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Not delivered yet</CardTitle>
          <CardDescription>Pieces of answers the queue holds: never tried, being sent, or waiting to be sent again.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.error !== undefined && <ErrorNote error={pending.error} />}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Conversation</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Next try</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Stored</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pending.data?.items ?? []).map((piece) => (
                <TableRow key={`${piece.idempotencyKey}#${piece.index}`}>
                  <TableCell className="font-medium">
                    {piece.conversationKey}
                    <div className="text-xs text-muted-foreground">
                      {piece.channel} · piece {piece.index + 1}
                      {piece.possibleDuplicate && " · may repeat"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PendingState piece={piece} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{piece.attempts}</TableCell>
                  <TableCell className="text-muted-foreground">{piece.nextAttemptAt === undefined ? "—" : formatAgo(piece.nextAttemptAt)}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground" title={piece.lastError}>
                    {piece.lastError ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatAgo(piece.storedAt)}</TableCell>
                </TableRow>
              ))}
              {pending.data !== undefined && pending.data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nothing waiting: every answer went out.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settled</CardTitle>
          <CardDescription>
            The latest pieces delivered or given up, newest first: {abandoned} abandoned, {duplicates} possibly delivered twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error !== undefined && <ErrorNote error={error} />}
          {gap && <p className="text-sm text-muted-foreground">Older receipts were pruned by the queue before they were read.</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Conversation</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settled.map((receipt) => (
                <TableRow key={receipt.cursor}>
                  <TableCell className="font-medium">
                    {receipt.conversationKey}
                    <div className="text-xs text-muted-foreground">
                      {receipt.channel} · piece {receipt.index + 1}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Outcome receipt={receipt} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{receipt.attempts}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground">{receipt.outcome.kind === "abandoned" ? receipt.outcome.reason : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatAgo(receipt.at)}</TableCell>
                </TableRow>
              ))}
              {settled.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No answer has gone through the queue yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export default defineView({
  id: "delivery",
  title: "Delivery",
  icon: Send,
  requires: ["outbound.queue"],
  order: 30,
  pages: [{ path: "/delivery", component: DeliveryPage }],
});
