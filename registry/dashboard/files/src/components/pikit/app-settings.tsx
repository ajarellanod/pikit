/**
 * The Settings dialog's App section, the dashboard's own (after General): what the App is made of
 * (`APP_DESCRIPTION`, SPEC K13), in the words of the one who runs it. Where it runs and talks, in one
 * line; its agents (the steward marked), each with its model and tools; its components by what they
 * are for, each one opening under its row with what it provides and to whom, what it needs and who
 * gives it that, what it would use if installed, and its config; and, folded, the wiring (for whoever
 * debugs the App). It only shows: read from `GET /admin/api/app` (the shell's) and the agents
 * (`useShell().agents`), worked out in `lib/composition.ts`. The config holds
 * no secret: a component reads its secrets through `secrets` and its config names them at most, and
 * the API redacts a value that looks like one.
 */

import { ChatLines, Cloud, Cpu, Cube, Dashboard, Database, GitFork, KeyframesCouple, NavArrowDown, NavArrowRight, Puzzle, Sparks, Tools } from "iconoir-react";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/bui/Badge";
import CodeBlock from "@/components/bui/CodeBlock";
import EmptyState from "@/components/bui/EmptyState";
import LoadingState from "@/components/bui/LoadingState";
import RecordsTable, { type RecordColumn, RecordMark, RecordTag, TagList, tagHue } from "@/components/bui/RecordsTable";
import { SettingsHeading } from "@/components/pikit/settings-rows";
import type { ApiAgent, ApiApp } from "@/lib/api";
import { type Choice, type Component, type Group, groupsOf, type Keyed, kindOf, type Missing, placeOf, providersOf, summaryOf, usersOf, wiringOf } from "@/lib/composition";
import { assistantName } from "@/lib/names";
import { useShell } from "@/lib/shell";

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

const quiet = (text: string) => <p className="text-[12.5px] text-ink-3">{text}</p>;
const name = (text: string) => <RecordTag title={text}>{text}</RecordTag>;

/** A capability's tag, coloured by its family (`agent.`, `storage.`, …): the same everywhere. */
const capabilityTag = (capability: string) => (
  <RecordTag base={tagHue(capability.split(".")[0] ?? capability)} title={capability}>
    {capability}
  </RecordTag>
);

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
            <Badge tone="accent">steward</Badge>
          </span>
        )}
        {agent.live === true && (
          <span title="Made in the dashboard: it is data, not the project's code">
            <Badge>live</Badge>
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

/** One part of a component's details: a quiet label over what it says. */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[11.5px] font-medium text-ink-3">{label}</h4>
      {children}
    </section>
  );
}

/** Each capability, and on its right who gives it (or that nothing does). */
function Capabilities({ app, capabilities }: { app: ApiApp; capabilities: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {capabilities.map((capability) => {
        const providers = providersOf(app, capability);
        return (
          <li key={capability} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {capabilityTag(capability)}
            <span className={`min-w-0 truncate text-[12.5px] ${providers.length === 0 ? "text-ink-3" : "text-ink-2"}`} title={providers.join(", ")}>
              {providers.length === 0 ? "not installed" : `from ${providers.join(", ")}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One component, opened under its row: what it is for, provides, needs and would use, and its config (redacted). */
function ComponentDetails({ app, component }: { app: ApiApp; component: Component }) {
  const users = usersOf(app, component);
  const config = app.config[component.name];
  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12.5px] text-ink-2">
        {kindOf(component)}
        {component.version !== undefined && <span className="font-mono text-ink-3"> · {component.version}</span>}
      </p>
      <Part label="Provides">
        {component.provides.length === 0 ? quiet("Nothing to the other components.") : <div className="flex flex-wrap gap-1">{component.provides.map(capabilityTag)}</div>}
        {users.length > 0 && <p className="text-[12.5px] text-ink-2">Used by {users.join(", ")}.</p>}
      </Part>
      <Part label="Needs">{component.requires.length === 0 ? quiet("Nothing.") : <Capabilities app={app} capabilities={component.requires} />}</Part>
      {component.optional.length > 0 && (
        <Part label="Uses if installed">
          <Capabilities app={app} capabilities={component.optional} />
        </Part>
      )}
      <Part label="Config">
        {config === undefined ? quiet("None.") : <CodeBlock filename="config.json" meta="redacted" code={JSON.stringify(config, null, 2)} />}
        <p className="text-[12px] leading-relaxed text-ink-3">Set when the App is deployed. The values an operator changes live are in the other sections.</p>
      </Part>
    </div>
  );
}

/** A kind of component: its rows, the open one pressed with its details under it. */
function GroupCard({ app, group, open, onOpen }: { app: ApiApp; group: Group; open: string | undefined; onOpen: (name: string) => void }) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-ink-2 [&_svg]:size-[15px]">
        {GROUP_ICONS[group.title] ?? <Cube />}
        <h4 className="text-[12.5px] font-semibold text-ink">{group.title}</h4>
        <span className="text-[12px] text-ink-3 tabular-nums">{group.components.length}</span>
      </div>
      <ul className="p-1">
        {group.components.map((component) => {
          const pressed = component.name === open;
          return (
            <li key={component.name}>
              <button
                type="button"
                aria-expanded={pressed}
                onClick={() => onOpen(component.name)}
                className={`flex h-9 w-full items-center gap-2.5 rounded-[7px] px-3 text-left transition-colors duration-100 ${pressed ? "bg-hover-2" : "hover:bg-hover"}`}
              >
                <RecordMark name={component.name} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{component.name}</span>
                {component.version !== undefined && <span className="shrink-0 font-mono text-[11.5px] text-ink-3">{component.version}</span>}
                <NavArrowRight width={14} height={14} strokeWidth={2} className={`shrink-0 text-ink-3 transition-transform duration-200 ${pressed ? "rotate-90" : ""}`} aria-hidden />
              </button>
              {pressed && (
                <div className="mx-1 my-1 rounded-[8px] bg-page px-4 py-4 shadow-hairline" style={{ animation: "fade-in 200ms ease both" }}>
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

const choiceColumns: RecordColumn<Choice>[] = [
  { key: "capability", label: "Capability", icon: <Puzzle />, width: 200, cell: (choice) => capabilityTag(choice.capability) },
  { key: "selected", label: "Used", icon: <Cube />, width: 180, cell: (choice) => name(choice.selected) },
  { key: "others", label: "Also installed", icon: <KeyframesCouple />, width: 240, cell: (choice) => <TagList tags={choice.providers.filter((each) => each !== choice.selected)} render={name} /> },
];

const missingColumns: RecordColumn<Missing>[] = [
  { key: "capability", label: "Capability", icon: <Puzzle />, width: 200, cell: (missing) => capabilityTag(missing.capability) },
  { key: "wanted", label: "Would be used by", icon: <Cube />, width: 400, cell: (missing) => <TagList tags={missing.wantedBy} render={name} /> },
];

const keyedColumns: RecordColumn<Keyed>[] = [
  { key: "capability", label: "Capability", icon: <Puzzle />, width: 170, sort: (a, b) => a.capability.localeCompare(b.capability), cell: (keyed) => capabilityTag(keyed.capability) },
  { key: "key", label: "Key", icon: <KeyframesCouple />, width: 300, sort: (a, b) => a.key.localeCompare(b.key), title: (keyed) => keyed.key, cell: (keyed) => <span className="truncate font-mono text-[12px]">{keyed.key}</span> },
  { key: "provider", label: "Provider", icon: <Cube />, width: 200, sort: (a, b) => a.provider.localeCompare(b.provider), cell: (keyed) => name(keyed.provider) },
];

/** One part of the wiring: a small heading and what it says under it. */
function WiringPart({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-[12.5px] font-semibold text-ink">{title}</h4>
        <span className="text-[12px] text-ink-3">{hint}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * How the components are connected, folded until asked for: where the App had a choice of providers
 * and which it took, what nothing provides that a component would use, each pipeline's stages in the
 * order they run, and every key of a keyed capability (the routes) with its provider.
 */
function Wiring({ app }: { app: ApiApp }) {
  const [open, setOpen] = useState(false);
  const wiring = wiringOf(app);
  return (
    <>
      <SettingsHeading
        aside={
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="btn btn-outline btn-xs text-ink-2 hover:text-ink">
            {open ? "Hide" : "Show"}
            <NavArrowDown width={13} height={13} strokeWidth={2.2} className="transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : undefined }} />
          </button>
        }
      >
        Wiring
      </SettingsHeading>
      <p className="text-[13px] text-ink-3">How the components are connected: for whoever debugs the App.</p>
      {open && (
        <div className="mt-5 flex flex-col gap-8" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <WiringPart title="Choices" hint="a capability more than one component provides, and the one used">
            {wiring.choices.length === 0 ? (
              quiet("None: every capability the App picks one provider for has only one.")
            ) : (
              <RecordsTable label="Capabilities with a choice of providers" columns={choiceColumns} rows={wiring.choices} rowKey={(choice) => choice.capability} empty={null} />
            )}
          </WiringPart>
          <WiringPart title="Not installed" hint="what some components would use, if a component provided it">
            {wiring.missing.length === 0 ? (
              quiet("Nothing: every capability a component would use is provided.")
            ) : (
              <RecordsTable label="Capabilities nothing provides" columns={missingColumns} rows={wiring.missing} rowKey={(missing) => missing.capability} empty={null} />
            )}
          </WiringPart>
          <WiringPart title="Pipelines" hint="each one's stages, in the order they run">
            {wiring.pipelines.length === 0 ? (
              quiet("No pipeline has a stage.")
            ) : (
              <div className="records-shell divide-y divide-line">
                {wiring.pipelines.map((pipeline) => (
                  <div key={pipeline.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <span className="w-40 shrink-0 font-mono text-[12.5px] text-ink">{pipeline.name}</span>
                    <ol className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {pipeline.stages.map((stage, i) => (
                        <li key={`${stage.id}-${i}`} className="flex items-center gap-1.5" title={stage.priority === undefined ? stage.id : `${stage.id}, priority ${stage.priority}`}>
                          {i > 0 && (
                            <span className="text-ink-3" aria-hidden>
                              →
                            </span>
                          )}
                          <span className="inline-flex h-6 items-center gap-1.5 rounded-chip bg-inset px-2 text-[12px] text-ink-2 shadow-hairline">
                            <span className="font-mono text-[11px] text-ink-3 tabular-nums">{i + 1}</span>
                            <span className="font-mono">{stage.id}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            )}
          </WiringPart>
          <WiringPart title="Keys" hint="each key of a keyed capability (a route, a command) and its provider">
            {wiring.keyed.length === 0 ? (
              quiet("No keyed capability.")
            ) : (
              <RecordsTable label="Keyed capabilities" columns={keyedColumns} rows={wiring.keyed} rowKey={(keyed) => `${keyed.capability} ${keyed.key}`} maxHeight={420} empty={null} />
            )}
          </WiringPart>
        </div>
      )}
    </>
  );
}

/** The section: the App in a line, its agents, its components by kind, and the wiring. */
export function AppSettings() {
  const { app, agents } = useShell();
  const [open, setOpen] = useState<string>();
  const groups = groupsOf(app.components);

  return (
    <div>
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        Runs on {placeOf(app.target)}. {summaryOf(app, agents?.length)}
      </p>

      <SettingsHeading aside={agents === undefined ? undefined : <span className="text-[12.5px] text-ink-3 tabular-nums">{agents.length}</span>}>Agents</SettingsHeading>
      {agents === undefined ? (
        <div className="flex min-h-6 items-center">
          <LoadingState label="Reading the agents" variant="Dots" />
        </div>
      ) : agents.length === 0 ? (
        <div className={CARD}>
          <EmptyState icon={<Sparks />} title="No agent" hint="The App has no agent to talk to." />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {agents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))}
        </div>
      )}

      <SettingsHeading aside={<span className="text-[12.5px] text-ink-3">by what they are for</span>}>Components</SettingsHeading>
      <div className="mt-2 flex flex-col gap-3">
        {groups.map((group) => (
          <GroupCard key={group.title} app={app} group={group} open={open} onOpen={(each) => setOpen(each === open ? undefined : each)} />
        ))}
      </div>

      <Wiring app={app} />
    </div>
  );
}
