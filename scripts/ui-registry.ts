/**
 * pikit's shadcn registry (`@pikit`, SPEC §5): the dashboard's pieces and views as shadcn registry
 * items, so `shadcn add @pikit/<item>` installs them in a dashboard, or in any shadcn project that has
 * pikit's `lib` item. Generated from the sources, never written by hand:
 *
 *   bun scripts/ui-registry.ts generate   write registry/ui/r/*.json from the sources
 *   bun scripts/ui-registry.ts check      exit 1 when they are not what generate writes
 *
 * Items, each a `registry:file` list with its `target` from the dashboard's root (`~/src/…`) and its
 * content inline (what `shadcn build` makes):
 * - `lib`: the dashboard's client of the admin API, views and router (`src/lib/`, but shadcn's utils);
 * - the shared pieces of `src/components/pikit/`, one item each (`message`, `error-note`);
 * - `bui`: Beautiful UI's primitives as the dashboard has them (`src/components/bui/`);
 * - the base views of `src/views/` (`conversations`, `composition`);
 * - every registry component's view (its manifest's `view`), named after the component.
 * Imports decide the rest: `@/components/ui/<x>` is the shadcn primitive `x` (`registryDependencies`),
 * `@/components/pikit/<x>` and `@/lib/<x>` are `@pikit` items, `@/components/bui/<x>` is `@pikit/bui`,
 * a bare package is an npm dependency at the version the dashboard pins.
 *
 * Served from the repository: `registry/dashboard/files/components.json` names
 * `https://raw.githubusercontent.com/ajarellanod/pikit/main/registry/ui/r/{name}.json`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");
const DASHBOARD = join(REPO, "registry/dashboard/files");
const COMPONENTS = join(REPO, "registry/components");
export const OUTPUT = join(REPO, "registry/ui/r");

interface Source {
  /** Absolute path. */
  path: string;
  /** Where it goes, from the dashboard's root. */
  target: string;
}

interface Item {
  name: string;
  title: string;
  description: string;
  sources: Source[];
}

/** Every file under `dir`, relative, sorted. */
function list(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix))
    .sort()
    .flatMap((entry) => {
      const path = prefix === "" ? entry : `${prefix}/${entry}`;
      return statSync(join(dir, path)).isDirectory() ? list(dir, path) : [path];
    });
}

function folder(dir: string, target: string): Source[] {
  return list(dir).map((file) => ({ path: join(dir, file), target: `${target}/${file}` }));
}

function items(): Item[] {
  const all: Item[] = [];
  const lib = join(DASHBOARD, "src/lib");
  all.push({
    name: "lib",
    title: "pikit dashboard lib",
    description: "The dashboard's client of pikit's admin API (the token, useApi, live events), its views and its router.",
    sources: list(lib)
      .filter((file) => file !== "utils.ts")
      .map((file) => ({ path: join(lib, file), target: `src/lib/${file}` })),
  });
  const pieces = join(DASHBOARD, "src/components/pikit");
  // The shell's own (the sign-in, the product's mark and its files in public/) are not pieces to install.
  for (const file of list(pieces).filter((f) => f !== "sign-in.tsx" && f !== "mark.tsx")) {
    const name = file.replace(/\.tsx?$/, "");
    all.push({ name, title: name, description: `pikit's ${name} piece of the dashboard.`, sources: [{ path: join(pieces, file), target: `src/components/pikit/${file}` }] });
  }
  all.push({
    name: "bui",
    title: "Beautiful UI primitives",
    description: "Beautiful UI's primitives (MIT) as pikit's dashboard has them, fed by real data: the sidebar, the composer (its plus, slash and assistant menus), thinking, tool chips, context cards, pills, an operator's page, records tables, filter chips, a code block. They use the tokens and classes of the dashboard's src/index.css.",
    sources: folder(join(DASHBOARD, "src/components/bui"), "src/components/bui"),
  });
  const views = join(DASHBOARD, "src/views");
  for (const view of readdirSync(views).sort()) {
    all.push({ name: view, title: view, description: `The dashboard's ${view} view.`, sources: folder(join(views, view), `src/views/${view}`) });
  }
  for (const component of readdirSync(COMPONENTS).sort()) {
    const manifestPath = join(COMPONENTS, component, "component.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { view?: string; description: string };
    if (manifest.view === undefined) continue;
    all.push({
      name: component,
      title: component,
      description: `${component}'s view: ${manifest.description} Its admin API routes come with the component (pikit add ${component}).`,
      sources: folder(join(COMPONENTS, component, manifest.view), `src/views/${component}`),
    });
  }
  return all;
}

/** The npm versions the dashboard pins. */
function pinned(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(DASHBOARD, "package.json"), "utf8")) as Record<string, Record<string, string>>;
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/** The item's JSON, as `shadcn build` would make it. */
function itemJson(item: Item, versions: Record<string, string>, names: Set<string>): string {
  const npm = new Set<string>();
  const registry = new Set<string>();
  for (const source of item.sources) {
    const text = readFileSync(source.path, "utf8");
    for (const [, specifier = ""] of text.matchAll(/(?:from|import)\s+["']([^"'.][^"']*)["']/g)) {
      const ui = /^@\/components\/ui\/([\w-]+)$/.exec(specifier);
      const own = /^@\/(?:components\/pikit|lib)\/([\w-]+?)(?:\.tsx?)?$/.exec(specifier);
      if (ui !== null) registry.add(ui[1] as string);
      else if (specifier.startsWith("@/components/bui/")) {
        if (item.name !== "bui") registry.add("@pikit/bui");
      }
      else if (own !== null) {
        const name = own[1] === "utils" ? undefined : names.has(own[1] as string) ? (own[1] as string) : "lib";
        if (name !== undefined && name !== item.name) registry.add(`@pikit/${name}`);
      } else if (!specifier.startsWith("@/")) {
        const pkg = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] as string);
        if (pkg !== "react" && pkg !== "react-dom") npm.add(versions[pkg] === undefined ? pkg : `${pkg}@${versions[pkg]}`);
      }
    }
  }
  const json = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: item.name,
    type: "registry:file",
    title: item.title,
    description: item.description,
    ...(npm.size > 0 && { dependencies: [...npm].sort() }),
    ...(registry.size > 0 && { registryDependencies: [...registry].sort() }),
    files: item.sources.map((source) => ({
      path: relative(REPO, source.path),
      type: "registry:file",
      target: `~/${source.target}`,
      content: readFileSync(source.path, "utf8"),
    })),
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** Every file generate writes, by name in `registry/ui/r/`. */
export function generated(): Map<string, string> {
  const all = items();
  const names = new Set(all.map((item) => item.name));
  const versions = pinned();
  const files = new Map(all.map((item) => [`${item.name}.json`, itemJson(item, versions, names)]));
  const index = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "pikit",
    homepage: "https://github.com/ajarellanod/pikit",
    items: all.map((item) => ({ name: item.name, type: "registry:file", title: item.title, description: item.description })),
  };
  files.set("registry.json", `${JSON.stringify(index, null, 2)}\n`);
  return files;
}

if (import.meta.main) {
  const command = process.argv[2];
  const files = generated();
  if (command === "generate") {
    rmSync(OUTPUT, { recursive: true, force: true });
    mkdirSync(OUTPUT, { recursive: true });
    for (const [name, text] of files) writeFileSync(join(OUTPUT, name), text);
    console.log(`ui-registry: wrote ${files.size} file(s) to ${relative(REPO, OUTPUT)}`);
  } else if (command === "check") {
    const stale = [...files].filter(([name, text]) => !existsSync(join(OUTPUT, name)) || readFileSync(join(OUTPUT, name), "utf8") !== text).map(([name]) => name);
    const extra = existsSync(OUTPUT) ? readdirSync(OUTPUT).filter((name) => !files.has(name)) : [];
    if (stale.length + extra.length > 0) {
      console.error(`ui-registry: out of date (${[...stale, ...extra].join(", ")}): run \`bun scripts/ui-registry.ts generate\``);
      process.exit(1);
    }
    console.log("ui-registry: up to date");
  } else {
    console.error("usage: bun scripts/ui-registry.ts generate | check");
    process.exit(2);
  }
}
