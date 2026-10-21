/**
 * Scratch external registries for tests: components under any names, generated like a real
 * registry's (`registry generate`), so their manifests satisfy the whole schema
 * (`optional.capabilities` included) and `registry validate` holds them to every rule. Then the
 * hand-written fields a test needs (`deployment`, `requires.deployment`, `compose`, a `title`) on top.
 *
 * Their files load without node_modules: an app component is a plain object with `name` and `setup`
 * and no import at all; a `deployment-*` component (by its kind) exports the functions the CLI calls
 * on a deployment (`DEPLOYMENT_EXPORTS`), each doing nothing.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPLOYMENT_EXPORTS } from "../project/deployment-module.ts";
import { generate } from "../registry/commands.ts";
import { kindOf, type Manifest, readManifest, writeManifest } from "../registry/manifest.ts";

export interface ScratchComponent {
  /** What a preset's question or feature shows. */
  title?: string;
  /** Default: `["server"]`. */
  targets?: string[];
  /** The body of its `setup(pikit)`; nothing by default. A deployment has no setup. */
  setup?: string;
  /** Hand-written fields set after generating (`deployment`, `compose`); `requires` is merged into the generated one (`{ deployment: [...] }`). */
  manifest?: Partial<Omit<Manifest, "requires">> & { requires?: Partial<Manifest["requires"]> };
  /** More files of src/pikit/<name>/ (a Compose file): path → text. */
  files?: Record<string, string>;
}

/** A fresh directory under the system's temporary one; the caller removes it. */
export function scratchDir(prefix = "pikit-composition-registry-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A registry at `root` with these components (name → what it is) and presets (name → YAML), generated
 * twice: once to write the derived fields, once more over the hand-written ones (key order, index).
 * Throws with the problems when generating fails.
 */
export async function compositionRegistry(root: string, components: Record<string, ScratchComponent>, presets: Record<string, string> = {}): Promise<string> {
  for (const [name, spec] of Object.entries(components)) writeComponent(root, name, spec);
  await regenerate(root);
  for (const [name, spec] of Object.entries(components)) {
    editManifest(root, name, (manifest) => {
      const { requires, ...fields } = spec.manifest ?? {};
      return {
        ...manifest,
        targets: spec.targets ?? ["server"],
        ...(spec.title !== undefined && { title: spec.title }),
        ...fields,
        requires: { ...manifest.requires, ...requires },
      } as Manifest;
    });
  }
  await regenerate(root);
  writePresets(root, presets);
  return root;
}

/** Writes (or overwrites) presets/<name>.yaml for each. */
export function writePresets(root: string, presets: Record<string, string>): void {
  if (Object.keys(presets).length === 0) return;
  mkdirSync(join(root, "presets"), { recursive: true });
  for (const [name, yaml] of Object.entries(presets)) writeFileSync(join(root, "presets", `${name}.yaml`), yaml);
}

/** Rewrites a component's component.json in generated form, without regenerating: how a test makes one drift. */
export function editManifest(root: string, name: string, edit: (manifest: Manifest) => Manifest): void {
  const dir = join(root, "components", name);
  const manifest = readManifest(dir);
  if (manifest === undefined) throw new Error(`${name} has no component.json`);
  writeManifest(dir, edit(manifest));
}

/** The registry's manifest of `name`, as written. */
export function manifestOf(root: string, name: string): Manifest {
  const manifest = readManifest(join(root, "components", name));
  if (manifest === undefined) throw new Error(`${name} has no component.json`);
  return manifest;
}

async function regenerate(root: string): Promise<void> {
  const { problems } = await generate(root);
  if (problems.length > 0) throw new Error(`the scratch registry does not generate:\n${problems.join("\n")}`);
}

function writeComponent(root: string, name: string, spec: ScratchComponent): void {
  const own = join(root, "components", name, "files", "src", "pikit", name);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(root, "components", name, "README.md"), `# ${name}\n\nA component of a scratch registry.\n`);
  writeFileSync(join(own, "index.ts"), kindOf(name) === "deployment" ? deploymentSource() : componentSource(name, spec.setup ?? ""));
  writeFileSync(join(own, `${name}.test.ts`), "// the component's own test\n");
  for (const [file, text] of Object.entries(spec.files ?? {})) writeFileSync(join(own, file), text);
}

function componentSource(name: string, setup: string): string {
  return `const component = {\n  name: ${JSON.stringify(name)},\n  setup(pikit) {\n    ${setup}\n  },\n};\nexport default component;\n`;
}

function deploymentSource(): string {
  return Object.keys(DEPLOYMENT_EXPORTS)
    .map((command) => `export async function ${command}() {\n  return undefined;\n}\n`)
    .join("\n");
}
