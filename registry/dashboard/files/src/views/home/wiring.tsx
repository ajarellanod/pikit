/**
 * How the components are connected, folded until asked for (it is for whoever debugs the App): where
 * the App had a choice of providers and which it took, what nothing provides that a component would
 * use, each pipeline's stages in the order they run, and every key of a keyed capability (the routes)
 * with its provider.
 */

import { Cube, KeyframesCouple, NavArrowDown, Puzzle } from "iconoir-react";
import { type ReactNode, useState } from "react";
import { Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordTag, TagList } from "@/components/bui/RecordsTable";
import type { ApiApp } from "@/lib/api";
import { type Choice, type Keyed, type Missing, wiringOf } from "./overview";
import { capabilityTag } from "./panel";

const name = (text: string) => <RecordTag title={text}>{text}</RecordTag>;

/** One part of the wiring: a small heading and what it says under it. */
function Part({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[12.5px] font-semibold text-ink">{title}</h3>
        <span className="text-[12px] text-ink-3">{hint}</span>
      </div>
      {children}
    </div>
  );
}

const choiceColumns: RecordColumn<Choice>[] = [
  { key: "capability", label: "Capability", icon: <Puzzle />, width: 220, cell: (choice) => capabilityTag(choice.capability) },
  { key: "selected", label: "Used", icon: <Cube />, width: 200, cell: (choice) => name(choice.selected) },
  {
    key: "others",
    label: "Also installed",
    icon: <KeyframesCouple />,
    width: 260,
    cell: (choice) => <TagList tags={choice.providers.filter((each) => each !== choice.selected)} render={name} />,
  },
];

const missingColumns: RecordColumn<Missing>[] = [
  { key: "capability", label: "Capability", icon: <Puzzle />, width: 220, cell: (missing) => capabilityTag(missing.capability) },
  { key: "wanted", label: "Would be used by", icon: <Cube />, width: 420, cell: (missing) => <TagList tags={missing.wantedBy} render={name} /> },
];

const keyedColumns: RecordColumn<Keyed>[] = [
  { key: "capability", label: "Capability", icon: <Puzzle />, width: 180, sort: (a, b) => a.capability.localeCompare(b.capability), cell: (keyed) => capabilityTag(keyed.capability) },
  { key: "key", label: "Key", icon: <KeyframesCouple />, width: 340, sort: (a, b) => a.key.localeCompare(b.key), title: (keyed) => keyed.key, cell: (keyed) => <span className="truncate font-mono text-[12px]">{keyed.key}</span> },
  { key: "provider", label: "Provider", icon: <Cube />, width: 220, sort: (a, b) => a.provider.localeCompare(b.provider), cell: (keyed) => name(keyed.provider) },
];

export function WiringSection({ app }: { app: ApiApp }) {
  const [open, setOpen] = useState(false);
  const wiring = wiringOf(app);
  return (
    <Section
      title="Wiring"
      meta="how the components are connected"
      tools={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 items-center gap-1 rounded-[7px] px-2 text-[12.5px] font-medium text-ink-2 shadow-btn transition-colors duration-100 hover:bg-hover hover:text-ink"
        >
          {open ? "Hide" : "Show"}
          <NavArrowDown width={13} height={13} strokeWidth={2.2} className="transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : undefined }} />
        </button>
      }
    >
      {open && (
        <div className="flex flex-col gap-8" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <Part title="Choices" hint="a capability more than one component provides, and the one used">
            {wiring.choices.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">None: every capability the App picks one provider for has only one.</p>
            ) : (
              <RecordsTable label="Capabilities with a choice of providers" columns={choiceColumns} rows={wiring.choices} rowKey={(choice) => choice.capability} empty={null} />
            )}
          </Part>
          <Part title="Not installed" hint="what some components would use, if a component provided it">
            {wiring.missing.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">Nothing: every capability a component would use is provided.</p>
            ) : (
              <RecordsTable label="Capabilities nothing provides" columns={missingColumns} rows={wiring.missing} rowKey={(missing) => missing.capability} empty={null} />
            )}
          </Part>
          <Part title="Pipelines" hint="each one's stages, in the order they run">
            {wiring.pipelines.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">No pipeline has a stage.</p>
            ) : (
              <div className="records-shell divide-y divide-line">
                {wiring.pipelines.map((pipeline) => (
                  <div key={pipeline.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <span className="w-40 shrink-0 font-mono text-[12.5px] text-ink">{pipeline.name}</span>
                    <ol className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {pipeline.stages.map((stage, i) => (
                        <li key={`${stage.id}-${i}`} className="flex items-center gap-1.5" title={stage.priority === undefined ? stage.id : `${stage.id}, priority ${stage.priority}`}>
                          {i > 0 && <span className="text-ink-3" aria-hidden>→</span>}
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
          </Part>
          <Part title="Keys" hint="each key of a keyed capability (a route, a command) and its provider">
            {wiring.keyed.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">No keyed capability.</p>
            ) : (
              <RecordsTable label="Keyed capabilities" columns={keyedColumns} rows={wiring.keyed} rowKey={(keyed) => `${keyed.capability} ${keyed.key}`} maxHeight={420} empty={null} />
            )}
          </Part>
        </div>
      )}
    </Section>
  );
}
