/**
 * agents-live's section of the Settings dialog, Agents (features/settings.md, "Multi-agent"): the
 * agents an operator made (agents-live's settings: one key per agent), created, edited and removed
 * here, live; and the project's own agents (`src/agents/`), listed read-only, their prompt, model and
 * tools changed in Agent (router-basic's section). Each tool and skill says what it does in one line
 * (`GET /admin/api/agents`' `tools` and `skills`).
 *
 * What agents-live's schema says is all it offers: the models the installed providers have, the
 * installed tools and extensions, the project's skills (each agent's `patternProperties`), and no code agent's name
 * (`propertyNames`). A save stores every live agent at once (`PUT`), refused whole when one is wrong.
 */

import { Community, EditPencil, Plus, Trash } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiAgents, type ApiSummary, useApi } from "@/lib/api";
import { SelectControl, SettingsHeading, SettingsRow } from "@/components/pikit/settings";
import { assistantName } from "@/lib/names";
import { choicesOf, defineSettings, type JsonSchema, type SettingsValue, useOpenSettingsSection, useSettings } from "@/lib/settings";
import { useShell } from "@/lib/shell";

/** An agent's name, as agents-live's schema says it. */
const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A live agent's fields, as stored under its name. */
type Fields = { description?: string; model: string; systemPrompt?: string; tools?: string[]; extensions?: string[]; skills?: string[] };

/** The agent being edited: `name` undefined while it is new and unnamed. */
type Draft = { original?: string; name: string; fields: Fields };

const field = "control w-full";

/** What `name` does, in one line (`ApiAgents.tools` or `skills`); `undefined` until read, or when it says nothing. */
const summaryIn = (list: readonly ApiSummary[] | undefined, name: string) => {
  const summary = list?.find((each) => each.name === name)?.summary;
  return summary === undefined || summary === "" ? undefined : summary;
};

function Editor({ draft, schema, taken, saving, onSave, onCancel }: { draft: Draft; schema: JsonSchema; taken: readonly string[]; saving: boolean; onSave: (draft: Draft) => void; onCancel: () => void }) {
  const catalog = useApi<ApiAgents>("/agents").data;
  const [name, setName] = useState(draft.name);
  const [fields, setFields] = useState<Fields>(draft.fields);
  const properties = schema.properties ?? {};
  const models = choicesOf(properties.model) ?? [];
  const tools = choicesOf(properties.tools?.items) ?? [];
  const extensions = choicesOf(properties.extensions?.items) ?? [];
  const skills = choicesOf(properties.skills?.items) ?? [];
  const isNew = draft.original === undefined;
  const nameProblem = !isNew
    ? undefined
    : name === ""
      ? "Give it a name."
      : !AGENT_NAME.test(name)
        ? "Lowercase letters and digits, words joined by -: support, sales-eu."
        : taken.includes(name)
          ? "An agent has this name already."
          : undefined;
  const set = (patch: Partial<Fields>) => setFields((current) => ({ ...current, ...patch }));
  const toggle = (list: readonly string[], all: readonly string[], item: string, on: boolean) => all.filter((each) => (each === item ? on : list.includes(each)));

  return (
    <div className="mt-2 rounded-card bg-canvas px-4 py-2 shadow-btn">
      <SettingsRow label="Name" description={isNew ? "How routing rules and conversations name it; it cannot change once made." : "It cannot change: routing rules and conversations name it."} htmlFor="agent-name">
        <input id="agent-name" aria-label="Name" value={name} disabled={!isNew} onChange={(event) => setName(event.target.value.trim())} placeholder="support" className={`${field} w-56`} />
      </SettingsRow>
      {nameProblem !== undefined && name !== "" && <p className="pb-2 text-[12.5px] text-red">{nameProblem}</p>}
      <SettingsRow label="Description" description="One line: what it is for." htmlFor="agent-description">
        <input id="agent-description" aria-label="Description" value={fields.description ?? ""} maxLength={300} onChange={(event) => set({ description: event.target.value })} placeholder="Answers billing questions" className={`${field} w-72`} />
      </SettingsRow>
      <SettingsRow label="Model" description="The model that answers, among the installed providers'." htmlFor="agent-model">
        <SelectControl id="agent-model" label="Model" value={fields.model} options={models.map((model) => ({ value: model, label: model }))} onChange={(model) => set({ model })} />
      </SettingsRow>
      <SettingsRow label="System prompt" description="What the agent is told before every conversation." stacked htmlFor="agent-prompt">
        <textarea
          id="agent-prompt"
          aria-label="System prompt"
          value={fields.systemPrompt ?? ""}
          onChange={(event) => set({ systemPrompt: event.target.value })}
          rows={8}
          spellCheck
          placeholder="You answer billing questions for Acme's customers, briefly and kindly."
          className="control min-h-40 w-full resize-y font-mono text-[12.5px] leading-relaxed"
        />
      </SettingsRow>
      {tools.length > 0 && (
        <>
          <SettingsHeading>Tools</SettingsHeading>
          {tools.map((tool) => (
            <SettingsRow key={tool} label={tool} description={summaryIn(catalog?.tools, tool) ?? (fields.tools?.includes(tool) ? "The agent may call it." : "Off: the agent does not have it.")}>
              <Switch checked={fields.tools?.includes(tool) === true} label={tool} onChange={(on) => set({ tools: toggle(fields.tools ?? [], tools, tool, on) })} />
            </SettingsRow>
          ))}
        </>
      )}
      {extensions.length > 0 && (
        <>
          <SettingsHeading>Extensions</SettingsHeading>
          {extensions.map((extension) => (
            <SettingsRow key={extension} label={extension} description={fields.extensions?.includes(extension) ? "The agent runs with it." : "Off."}>
              <Switch checked={fields.extensions?.includes(extension) === true} label={extension} onChange={(on) => set({ extensions: toggle(fields.extensions ?? [], extensions, extension, on) })} />
            </SettingsRow>
          ))}
        </>
      )}
      {skills.length > 0 && (
        <>
          <SettingsHeading>Skills</SettingsHeading>
          {skills.map((skill) => (
            <SettingsRow key={skill} label={skill} description={summaryIn(catalog?.skills, skill) ?? (fields.skills?.includes(skill) ? "The agent knows it, and loads it when a task needs it." : "Off: the agent does not know it.")}>
              <Switch checked={fields.skills?.includes(skill) === true} label={skill} onChange={(on) => set({ skills: toggle(fields.skills ?? [], skills, skill, on) })} />
            </SettingsRow>
          ))}
        </>
      )}
      <div className="flex justify-end gap-2 py-3">
        <Button size="sm" variant="quiet" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={saving || nameProblem !== undefined || fields.model === ""} onClick={() => onSave({ ...draft, name, fields })}>
          {isNew ? "Create" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** What to store of an agent's fields: nothing empty. */
function storedFields(fields: Fields): Fields {
  return {
    ...(fields.description !== undefined && fields.description.trim() !== "" && { description: fields.description.trim() }),
    model: fields.model,
    ...(fields.systemPrompt !== undefined && fields.systemPrompt !== "" && { systemPrompt: fields.systemPrompt }),
    ...(fields.tools !== undefined && fields.tools.length > 0 && { tools: fields.tools }),
    ...(fields.extensions !== undefined && fields.extensions.length > 0 && { extensions: fields.extensions }),
    ...(fields.skills !== undefined && fields.skills.length > 0 && { skills: fields.skills }),
  };
}

function AgentsSettings() {
  const live = useSettings("agents-live");
  const { agents, reloadAgents } = useShell();
  const openSection = useOpenSettingsSection();
  const [draft, setDraft] = useState<Draft>();
  const [failed, setFailed] = useState<Error>();
  /** The agent whose removal waits for a second click. */
  const [removing, setRemoving] = useState<string>();

  if (live.error !== undefined && live.section === undefined) return <ErrorNote error={live.error} title="The live agents cannot be read" />;
  const section = live.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  const schema = (Object.values((section.schema.patternProperties ?? {}) as Record<string, JsonSchema>)[0] ?? {}) as JsonSchema;
  const models = choicesOf(schema.properties?.model) ?? [];
  const stored = section.value as Record<string, Fields>;
  const names = Object.keys(stored).sort();
  const code = (agents ?? []).filter((agent) => agent.live !== true);
  const taken = [...names, ...code.map((agent) => agent.name)];

  const save = (value: SettingsValue) => {
    setFailed(undefined);
    live
      .save(value)
      .then(() => {
        setDraft(undefined);
        reloadAgents();
      })
      .catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };
  const saveDraft = (next: Draft) => {
    const value: SettingsValue = { ...section.value, [next.name]: storedFields(next.fields) };
    save(value);
  };
  const remove = (name: string) => {
    setRemoving(undefined);
    const value: SettingsValue = { ...section.value };
    delete value[name];
    save(value);
  };

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <SettingsHeading
        aside={
          draft === undefined && (
            <Button size="sm" variant="secondary" disabled={models.length === 0} onClick={() => setDraft({ name: "", fields: { model: models[0] ?? "", tools: [], extensions: [], skills: [] } })}>
              <Plus width={14} height={14} strokeWidth={2} />
              New agent
            </Button>
          )
        }
      >
        Made here
      </SettingsHeading>
      {draft !== undefined && draft.original === undefined && <Editor draft={draft} schema={schema} taken={taken} saving={live.saving} onSave={saveDraft} onCancel={() => setDraft(undefined)} />}
      {names.length === 0 && draft === undefined && (
        <p className="py-3 text-[13px] text-ink-3">None yet. An agent made here answers from its first message, with no deploy: start a conversation with it, or route a channel to it in Routing.</p>
      )}
      {names.map((name) =>
        draft?.original === name ? (
          <Editor key={name} draft={draft} schema={schema} taken={taken} saving={live.saving} onSave={saveDraft} onCancel={() => setDraft(undefined)} />
        ) : (
          <SettingsRow
            key={name}
            label={assistantName(name)}
            description={removing === name ? "Its conversations keep their history; at their next message each moves to the agent routed now (a rule's, or the default agent), in a new conversation. A rule naming it refuses its messages until changed." : [stored[name]?.description, stored[name]?.model].filter(Boolean).join(" · ")}
          >
            {removing === name ? (
              <div className="flex gap-1">
                <Button size="sm" variant="quiet" onClick={() => setRemoving(undefined)}>
                  Keep
                </Button>
                <Button size="sm" variant="danger" disabled={live.saving} onClick={() => remove(name)}>
                  Remove
                </Button>
              </div>
            ) : (
            <div className="flex gap-1">
              <Button size="sm" variant="quiet" aria-label={`Edit ${assistantName(name)}`} disabled={live.saving || draft !== undefined} onClick={() => setDraft({ original: name, name, fields: { ...(stored[name] as Fields) } })}>
                <EditPencil width={14} height={14} strokeWidth={1.8} />
                Edit
              </Button>
              <Button size="sm" variant="quiet" aria-label={`Remove ${assistantName(name)}`} disabled={live.saving || draft !== undefined} onClick={() => setRemoving(name)}>
                <Trash width={14} height={14} strokeWidth={1.8} />
              </Button>
            </div>
            )}
          </SettingsRow>
        ),
      )}

      <SettingsHeading>In the project's code</SettingsHeading>
      {code.length === 0 && <p className="py-3 text-[13px] text-ink-3">Loading</p>}
      {code.map((agent) => (
        <SettingsRow key={agent.name} label={assistantName(agent.name)} description={`${agent.model} · defined in src/agents/; its prompt, model, tools and skills are changed in Agent.`}>
          <Button size="sm" variant="quiet" onClick={() => openSection("router-basic")}>
            Open in Agent
          </Button>
        </SettingsRow>
      ))}
    </div>
  );
}

export default defineSettings({
  id: "agents-live",
  title: "Agents",
  icon: Community,
  group: "Agents",
  order: 1,
  requires: ["settings", "agent.directory"],
  keywords: ["agents", "new agent", "create", "live", "prompt", "model", "tools", "extensions", "skills"],
  component: AgentsSettings,
});
