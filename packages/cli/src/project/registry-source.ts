/**
 * A registry the CLI installs from. It reads a local directory: the registry of the
 * pikit checkout by default, or `--registry <path>`. Git URLs come later; the path and the commit
 * it was at are what `pikit.json` records.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { parse } from "yaml";
import Type, { type Static } from "typebox";
import { kindOf, type Manifest, ManifestSchema, readManifest, type RegistryIndex, SCHEMA_DIR, schemaProblems } from "../registry/manifest.ts";
import { BASES_DIR } from "./bases.ts";
import { CONFIG_FILE } from "./config-file.ts";
import { ENV_EXAMPLE, ENV_FILE } from "./env-file.ts";
import { gitCommit } from "./git.ts";
import { PIKIT_JSON } from "./pikit-json.ts";
import { VENDOR_DIR } from "./vendor.ts";
import { confinedPath, isInside } from "./paths.ts";
export { isInside } from "./paths.ts";

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
  /** The starter agent's model the preset (its base, for an alias) declares; `undefined` leaves it to `pikit new`. */
  presetModel(name: string): string | undefined;
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
  const indexPath = confinedPath(root, "registry.json");
  if (!existsSync(indexPath)) throw new Error(`${root} is not a registry: it has no registry.json`);
  const raw: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
  const problems = schemaProblems(RegistryIndexSchema, raw);
  if (problems.length > 0) throw new Error(`${root} has an invalid registry.json: ${problems.join("; ")}`);
  const index = raw as RegistryIndex;
  for (const [name, entry] of Object.entries(index.components)) {
    if (!isInside(entry.path)) throw new Error(`${name}: the registry path "${entry.path}" leaves ${root}`);
  }
  const commit = gitCommit(root);

  const dir = (name: string): string => {
    const entry = Object.hasOwn(index.components, name) ? index.components[name] : undefined;
    if (entry === undefined) {
      throw new Error(`the registry ${root} has no component "${name}" (it has: ${Object.keys(index.components).join(", ")})`);
    }
    return confinedPath(root, entry.path);
  };

  return {
    root,
    commit,
    names: () => Object.keys(index.components),
    dir,
    manifest(name) {
      const componentDir = dir(name);
      confinedPath(componentDir, "component.json");
      const manifest = readManifest(componentDir);
      if (manifest === undefined) throw new Error(`the registry's component "${name}" has no component.json`);
      // Checked before anything is installed from it: a registry may not be this repository's.
      const problems = schemaProblems(ManifestSchema, manifest);
      if (problems.length > 0) throw new Error(`the registry's component "${name}" has an invalid component.json: ${problems.join("; ")}`);
      if (manifest.name !== name) throw new Error(`the registry's component "${name}" has component.json name "${manifest.name}"`);
      for (const field of ["config", "migrations"] as const) {
        if (manifest[field] !== undefined) confinedPath(componentDir, manifest[field]);
      }
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
      const dir = confinedPath(root, "presets");
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
    presetModel(name) {
      return presetBase(root, name).base.model;
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
        const from = confinedPath(componentDir, source);
        if (!isInside(target)) throw new Error(`${name}: the file target "${target}" leaves the project`);
        // Refused with --force too: the registry may be anyone's, and these are not a component's to write.
        if (isProtected(target)) throw new Error(`${name}: the file target "${target}" is the project's own (${PROTECTED}); no component writes it`);
        const stat = statSync(from);
        if (stat.isDirectory()) {
          // `files/src` → `src` is the only directory mapping.
          if (source !== "files/src" || target !== "src") throw new Error(`${name}: only files/src → src may map a directory`);
          for (const file of listFiles(from)) files.set(`src/${file}`, join(from, file));
        } else {
          if (!stat.isFile()) throw new Error(`${name}: the source "${source}" is not a regular file`);
          files.set(posix.normalize(target.replaceAll("\\", "/")), from);
        }
      }
      return files;
    },
  };
}

/**
 * The project's own records, which no component may write, whatever `--force` says: what the CLI and
 * Bun keep (`pikit.json`, `package.json`, the lockfile, `pikit.config.ts`, `.env.example`, `vendor/`,
 * `pikit-bases/`, `node_modules/`), the app's secrets and state (`.env`, `.pikit/`) and Git's (`.git`).
 */
const PROTECTED_FILES = [PIKIT_JSON, "package.json", "bun.lock", "bun.lockb", CONFIG_FILE, ENV_FILE, ENV_EXAMPLE, ".pikit-operation-unfinished", ".pikit-new-unfinished"];
const PROTECTED_DIRS = [".git", VENDOR_DIR, BASES_DIR, "node_modules", ".pikit"];
const PROTECTED = [...PROTECTED_FILES, ...PROTECTED_DIRS.map((dir) => `${dir}/`)].join(", ");

/**
 * A target that is one of the project's own records (`PROTECTED_FILES`) or lies under one of its own
 * directories (`PROTECTED_DIRS`). Without case: macOS and Windows would write `Package.json` over `package.json`.
 */
export function isProtected(target: string): boolean {
  const path = posix.normalize(target.replaceAll("\\", "/")).replace(/\/+$/, "").toLowerCase();
  return PROTECTED_FILES.includes(path) || PROTECTED_DIRS.includes(path.split("/")[0] as string);
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = confinedPath(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path).map((file) => `${entry.name}/${file}`));
    else if (entry.isFile()) files.push(entry.name);
    else throw new Error(`the source ${path} is not a regular file or directory`);
  }
  return files.sort();
}

const KEBAB = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
const RegistryIndexSchema = Type.Object({
  version: Type.Literal(1),
  components: Type.Record(Type.String({ pattern: KEBAB }), Type.Object({
    version: Type.String({ minLength: 1 }),
    description: Type.String(),
    targets: Type.Array(Type.String({ enum: ["server", "cloudflare"] }), { minItems: 1, uniqueItems: true }),
    path: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { additionalProperties: false }),
}, { additionalProperties: false });
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
    model: Type.Optional(
      Type.String({
        pattern: "^[^/\\s]+/\\S+$",
        description:
          "The starter agent's model, `<provider>/<modelId>`: a component of the preset provides its provider (`pikit new` checks it before writing). Default: the CLI's for the target (`anthropic/…` on a server, `openrouter/…` on Cloudflare).",
      }),
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
 * question. Nothing reads which preset a project came from. YAML 1.2. Either:
 * - a base: `components`, and optionally `choose`, one question per kind whose answers are every
 *   registry component of that kind (the listed one is the default), and `model`, the starter agent's; or
 * - an alias: `extends` a base and answers some of its questions with `with`, as `--with` does.
 */
export const PresetSchema = Type.Union([BasePresetSchema, AliasPresetSchema], {
  title: "pikit preset",
  description: "A preset of a pikit registry: a base, or an alias of one.",
});

/** Where a registry's preset schema lives; each preset names it in a `yaml-language-server` comment. */
export const PRESET_SCHEMA_FILE = `${SCHEMA_DIR}/preset.schema.json`;

type Preset = Static<typeof BasePresetSchema> & Partial<Static<typeof AliasPresetSchema>>;

/** One preset, as written: its shape checked against `PresetSchema`, its `choose` against its `components`. */
export function readPreset(root: string, name: string): Preset {
  if (!new RegExp(KEBAB).test(name)) throw new Error(`invalid preset name "${name}"`);
  const file = confinedPath(root, `presets/${name}.yaml`);
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
