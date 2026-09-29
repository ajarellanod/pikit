/**
 * `component.json` and `registry.json`: their shape, their stable key
 * order, and which fields are generated.
 *
 * The shape is one typebox schema, `ManifestSchema`: the `Manifest` type is derived from it,
 * `validate` checks every component.json against it, `add` checks a component before installing it,
 * and `generate` writes it as JSON Schema to `schema/component.schema.json`, which every
 * component.json names in `$schema` so an editor completes and checks it too.
 *
 * Generated from `setup` (S14), rewritten by `generate`, checked by `validate`: `$schema`,
 * `provides`, `requires.capabilities`, `optional.capabilities`, `halves` and `replay.tools`. Everything
 * else is written by hand and `generate` never changes it.
 *
 * `setup` runs with the default config, and with each config in the `examples` of the component's
 * root config schema (describe.ts): a component that declares by config says so with examples.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

export const TARGETS = ["server", "cloudflare"] as const;

/** Where the registry's JSON Schemas live, relative to its root. */
export const SCHEMA_DIR = "schema";
export const COMPONENT_SCHEMA_FILE = `${SCHEMA_DIR}/component.schema.json`;
/** What a component.json's `$schema` says: `components/<name>/component.json` → the schema. */
export const COMPONENT_SCHEMA_REF = `../../${COMPONENT_SCHEMA_FILE}`;

const KEBAB = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
const SEMVER = "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$";
const ENV_NAME = "^[A-Z][A-Z0-9_]*$";
/** A JavaScript identifier: the name of an export. */
const IDENTIFIER = "^[A-Za-z_$][A-Za-z0-9_$]*$";
const TEXT = "\\S";
/** A file name of the component's own directory, `src/pikit/<name>/`. */
const OWN_FILE = "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*\\.ts$";

/**
 * `apps.worker` naming the default export: the component goes in both Apps as it is (SPEC §4.1, C1),
 * under its own name and config key in each (`secrets-cloudflare`, which works in both).
 */
export const BOTH_APPS = "default";

/** The Apps a Cloudflare project has in `pikit.config.ts` (SPEC C1). */
export type AppName = "default" | "worker";

/** What one half of a component declares in its App. */
const HalfSchema = Type.Object(
  {
    provides: Type.Array(Type.String()),
    requires: Type.Array(Type.String()),
    optional: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const EnvironmentVariableSchema = Type.Object(
  {
    name: Type.String({ pattern: ENV_NAME, description: "UPPER_SNAKE_CASE." }),
    secret: Type.Boolean({ description: "Asked without echo by `pikit configure`, never printed." }),
    required: Type.Boolean({ description: "`pikit configure` fails without it." }),
    description: Type.Optional(Type.String({ description: "What it is and where to get it." })),
  },
  { additionalProperties: false },
);

export const ManifestSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String({ description: "Generated: this schema, relative to the component.json." })),
    name: Type.String({ pattern: KEBAB, description: "kebab-case, prefixed by its kind (`channel-telegram`); equal to its directory." }),
    version: Type.String({ pattern: SEMVER, description: "semver." }),
    title: Type.Optional(
      Type.String({
        pattern: TEXT,
        description:
          "What `pikit new` shows when the component answers a preset's question (`choose`): \"Name: what it is\". Required for those components.",
      }),
    ),
    description: Type.String({ pattern: TEXT, description: "One sentence: what the component does for the project." }),
    license: Type.Optional(Type.String()),
    targets: Type.Array(Type.String({ enum: [...TARGETS] }), {
      minItems: 1,
      uniqueItems: true,
      description: "Where it runs. node:* and bun:* imports need exactly [\"server\"] (S5).",
    }),
    requires: Type.Object(
      {
        pikit: Type.String({ minLength: 1, description: "The @pikit/core versions it works with (a semver range)." }),
        capabilities: Type.Array(Type.String(), { description: "Generated from setup's use() calls." }),
      },
      { additionalProperties: false, description: "A component depends on capabilities, never on components." },
    ),
    optional: Type.Object(
      { capabilities: Type.Array(Type.String(), { description: "Generated from setup's useOptional() and useKeyed() calls." }) },
      { additionalProperties: false },
    ),
    provides: Type.Array(Type.String(), {
      description:
        "Generated from setup's provide() and provideKeyed() calls, with the default config and with each config in the `examples` of the component's config schema (for what it provides only when configured).",
    }),
    apps: Type.Optional(
      Type.Object(
        {
          worker: Type.String({
            pattern: IDENTIFIER,
            description:
              `The export of index.ts that goes in the Worker's App (\`export const worker\` of pikit.config.ts). A named export is the Worker's half: a component named "<name>-worker", its config key in \`workerConfig\` (\`registry validate\` checks it). "${BOTH_APPS}": the default export itself goes in both Apps, under its own name and config key in each.`,
          }),
        },
        {
          additionalProperties: false,
          description:
            "Where a component goes in a project on Cloudflare, which has two Apps (SPEC §4.1, C1): the App → the export of index.ts `pikit add` lists in it (and `pikit remove` takes out). The default export goes in the default App (the Durable Object's); without `apps`, only there. On a server, only the default export is listed. provides, requires and optional cover every half.",
        },
      ),
    ),
    halves: Type.Optional(
      Type.Object(
        { default: HalfSchema, worker: HalfSchema },
        {
          additionalProperties: false,
          description:
            "Generated when `apps.worker` names a half: what each App's half declares (provide, use, useOptional), so `pikit add` checks and offers providers per App.",
        },
      ),
    ),
    hooks: Type.Optional(
      Type.Object(
        {
          doctor: Type.Optional(
            Type.String({
              pattern: OWN_FILE,
              description:
                "A file of src/pikit/<name>/ exporting `doctor({ config, get })`, which resolves with its problems (empty when fine). `pikit doctor` (so `pikit up` and `pikit dev`) calls it once the app composes, with this component's config in pikit.config.ts and a reader of .env and the environment. It may reach the network; it writes nothing.",
            }),
          ),
          beforeDeploy: Type.Optional(
            Type.String({
              pattern: OWN_FILE,
              description:
                "A file of src/pikit/<name>/ exporting `beforeDeploy({ config, get, write, say })`, which resolves with its problems (empty when done). The deployment's `up` calls it before it builds or bundles, and deploys nothing on a problem. `write(file, text)` writes a file of src/pikit/<name>/ (what the build then takes), and only when its text changes.",
            }),
          ),
          afterDeploy: Type.Optional(
            Type.String({
              pattern: OWN_FILE,
              description:
                "A file of src/pikit/<name>/ exporting `afterDeploy({ url, config, get, say })`, which resolves with its problems (empty when done). The deployment's `up` calls it once the new version answers (SPEC §4.1, C8), with the deployed URL, this component's config in pikit.config.ts and a reader of .env and the environment.",
            }),
          ),
        },
        {
          additionalProperties: false,
          description:
            "Steps the CLI and the deployment run for this component, each a file of src/pikit/<name>/ exporting a function of the hook's name. `pikit add` records them in pikit.json, by project path.",
        },
      ),
    ),
    replay: Type.Optional(
      Type.Object(
        {
          tools: Type.Record(Type.String(), Type.String(), {
            description: "Generated: each agent.tool's replay (S10), with the default config; not the tools only the config schema's `examples` name.",
          }),
        },
        { additionalProperties: false },
      ),
    ),
    dependencies: Type.Record(Type.String(), Type.String({ minLength: 1 }), {
      description: "Exactly the npm packages its files import, pinned (package → version).",
    }),
    devDependencies: Type.Optional(
      Type.Record(Type.String(), Type.String({ pattern: SEMVER }), {
        description:
          "The npm packages the project needs to develop and deploy with it, which its files do not import (a tool it runs: deployment-cloudflare's `wrangler`), pinned to an exact version (package → version). `pikit add` puts them in the project's package.json devDependencies; `pikit remove` takes out those no other installed component declares. Never a package of `dependencies`, nor a kit package (`@pikit/*`).",
      }),
    ),
    files: Type.Array(
      Type.Object(
        { source: Type.String({ minLength: 1 }), target: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      { minItems: 1, description: "Component-relative source → project-relative target. Only files/src → src maps a directory." },
    ),
    environment: Type.Optional(Type.Array(EnvironmentVariableSchema, { description: "Variables `pikit configure` sets in .env." })),
    config: Type.Optional(Type.String({ description: "A component-relative path." })),
    migrations: Type.Optional(Type.String({ description: "A component-relative path." })),
  },
  { additionalProperties: false, title: "pikit component.json", description: "A component of a pikit registry." },
);

export type Manifest = Static<typeof ManifestSchema>;

/** The hooks a component may declare, in the order they run; each file exports a function of that name. */
export const HOOKS = ["doctor", "beforeDeploy", "afterDeploy"] as const;
export type Hook = (typeof HOOKS)[number];
export type EnvironmentVariable = Static<typeof EnvironmentVariableSchema>;
export type Half = Static<typeof HalfSchema>;

/**
 * `value` against `schema`, as plain messages (`/path: problem`); empty when it conforms. A field the
 * schema does not know is one message, not the validator's two.
 */
export function schemaProblems(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)]
    .filter((error) => error.message !== "must not have additional properties")
    .map((error) => `${error.instancePath || "/"}: ${error.message === "schema is false" ? "is not a known field" : error.message}`);
}

/** A schema as the JSON Schema file `generate` writes and `validate` compares. */
export function formatSchema(schema: TSchema): string {
  return `${JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", ...schema }, null, 2)}\n`;
}

/** What `setup` declares, in the manifest's terms. */
export interface Generated {
  provides: string[];
  requires: string[];
  optional: string[];
  /** Tool name → its replay; absent when the component provides no tool with its default config. */
  tools?: Record<string, string>;
  /**
   * The tools only its config schema's `examples` provide → their replay: checked (S10), never
   * written, since their names are the example's.
   */
  exampleTools?: Record<string, string>;
  /** What each App's half declares; absent unless `apps.worker` names a half. */
  halves?: Record<AppName, Half>;
}

/** Top-level key order: every field of the schema, `$schema` first. */
const KEY_ORDER = Object.keys(ManifestSchema.properties);

/** A component's kind: its name's prefix (`channel` for `channel-telegram`), AGENTS.md "Naming". */
export function kindOf(name: string): string {
  return name.split("-")[0] ?? "";
}

export function manifestPath(componentDir: string): string {
  return join(componentDir, "component.json");
}

/**
 * The component.json as written, unchecked: `generate` must read an unfinished one to complete it.
 * Whoever relies on its shape checks it first (`schemaProblems(ManifestSchema, …)`).
 */
export function readManifest(componentDir: string): Manifest | undefined {
  const path = manifestPath(componentDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** The manifest with its generated fields replaced; hand-written fields untouched. */
export function withGenerated(manifest: Manifest, generated: Generated): Manifest {
  const next: Manifest = {
    ...manifest,
    $schema: COMPONENT_SCHEMA_REF,
    requires: { ...manifest.requires, capabilities: generated.requires },
    optional: { ...manifest.optional, capabilities: generated.optional },
    provides: generated.provides,
  };
  if (generated.tools === undefined) delete next.replay;
  else next.replay = { ...manifest.replay, tools: generated.tools };
  if (generated.halves === undefined) delete next.halves;
  else next.halves = generated.halves;
  return next;
}

/** Stable text: fields in the schema's order, `requires.pikit` before `requires.capabilities`. */
export function formatManifest(manifest: Manifest): string {
  const fields = manifest as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (key in fields) ordered[key] = fields[key];
  // Unknown fields keep their place after these, so `validate` can name them instead of losing them.
  for (const [key, value] of Object.entries(fields)) if (!(key in ordered)) ordered[key] = value;
  const { pikit, capabilities, ...otherRequires } = manifest.requires;
  ordered.requires = { pikit, capabilities, ...otherRequires };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function writeManifest(componentDir: string, manifest: Manifest): void {
  writeFileSync(manifestPath(componentDir), formatManifest(manifest));
}

export interface RegistryIndex {
  /** Schema version of `registry.json`. */
  version: 1;
  components: Record<string, { version: string; description: string; targets: string[]; path: string }>;
}

/** `registry.json`, rebuilt from the manifests. Sorted by name, so its diff shows only changes. */
export function buildIndex(manifests: Manifest[]): RegistryIndex {
  const components: RegistryIndex["components"] = {};
  for (const m of [...manifests].sort((a, b) => a.name.localeCompare(b.name))) {
    components[m.name] = {
      version: m.version,
      description: m.description,
      targets: m.targets,
      path: `components/${m.name}`,
    };
  }
  return { version: 1, components };
}

export function formatIndex(index: RegistryIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
