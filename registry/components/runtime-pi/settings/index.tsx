/**
 * runtime-pi's section of the Settings dialog (features/settings.md): part 1 of the Agents entry, the
 * agents of the project's code (`src/agents/`), each one's system prompt, model, tools and skills
 * changed here (an operator's override over the agent's definition, applied from its next run).
 * agents-live's part, the agents made here, follows it. It reads and writes only runtime-pi's settings.
 *
 * What runtime-pi's schema says is all it reads: the agents (its properties; with an `agent.directory`
 * installed it accepts other names too, a live agent's, which are agents-live's to show), each one's
 * definition (the `default`s), the models of the providers with credentials (as runtime-pi found them
 * at start: a provider logged in since shows its models after the next start) and the tools and skills
 * the definition names (the options). It stores only what differs from the definition, so "Use default"
 * takes an override away. Each tool and skill says what it does in one line: `GET /admin/api/agents`'
 * `tools` and `skills` (a tool's `summary`, written where its component provides it; a skill's description).
 */

import { Community, EditPencil } from "iconoir-react";
import { Fragment, useState } from "react";
import { Button } from "@/components/bui/Button";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiAgents, type ApiSummary, useApi } from "@/lib/api";
import { PromptEditor, SelectControl, SettingsHeading, SettingsRow } from "@/components/pikit/settings";
import { assistantName } from "@/lib/names";
import { choicesOf, defineSettings, type JsonSchema, type SettingsValue, useSettings } from "@/lib/settings";

/** One agent's override (runtime-pi's settings): absent, the definition's. */
type Override = { systemPrompt?: string; model?: string; tools?: string[]; skills?: string[] };

/** What an agent's definition says, as the schema's `default`s carry it. */
type Definition = { systemPrompt: string; model: string; tools: string[]; skills: string[] };

/** What `name` does, in one line (`ApiAgents.tools` or `skills`); `undefined` until read, or when it says nothing. */
const summaryIn = (list: readonly ApiSummary[] | undefined, name: string) => {
  const summary = list?.find((each) => each.name === name)?.summary;
  return summary === undefined || summary === "" ? undefined : summary;
};

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((each) => b.includes(each));

const count = (n: number, one: string) => `${n === 0 ? "no" : n} ${one}${n === 1 ? "" : "s"}`;

/** An agent's definition, from its fields' `default`s. */
function definitionOf(fields: Record<string, JsonSchema>): Definition {
  return {
    systemPrompt: typeof fields.systemPrompt?.default === "string" ? fields.systemPrompt.default : "",
    model: typeof fields.model?.default === "string" ? fields.model.default : "",
    tools: Array.isArray(fields.tools?.default) ? (fields.tools.default as string[]) : [],
    skills: Array.isArray(fields.skills?.default) ? (fields.skills.default as string[]) : [],
  };
}

/** One agent's prompt, model, tools and skills; every change saved at once, through `save`. */
function AgentEditor({
  name,
  fields,
  override,
  saving,
  save,
  onDone,
}: {
  name: string;
  fields: Record<string, JsonSchema>;
  override: Override;
  saving: boolean;
  save: (next: Override) => void;
  onDone: () => void;
}) {
  const catalog = useApi<ApiAgents>("/agents").data;
  const definition = definitionOf(fields);
  const models = choicesOf(fields.model) ?? [definition.model];
  const toolOptions = choicesOf(fields.tools?.items) ?? definition.tools;
  const tools = override.tools ?? definition.tools;
  const skillOptions = choicesOf(fields.skills?.items) ?? definition.skills;
  const skills = override.skills ?? definition.skills;

  return (
    <section aria-label={`${assistantName(name)}'s settings`} className="rise-in mt-1 mb-3 rounded-card border border-line p-4 sm:p-5">
      <SettingsRow label="System prompt" description="What the agent is told before every conversation. Applies from its next run." stacked htmlFor="settings-system-prompt">
        <PromptEditor
          id="settings-system-prompt"
          label="System prompt"
          placeholder="You are a helpful assistant: answer briefly, ask when unsure."
          value={override.systemPrompt}
          fallback={definition.systemPrompt}
          saving={saving}
          onSave={(text) => save({ ...override, systemPrompt: text })}
          onReset={() => save({ ...override, systemPrompt: undefined })}
        />
      </SettingsRow>
      <SettingsRow label="Model" description="The model that answers, among those of the providers with credentials." htmlFor="settings-model">
        <SelectControl
          id="settings-model"
          label="Model"
          value={override.model ?? definition.model}
          disabled={saving}
          options={models.map((model) => ({ value: model, label: model === definition.model ? `${model} (default)` : model }))}
          onChange={(model) => save({ ...override, model })}
        />
      </SettingsRow>
      {toolOptions.length > 0 && (
        <>
          <SettingsHeading>Tools</SettingsHeading>
          {toolOptions.map((tool) => (
            <SettingsRow key={tool} label={tool} description={summaryIn(catalog?.tools, tool) ?? (tools.includes(tool) ? "The agent may call it." : "Off: the agent does not have it.")}>
              <Switch checked={tools.includes(tool)} label={tool} onChange={(on) => save({ ...override, tools: toolOptions.filter((each) => (each === tool ? on : tools.includes(each))) })} />
            </SettingsRow>
          ))}
        </>
      )}
      {skillOptions.length > 0 && (
        <>
          <SettingsHeading>Skills</SettingsHeading>
          {skillOptions.map((skill) => (
            <SettingsRow key={skill} label={skill} description={summaryIn(catalog?.skills, skill) ?? (skills.includes(skill) ? "The agent knows it, and loads it when a task needs it." : "Off: the agent does not know it.")}>
              <Switch checked={skills.includes(skill)} label={skill} onChange={(on) => save({ ...override, skills: skillOptions.filter((each) => (each === skill ? on : skills.includes(each))) })} />
            </SettingsRow>
          ))}
        </>
      )}
      <div className="flex justify-end gap-2 pt-3">
        {Object.keys(override).length > 0 && (
          <Button size="sm" variant="quiet" disabled={saving} onClick={() => save({})}>
            Use default
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

function CodeAgentsSettings() {
  const runtime = useSettings("runtime-pi");
  const [editing, setEditing] = useState<string>();
  const [failed, setFailed] = useState<Error>();

  if (runtime.error !== undefined && runtime.section === undefined) return <ErrorNote error={runtime.error} title="The agents' settings cannot be read" />;
  const section = runtime.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  // the code's agents only: a live agent's override (the schema's other names) is agents-live's to show
  const agents = Object.entries(section.schema.properties ?? {})
    .filter(([, schema]) => schema.properties?.systemPrompt !== undefined)
    .map(([name, schema]) => ({ name, fields: schema.properties ?? {} }));

  /** Saves `next` as `name`'s override, without what is the definition's; no key at all when nothing is left. */
  const saveOverride = (name: string, definition: Definition, next: Override) => {
    const kept: Override = {
      ...(next.systemPrompt !== undefined && next.systemPrompt !== definition.systemPrompt && { systemPrompt: next.systemPrompt }),
      ...(next.model !== undefined && next.model !== definition.model && { model: next.model }),
      ...(next.tools !== undefined && !sameSet(next.tools, definition.tools) && { tools: next.tools }),
      ...(next.skills !== undefined && !sameSet(next.skills, definition.skills) && { skills: next.skills }),
    };
    const all: SettingsValue = { ...section.value };
    if (Object.keys(kept).length === 0) delete all[name];
    else all[name] = kept;
    setFailed(undefined);
    runtime.save(all).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <SettingsHeading>In the project's code</SettingsHeading>
      {agents.length === 0 && <p className="py-3 text-[13px] text-ink-3">No agent in src/agents/.</p>}
      {agents.map(({ name, fields }) => {
        const definition = definitionOf(fields);
        const override = (section.value[name] ?? {}) as Override;
        const changed = Object.keys(override).length > 0;
        const open = editing === name;
        const description = [override.model ?? definition.model, count((override.tools ?? definition.tools).length, "tool"), changed && "changed here"].filter(Boolean).join(" · ");
        return (
          // a fragment, not a wrapper: the rows stay siblings, so only the last one drops its border
          <Fragment key={name}>
            <SettingsRow label={assistantName(name)} description={description}>
              <Button size="sm" variant="quiet" aria-label={`${open ? "Close" : "Edit"} ${assistantName(name)}`} aria-expanded={open} onClick={() => setEditing(open ? undefined : name)}>
                {!open && <EditPencil width={14} height={14} strokeWidth={1.8} />}
                {open ? "Close" : "Edit"}
              </Button>
            </SettingsRow>
            {open && (
              <AgentEditor
                key={name}
                name={name}
                fields={fields}
                override={override}
                saving={runtime.saving}
                save={(next) => saveOverride(name, definition, next)}
                onDone={() => setEditing(undefined)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export default defineSettings({
  id: "runtime-pi",
  title: "Agents",
  icon: Community,
  group: "Agents",
  order: 0,
  entry: "agents",
  requires: ["settings"],
  keywords: ["agents", "system prompt", "prompt", "model", "tools", "skills", "override", "use default"],
  component: CodeAgentsSettings,
});
