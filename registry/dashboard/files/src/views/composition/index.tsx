/**
 * What the App is made of (`APP_DESCRIPTION`, SPEC K13): its components in start order, who provides
 * each capability, its pipelines' stages, and its config. The config holds no secret: a component
 * reads its secrets through `secrets` and its config names them at most.
 */

import { Boxes } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiApp, useApi } from "@/lib/api";
import { defineView } from "@/lib/views";

function Names({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Badge key={name} variant="outline" className="font-mono">
          {name}
        </Badge>
      ))}
    </div>
  );
}

function CompositionPage() {
  const { data: app, error } = useApi<ApiApp>("/app");
  if (error !== undefined) return <ErrorNote error={error} />;
  if (app === undefined) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Composition</CardTitle>
        <CardDescription>
          What this App runs ({app.target} target): its components in start order, who provides each capability, its pipelines and its config.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="components">
          <TabsList>
            <TabsTrigger value="components">Components ({app.components.length})</TabsTrigger>
            <TabsTrigger value="capabilities">Capabilities ({Object.keys(app.capabilities).length})</TabsTrigger>
            <TabsTrigger value="pipelines">Pipelines ({Object.keys(app.pipelines).length})</TabsTrigger>
            <TabsTrigger value="config">Config</TabsTrigger>
          </TabsList>

          <TabsContent value="components">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead>Provides</TableHead>
                  <TableHead>Requires</TableHead>
                  <TableHead>Uses if installed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {app.components.map((component) => (
                  <TableRow key={component.name}>
                    <TableCell className="font-medium">
                      {component.name}
                      {component.version !== undefined && <span className="ml-2 text-xs text-muted-foreground">{component.version}</span>}
                    </TableCell>
                    <TableCell>
                      <Names names={component.provides} />
                    </TableCell>
                    <TableCell>
                      <Names names={component.requires} />
                    </TableCell>
                    <TableCell>
                      <Names names={component.optional} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="capabilities">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capability</TableHead>
                  <TableHead>Providers</TableHead>
                  <TableHead>Selected / keys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(app.capabilities)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, capability]) => (
                    <TableRow key={name}>
                      <TableCell className="font-mono text-sm">{name}</TableCell>
                      <TableCell>
                        <Names names={capability.providers} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {capability.selected ?? null}
                        {capability.keys !== undefined && (
                          <ul className="space-y-0.5">
                            {Object.entries(capability.keys).map(([key, provider]) => (
                              <li key={key}>
                                <span className="font-mono">{key}</span> <span className="text-muted-foreground">→ {provider}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="pipelines" className="space-y-4">
            {Object.entries(app.pipelines).map(([name, stages]) => (
              <div key={name}>
                <h3 className="font-mono text-sm font-medium">{name}</h3>
                <pre className="mt-1 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(stages, null, 2)}</pre>
              </div>
            ))}
            {Object.keys(app.pipelines).length === 0 && <p className="text-muted-foreground">No pipeline has a stage.</p>}
          </TabsContent>

          <TabsContent value="config">
            <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(app.config, null, 2)}</pre>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default defineView({
  id: "composition",
  title: "Composition",
  icon: Boxes,
  order: 90,
  pages: [{ path: "/composition", component: CompositionPage }],
});
