/**
 * Home: what the App is made of (`APP_DESCRIPTION`, SPEC K13), first in the sidebar after New chat, in
 * the words of the one who runs it. Where it runs and talks, in one line; its agents (the steward
 * marked), each with its model and tools; its components by what they are for, one opening at the side
 * with what it provides and needs and its config; and, folded, the wiring (`wiring.tsx`). The config
 * holds no secret: a component reads its secrets through `secrets` and its config names them at most,
 * and the API redacts a value that looks like one.
 */

import { ChatLines, Cloud, Cpu, Cube, Dashboard, Database, GitFork, Home, NavArrowRight, Sparks, Tools } from "iconoir-react";
import { type ReactNode, useState } from "react";
import { ValuePill } from "@/components/bui/Chip";
import EmptyState from "@/components/bui/EmptyState";
import LoadingState from "@/components/bui/LoadingState";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import { RecordMark, RecordTag } from "@/components/bui/RecordsTable";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiAgent, type ApiApp, useApi } from "@/lib/api";
import { assistantName } from "@/lib/names";
import { SidePanel, useShell } from "@/lib/shell";
import { defineView } from "@/lib/views";
import { type Component, type Group, groupsOf, placeOf, summaryOf } from "./overview";
import { ComponentDetails, ComponentPanel } from "./panel";
import { WiringSection } from "./wiring";

const GROUP_ICONS: Record<string, ReactNode> = {
  Channels: <ChatLines />,
  "Agents and models": <Sparks />,
  Tools: <Tools />,
  Data: <Database />,
  Integrations: <GitFork />,
  "Dashboard and admin": <Dashboard />,
  Platform: <Cloud />,
};

const CARD = "overflow-hidden rounded-card bg-surface shadow-card";

/** An agent: its name (the steward marked, a live one said so), what it is for, its model and its tools. */
function AgentCard({ agent }: { agent: ApiAgent }) {
  return (
    <article className={`${CARD} flex flex-col gap-3 p-4`}>
      <div className="flex min-w-0 items-center gap-2">
        <RecordMark name={agent.name} />
        <span className="min-w-0 truncate text-[14px] font-medium text-ink" title={agent.name}>
          {assistantName(agent.name)}
        </span>
        {agent.steward && (
          <span title="The project's steward: it knows what the project is made of, and operators ask it to change it">
            <ValuePill tone="accent">steward</ValuePill>
          </span>
        )}
        {agent.live === true && (
          <span title="Made in the dashboard: it is data, not the project's code">
            <ValuePill>live</ValuePill>
          </span>
        )}
      </div>
      {agent.description !== undefined && <p className="text-[12.5px] leading-relaxed text-ink-2">{agent.description}</p>}
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-2" title={agent.model}>
        <Cpu width={14} height={14} className="shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[12px]">{agent.model}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {agent.tools.length === 0 ? (
          <span className="text-[12.5px] text-ink-3">No tools</span>
        ) : (
          agent.tools.map((tool) => (
            <RecordTag key={tool} title={tool}>
              {tool}
            </RecordTag>
          ))
        )}
      </div>
    </article>
  );
}

function AgentsSection({ agents }: { agents: ApiAgent[] | undefined }) {
  return (
    <Section title="Agents" meta={agents === undefined ? undefined : `${agents.length}`}>
      {agents === undefined ? (
        <div className="flex min-h-6 items-center">
          <LoadingState label="Reading the agents" variant="Dots" />
        </div>
      ) : agents.length === 0 ? (
        <div className={CARD}>
          <EmptyState icon={<Sparks />} title="No agent" hint="The App has no agent to talk to." />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))}
        </div>
      )}
    </Section>
  );
}

/** A kind of component: its rows, the open one pressed (and, below `lg`, its details under it). */
function GroupCard({ app, group, open, onOpen }: { app: ApiApp; group: Group; open: string | undefined; onOpen: (name: string) => void }) {
  return (
    <div className={`${CARD} mb-4 break-inside-avoid`}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-ink-2 [&_svg]:size-[15px]">
        {GROUP_ICONS[group.title] ?? <Cube />}
        <h3 className="text-[12.5px] font-semibold text-ink">{group.title}</h3>
        <span className="text-[12px] text-ink-3 tabular-nums">{group.components.length}</span>
      </div>
      <ul className="p-1">
        {group.components.map((component) => {
          const pressed = component.name === open;
          return (
            <li key={component.name}>
              <button
                type="button"
                aria-pressed={pressed}
                onClick={() => onOpen(component.name)}
                className={`flex h-9 w-full items-center gap-2.5 rounded-[7px] px-3 text-left transition-colors duration-100 ${pressed ? "bg-hover-2" : "hover:bg-hover"}`}
              >
                <RecordMark name={component.name} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{component.name}</span>
                {component.version !== undefined && <span className="shrink-0 font-mono text-[11.5px] text-ink-3">{component.version}</span>}
                <NavArrowRight width={14} height={14} strokeWidth={2} className={`shrink-0 text-ink-3 transition-transform duration-200 ${pressed ? "rotate-90 lg:rotate-0" : ""}`} aria-hidden />
              </button>
              {pressed && (
                <div className="border-y border-line bg-page px-4 py-4 lg:hidden">
                  <ComponentDetails app={app} component={component} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HomePage() {
  const { data: app, error } = useApi<ApiApp>("/app");
  const shell = useShell();
  const [open, setOpen] = useState<string>();

  if (error !== undefined) {
    return (
      <Page eyebrow="Home">
        <ErrorNote error={error} title="What the App is made of cannot be read" />
      </Page>
    );
  }
  if (app === undefined) return <PageLoading eyebrow="Home" />;

  const groups = groupsOf(app.components);
  const opened: Component | undefined = app.components.find((component) => component.name === open);

  return (
    <Page eyebrow="Home" title={`Runs on ${placeOf(app.target)}`} description={summaryOf(app, shell.agents?.length)}>
      <AgentsSection agents={shell.agents} />

      <Section title="Components" meta="by what they are for">
        <div className="columns-1 gap-4 md:columns-2">
          {groups.map((group) => (
            <GroupCard key={group.title} app={app} group={group} open={open} onOpen={(name) => setOpen(name === open ? undefined : name)} />
          ))}
        </div>
      </Section>

      <WiringSection app={app} />

      {opened !== undefined && (
        <SidePanel>
          <ComponentPanel app={app} component={opened} onClose={() => setOpen(undefined)} />
        </SidePanel>
      )}
    </Page>
  );
}

export default defineView({
  id: "home",
  title: "Home",
  icon: Home,
  order: 0,
  pages: [{ path: "/home", component: HomePage, fill: true }],
});
