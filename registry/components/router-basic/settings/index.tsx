/**
 * router-basic's section of the Settings dialog, part 2 of the Routing entry (features/settings.md): its
 * own setting only, which agent answers by default (its default the config's `defaultAgent`). It is a
 * locked card under router-rules' rules, "Everything else goes to [agent]", or, without router-rules,
 * the only one, "Every message goes to [agent]". Whether router-rules is there is the App's composition
 * (`useShell`), not its settings. A change is saved at once and applies to new conversations.
 *
 * The agents' prompt, model, tools and skills are not here: they are runtime-pi's part of Agents.
 */

import { GitFork, Lock } from "iconoir-react";
import { useState } from "react";
import { Combobox } from "@/components/bui/Combobox";
import { ErrorNote } from "@/components/pikit/error-note";
import { storedOf } from "@/components/pikit/settings";
import { assistantName } from "@/lib/names";
import { choicesOf, defineSettings, useSettings } from "@/lib/settings";
import { useShell } from "@/lib/shell";

function DefaultAgentSettings() {
  const router = useSettings("router-basic");
  const { app } = useShell();
  const [failed, setFailed] = useState<Error>();

  if (router.error !== undefined && router.section === undefined) return <ErrorNote error={router.error} title="The default agent cannot be read" />;
  const section = router.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  const current = String(section.value.defaultAgent);
  const names = choicesOf(section.schema.properties?.defaultAgent) ?? [current];
  // Under router-rules' cards, it continues them (ELSE); alone, it is every message's (ALWAYS).
  const rules = app.components.some((component) => component.name === "router-rules");
  const choose = (name: string) => {
    setFailed(undefined);
    router.save(storedOf({ defaultAgent: name }, section.defaults)).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };

  return (
    <div className={rules ? "mt-3" : ""}>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      {!rules && <p className="mb-3 text-[13px] text-ink-3">One agent answers every message. Add router-rules to send a channel, chat or sender to another.</p>}
      <div className="relative flex items-center gap-2 rounded-card border border-dashed border-line-strong px-3 py-2.5">
        {rules && <span aria-hidden="true" className="absolute -top-3 left-[23.5px] h-3 w-px bg-line-strong" />}
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-inset text-ink-3 shadow-hairline">
          <Lock width={13} height={13} strokeWidth={1.8} />
        </span>
        <span className="w-11 shrink-0 text-[11px] font-medium tracking-[0.06em] text-ink-3 uppercase select-none">{rules ? "Else" : "Always"}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
            {rules ? "Everything else goes to" : "Every message goes to"}
            <Combobox
              label="Default agent"
              value={current}
              disabled={router.saving}
              options={names.map((name) => ({ value: name, label: assistantName(name) }))}
              onChange={choose}
              className="max-w-72 min-w-36"
            />
          </span>
          <span className="text-[12px] text-ink-3">{rules ? "The default agent: it answers whatever no rule matches." : "The default agent."} Applies to new conversations.</span>
        </div>
      </div>
    </div>
  );
}

export default defineSettings({
  id: "router-basic",
  title: "Routing",
  icon: GitFork,
  group: "Agents",
  order: 3,
  entry: "routing",
  requires: ["settings"],
  keywords: ["default agent", "routing", "fallback", "else"],
  component: DefaultAgentSettings,
});
