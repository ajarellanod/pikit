/**
 * A registry the CLI installs from (SPEC §10.4). M1 reads a local directory: the registry of the
 * pikit checkout by default, or `--registry <path>`. Git URLs come later; the path and the commit
 * it was at are what `pikit.json` records.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { parse } from "yaml";
import Type, { type Static } from "typebox";
import { kindOf, type Manifest, ManifestSchema, readManifest, type RegistryIndex, SCHEMA_DIR, schemaProblems } from "../registry/manifest.ts";

/** One question of `pikit new`: which component of `kind` the project gets. */
export interface PresetSlot {
  kind: string;
  question: string;
  /** The preset's own component of that kind: the answer when nobody chooses. */
  default: string;
  /** Every registry component of that kind, by name. `title` falls back to the name. */
  options: { name: string; title: string }[];
}

export interface Registry {
  /** Absolute path of the registry's root (where `registry.json` is). */
  root: string;
  /** The Git commit of the registry's repository, `-dirty` when its files have uncommitted changes. */
  commit: string | undefined;
  names(): string[];
  /** The component's manifest; throws when the registry has no such component. */
  manifest(name: string): Manifest;
  /** The component's package directory. */
  dir(name: string): string;
  /**
   * The preset's component names, in order, with `choices` (`--with`) replacing the preset's
   * component of the same kind. A kind the preset does not `choose` is refused: `pikit add` it after.
   */
  preset(name: string, choices?: readonly string[]): string[];
  /** Every preset, with the `title` `pikit new` shows for it, by name. An alias names its base in `extends`. */
  presets(): { name: string; title: string; extends?: string }[];
  /**
   * The preset's questions (its base's, for an alias), each with the preset's own answer as default.
   * With `targets`, only the components that run on all of them are answers.
   */
  slots(name: string, targets?: readonly string[]): PresetSlot[];
  /** Every file a component installs: project-relative target → absolute source. */
  files(name: string): Map<string, string>;
}

export function openRegistry(path: string): Registry {
  const root = resolve(path);
  const indexPath = join(root, "registry.json");
  if (!existsSync(indexPath)) throw new Error(`${root} is not a registry: it has no registry.json`);
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as RegistryIndex;
  const commit = gitCommit(root);

  const dir = (name: string): string => {
    const entry = index.components[name];
    if (entry === undefined) {
      throw new Error(`the registry ${root} has no component "${name}" (it has: ${Object.keys(index.components).join(", ")})`);
    }
    return join(root, entry.path);
  };

  return {
    root,
    commit,
    names: () => Object.keys(index.components),
    dir,
    manifest(name) {
      const manifest = readManifest(dir(name));
      if (manifest === undefined) throw new Error(`the registry's component "${name}" has no component.json`);
      // Checked before anything is installed from it: a registry may not be this repository's.
      const problems = schemaProblems(ManifestSchema, manifest);
      if (problems.length > 0) throw new Error(`the registry's component "${name}" has an invalid component.json: ${problems.join("; ")}`);
      return manifest;
    },
    preset(name, choices = []) {
      const { base, choices: aliased } = presetBase(root, name);
      const slots = new Map((base.choose ?? []).map((slot) => [slot.kind, slot]));
      const components = [...base.components];
      const chosen = new Set<string>();
      const apply = (choice: string, fromAlias: boolean) => {
        this.manifest(choice); // an unknown component fails here, with the registry's list
        const kind = kindOf(choice);
        if (!slots.has(kind)) {
          throw new Error(`the preset "${name}" has no choice of ${kind}-* components; add ${choice} after, with \`pikit add ${choice}\``);
        }
        if (!fromAlias && chosen.has(kind)) throw new Error(`--with names two ${kind}-* components; choose one`);
        if (!fromAlias) chosen.add(kind);
        components[components.findIndex((c) => kindOf(c) === kind)] = choice;
      };
      for (const choice of aliased) apply(choice, true);
      for (const choice of choices) apply(choice, false);
      return components;
    },
    presets() {
      const dir = join(root, "presets");
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((file) => file.endsWith(".yaml"))
        .map((file) => file.slice(0, -".yaml".length))
        .sort()
        .map((name) => {
          const preset = readPreset(root, name);
          return { name, title: preset.title ?? name, ...(preset.extends !== undefined && { extends: preset.extends }) };
        });
    },
    slots(name, targets = []) {
      const components = this.preset(name);
      const runs = (c: string) => targets.every((target) => this.manifest(c).targets.includes(target));
      return (presetBase(root, name).base.choose ?? []).map(({ kind, question }) => ({
        kind,
        question: question ?? `Which ${kind}?`,
        default: components.find((c) => kindOf(c) === kind) as string,
        options: Object.keys(index.components)
          .filter((c) => kindOf(c) === kind && runs(c))
          .sort()
          .map((c) => ({ name: c, title: this.manifest(c).title ?? c })),
      }));
    },
    files(name) {
      const componentDir = dir(name);
      const files = new Map<string, string>();
      for (const { source, target } of this.manifest(name).files) {
        const from = join(componentDir, source);
        if (!isInside(target)) throw new Error(`${name}: the file target "${target}" leaves the project`);
        if (statSync(from).isDirectory()) {
          // SPEC §10.2: `files/src` → `src` is the only directory mapping.
          if (source !== "files/src" || target !== "src") throw new Error(`${name}: only files/src → src may map a directory`);
          for (const file of listFiles(from)) files.set(`src/${file}`, join(from, file));
        } else {
          files.set(normalize(target).split("\\").join("/"), from);
        }
      }
      return files;
    },
  };
}

/** A relative path that stays inside the project: no `..`, not absolute. */
export function isInside(target: string): boolean {
  if (target === "" || isAbsolute(target)) return false;
  return !normalize(target).split(/[\\/]/).includes("..");
}

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !f.split("/").includes("node_modules") && statSync(join(dir, f)).isFile())
    .sort();
}

function gitCommit(root: string): string | undefined {
  const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (head.exitCode !== 0) return undefined;
  const status = Bun.spawnSync(["git", "-C", root, "status", "--porcelain", "--", "."], { stdout: "pipe", stderr: "ignore" });
  const dirty = status.stdout.toString().trim() !== "";
  return `${head.stdout.toString().trim()}${dirty ? "-dirty" : ""}`;
}

const KEBAB = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
const TEXT = "\\S";
const Title = Type.Optional(Type.String({ pattern: TEXT, description: "What `pikit new` shows if it asks which preset to start from." }));

const BasePresetSchema = Type.Object(
  {
    title: Title,
    components: Type.Array(Type.String({ pattern: KEBAB }), { minItems: 1, description: "The `pikit add` calls, in order." }),
    choose: Type.Optional(
      Type.Array(
        Type.Object(
          {
            kind: Type.String({ pattern: "^[a-z][a-z0-9]*$", description: "Every registry component of this kind answers; the one in `components` is the default." }),
            question: Type.Optional(Type.String({ pattern: TEXT, description: "What `pikit new` asks. Default: \"Which <kind>?\"." })),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, description: "One question of `pikit new` per entry; `--with <component>` answers it in a script." },
      ),
    ),
  },
  { additionalProperties: false },
);

const AliasPresetSchema = Type.Object(
  {
    title: Title,
    extends: Type.String({ pattern: KEBAB, description: "The base preset: an alias of an alias is refused." }),
    with: Type.Array(Type.String({ pattern: KEBAB }), { minItems: 1, description: "Answers to the base's questions, as `--with` gives them." }),
  },
  { additionalProperties: false },
);

/**
 * A preset (`presets/<name>.yaml`): the list of `add` calls, and a `title` for `pikit new`'s
 * question. Nothing reads which preset a project came from (SPEC §11). YAML 1.2 (SPEC §12). Either:
 * - a base: `components`, and optionally `choose`, one question per kind whose answers are every
 *   registry component of that kind (the listed one is the default); or
 * - an alias: `extends` a base and answers some of its questions with `with`, as `--with` does.
 */
export const PresetSchema = Type.Union([BasePresetSchema, AliasPresetSchema], {
  title: "pikit preset",
  description: "A preset of a pikit registry (SPEC §11): a base, or an alias of one.",
});

/** Where a registry's preset schema lives; each preset names it in a `yaml-language-server` comment. */
export const PRESET_SCHEMA_FILE = `${SCHEMA_DIR}/preset.schema.json`;

type Preset = Static<typeof BasePresetSchema> & Partial<Static<typeof AliasPresetSchema>>;

/** One preset, as written: its shape checked against `PresetSchema`, its `choose` against its `components`. */
export function readPreset(root: string, name: string): Preset {
  const file = join(root, "presets", `${name}.yaml`);
  if (!existsSync(file)) throw new Error(`the registry ${root} has no preset "${name}" (presets/${name}.yaml)`);
  const raw = (parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  const at = `presets/${name}.yaml`;
  // The union's own errors would not say which of the two was meant; `extends` says it.
  const alias = typeof raw === "object" && raw !== null && "extends" in raw;
  const problems = schemaProblems(alias ? AliasPresetSchema : BasePresetSchema, raw);
  if (problems.length > 0) throw new Error(`${at} (${alias ? "an alias" : "a base"} preset): ${problems.join("; ")}`);
  if (alias) {
    const { title, extends: base, with: choices } = raw as Static<typeof AliasPresetSchema>;
    return { ...(title !== undefined && { title }), components: [], extends: base, with: choices };
  }
  const preset = raw as Static<typeof BasePresetSchema>;
  const kinds = (preset.choose ?? []).map((c) => c.kind);
  if (new Set(kinds).size !== kinds.length) throw new Error(`${at}: \`choose\` lists a kind twice`);
  for (const kind of kinds) {
    // The default is the one listed component of that kind: none or several leaves nothing to replace.
    const listed = preset.components.filter((c) => kindOf(c) === kind);
    if (listed.length !== 1) throw new Error(`${at}: \`choose\` kind "${kind}" needs exactly one ${kind}-* component in \`components\`, found ${listed.length}`);
  }
  return preset;
}

/** The base preset behind `name`, and the choices an alias makes. One level: a base extends nothing. */
function presetBase(root: string, name: string): { base: Preset; choices: string[] } {
  const preset = readPreset(root, name);
  if (preset.extends === undefined) return { base: preset, choices: [] };
  const base = readPreset(root, preset.extends);
  if (base.extends !== undefined) throw new Error(`presets/${name}.yaml extends "${preset.extends}", which is an alias itself`);
  return { base, choices: preset.with ?? [] };
}
