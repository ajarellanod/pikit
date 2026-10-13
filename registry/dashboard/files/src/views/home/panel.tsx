/**
 * One component of the App, at the side (as a conversation's Context is): what it is for, what it
 * provides and to whom, what it needs and who gives it that, what it would use if installed, and its
 * config, the redacted JSON deployed with it (what an operator changes live is in Settings).
 */

import { Xmark } from "iconoir-react";
import type { ReactNode } from "react";
import CodeBlock from "@/components/bui/CodeBlock";
import { RecordTag, tagHue } from "@/components/bui/RecordsTable";
import type { ApiApp } from "@/lib/api";
import { type Component, kindOf, providersOf, usersOf } from "./overview";

/** A capability's tag, coloured by its family (`agent.`, `storage.`, …): the same everywhere. */
export const capabilityTag = (name: string) => (
  <RecordTag base={tagHue(name.split(".")[0] ?? name)} title={name}>
    {name}
  </RecordTag>
);

/** One part of the panel: a quiet label over what it says. */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11.5px] font-medium text-ink-3">{label}</h3>
      {children}
    </section>
  );
}

const quiet = (text: string) => <p className="text-[12.5px] text-ink-3">{text}</p>;

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

export function ComponentDetails({ app, component }: { app: ApiApp; component: Component }) {
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
        {config === undefined ? (
          quiet("None.")
        ) : (
          <CodeBlock filename="config.json" meta="redacted" code={JSON.stringify(config, null, 2)} />
        )}
        <p className="text-[12px] leading-relaxed text-ink-3">Set when the App is deployed. The values an operator changes live are in Settings.</p>
      </Part>
    </div>
  );
}

/** The panel at the side of the page (from `lg` up; below, the details open under the component's row). */
export function ComponentPanel({ app, component, onClose }: { app: ApiApp; component: Component; onClose: () => void }) {
  return (
    <aside aria-label={component.name} className="hidden w-[380px] shrink-0 flex-col overflow-hidden rounded-window border border-line bg-page lg:flex" style={{ animation: "fade-in 300ms ease both" }}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3 sm:pl-4">
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink" title={component.name}>
          {component.name}
        </span>
        <button type="button" aria-label="Close the component" onClick={onClose} className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink">
          <Xmark width={15} height={15} strokeWidth={2} />
        </button>
      </div>
      <div key={component.name} className="min-h-0 flex-1 overflow-y-auto p-4" style={{ animation: "fade-in 200ms ease both" }}>
        <ComponentDetails app={app} component={component} />
      </div>
    </aside>
  );
}
