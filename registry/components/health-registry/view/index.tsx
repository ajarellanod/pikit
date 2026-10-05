/**
 * health-registry's view (SPEC §5): what is up, degraded or down in the App, why, and since when;
 * which components are essential and the grace before one makes the App `down`. It reads the
 * component's own route, `GET /admin/api/health-registry`, every few seconds.
 */

import { HeartPulse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorNote } from "@/components/pikit/error-note";
import { useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { defineView } from "@/lib/views";

type Status = "up" | "degraded" | "down";

/** What the route answers (health-registry's `HealthView`). */
type HealthView = {
  status: Status;
  components: { name: string; status: Status; reason?: string; since: number; essential: boolean }[];
  essential: string[];
  graceMs: number;
  now: number;
};

function StatusBadge({ status }: { status: Status }) {
  if (status === "down") return <Badge variant="destructive">down</Badge>;
  if (status === "degraded") return <Badge variant="outline">degraded</Badge>;
  return <Badge variant="secondary">up</Badge>;
}

function HealthPage() {
  const { data, error } = useApi<HealthView>("/health-registry", 5000);
  if (error !== undefined) return <ErrorNote error={error} />;
  if (data === undefined) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          The App is <StatusBadge status={data.status} />
        </CardTitle>
        <CardDescription>
          What each component reported last. An essential component ({data.essential.length === 0 ? "none is" : data.essential.join(", ")}) down for{" "}
          {Math.round(data.graceMs / 1000)} s makes the App down, and its <code>/health</code> fails so that the process is restarted; anything else
          down or degraded makes it degraded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Component</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Why</TableHead>
              <TableHead>Since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.components.map((component) => (
              <TableRow key={component.name}>
                <TableCell className="font-medium">
                  {component.name}
                  {component.essential && <span className="ml-2 text-xs text-muted-foreground">essential</span>}
                </TableCell>
                <TableCell>
                  <StatusBadge status={component.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{component.reason ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatAgo(component.since, data.now)}</TableCell>
              </TableRow>
            ))}
            {data.components.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No component has reported yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default defineView({
  id: "health-registry",
  title: "Health",
  icon: HeartPulse,
  requires: ["health"],
  order: 20,
  pages: [{ path: "/health-registry", component: HealthPage }],
});
