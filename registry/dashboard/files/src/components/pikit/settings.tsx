/**
 * The Settings dialog's rows and controls, for every section to place (`lib/settings.ts`): a heading,
 * a row (a label, one line saying what it does, its control on the right), and the controls: a
 * segmented choice, a select, a switch (`bui/Switch`), a text, a prompt editor. `SchemaSettings`
 * renders a component's section from its schema alone. The rows and controls are the shared
 * `settings-rows` (no admin client), re-exported here.
 *
 * Choices, switches and selects save at once; a text and a prompt are saved with their own button.
 */

import { useId, useState } from "react";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { PromptEditor, Segmented, SelectControl, SettingsHeading, SettingsRow, TextControl } from "@/components/pikit/settings-rows";
import { choicesOf, type JsonSchema, type SettingsValue, useSettings } from "@/lib/settings";

export { type Choice, PromptEditor, Segmented, SelectControl, SettingsHeading, SettingsRow, TextControl } from "@/components/pikit/settings-rows";

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What to store of `value`: the keys whose value is not the default's (a default from config keeps following it). */
export function storedOf(value: SettingsValue, defaults: SettingsValue): SettingsValue {
  return Object.fromEntries(Object.entries(value).filter(([key, each]) => each !== undefined && !equal(each, defaults[key])));
}

/** A field's label: its schema's `title`, else its key in words. */
const labelOf = (key: string, schema: JsonSchema) => schema.title ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());

/**
 * `component`'s settings rendered from its schema: a switch for a boolean, a segmented choice for up
 * to three options and a select past them, a prompt editor for a long text (`maxLength` over 200, or
 * `format: "multiline"`), a text otherwise, a switch per option for a list of options. A field of
 * another shape is not shown: write a section of your own for it.
 */
export function SchemaSettings({ component, title }: { component: string; title?: string }) {
  const settings = useSettings(component);
  const [failed, setFailed] = useState<Error>();
  const base = useId();
  if (settings.error !== undefined && settings.section === undefined) return <ErrorNote error={settings.error} title="These settings cannot be read" />;
  const section = settings.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;

  const save = (key: string, next: unknown) => {
    setFailed(undefined);
    settings.save(storedOf({ ...section.value, [key]: next }, section.defaults)).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };
  const rows = Object.entries(section.schema.properties ?? {}).flatMap(([key, schema]) => {
    const value = section.value[key];
    const label = labelOf(key, schema);
    const id = `${base}-${key}`;
    const common = { label, description: schema.description };
    const choices = choicesOf(schema);
    // A text's placeholder: the schema's first example, else its default.
    const example = [schema.examples?.[0], schema.default].map((each) => (typeof each === "string" && each !== "" ? each : typeof each === "number" ? String(each) : undefined)).find((each) => each !== undefined);
    if (schema.type === "boolean") {
      return [
        <SettingsRow key={key} {...common}>
          <Switch checked={value === true} label={label} onChange={(next) => save(key, next)} />
        </SettingsRow>,
      ];
    }
    if (choices !== undefined && choices.length <= 3) {
      return [
        <SettingsRow key={key} {...common}>
          <Segmented label={label} value={String(value)} options={choices.map((each) => ({ value: each, label: each }))} onChange={(next) => save(key, next)} disabled={settings.saving} />
        </SettingsRow>,
      ];
    }
    if (choices !== undefined) {
      return [
        <SettingsRow key={key} {...common} htmlFor={id}>
          <SelectControl id={id} label={label} value={String(value)} options={choices.map((each) => ({ value: each, label: each }))} onChange={(next) => save(key, next)} disabled={settings.saving} />
        </SettingsRow>,
      ];
    }
    if (schema.type === "string" && (schema.format === "multiline" || (schema.maxLength ?? 0) > 200)) {
      return [
        <SettingsRow key={key} {...common} stacked htmlFor={id}>
          <PromptEditor id={id} label={label} value={typeof value === "string" ? value : undefined} {...(example !== undefined && { placeholder: example })} onSave={(next) => save(key, next)} saving={settings.saving} />
        </SettingsRow>,
      ];
    }
    if (schema.type === "string" || schema.type === "integer" || schema.type === "number") {
      const numeric = schema.type !== "string";
      return [
        <SettingsRow key={key} {...common} htmlFor={id}>
          <TextControl id={id} label={label} placeholder={example ?? (numeric ? "A number" : "Not set")} type={numeric ? "number" : "text"} value={value === undefined ? "" : String(value)} onSave={(next) => save(key, numeric ? Number(next) : next)} disabled={settings.saving} />
        </SettingsRow>,
      ];
    }
    const options = schema.type === "array" ? choicesOf(schema.items) : undefined;
    if (options !== undefined) {
      const on = new Set(Array.isArray(value) ? (value as unknown[]) : []);
      return [
        <div key={key}>
          <SettingsHeading>{label}</SettingsHeading>
          {options.map((option) => (
            <SettingsRow key={option} label={option}>
              <Switch checked={on.has(option)} label={option} onChange={(next) => save(key, options.filter((each) => (each === option ? next : on.has(each))))} />
            </SettingsRow>
          ))}
        </div>,
      ];
    }
    return [];
  });

  return (
    <div>
      {title !== undefined && <SettingsHeading>{title}</SettingsHeading>}
      {failed !== undefined && <ErrorNote error={failed} title="Not saved" />}
      {rows.length === 0 ? <p className="text-[13px] text-ink-3">Nothing to set here.</p> : rows}
    </div>
  );
}
