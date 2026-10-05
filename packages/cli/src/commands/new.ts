/**
 * `pikit new <dir> [--target <server|durable>] [--preset <name> [--with <component>]...] [--ui] [--registry <path>]`:
 * a new project.
 *
 * `--ui` gives it a UI (SPEC §5, `ui.ts`): the dashboard's files in `src/dashboard/` and the components
 * it needs, installed with the preset's; its own `bun install` runs after the project's.
 *
 * It writes the project's own part (`starter.ts`), vendors the kit packages into `vendor/`, adds
 * every component of the preset through the same install flow as `pikit add`, runs
 * `bun install` once, and ends with `pikit doctor`. A preset is a list of `add` calls and nothing
 * else: no step here reads the preset's name.
 *
 * The target (`server` unless `--target` says otherwise) is recorded in `pikit.json`'s `targets`: every
 * component installed then and later must run there (`checkCompatible`), and the providers offered are
 * the ones that do. A target is a runtime model, not a provider (SPEC §4): on `durable` (an actor per
 * conversation, on Cloudflare), `pikit.config.ts` has two Apps (SPEC C1). The target is never
 * guessed from the preset: a preset for another target is refused, with the command that makes it.
 *
 * The starter agent's model is the preset's `model`, or the starter's for the target (`STARTER_MODEL`).
 * Its provider must be a component being installed, as their `component.json`'s `modelProviders` say
 * (`checkStarterModel`): otherwise doctor would fail on a project already written.
 *
 * Everything that can be refused is refused before the first file is written. What can still fail
 * after it (`bun install`, which needs the network, and the final doctor) leaves the directory as it
 * is, marked `UNFINISHED`: never a project the wizard continues, and the error says to delete it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_REGISTRY, PIKIT_ROOT } from "../paths.ts";
import { CONFIG_FILE, setConfigEntry } from "../project/config-file.ts";
import { emptyManifest, NEW_PROJECT_TARGETS, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { withOffers } from "../project/offers.ts";
import { starterModelProblem } from "../project/starter-model.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { isPortable, recordedLocation } from "../project/registry-location.ts";
import { kitCommit, vendorKit } from "../project/vendor.ts";
import { kindOf, TARGETS } from "../registry/manifest.ts";
import { CliError, log } from "../ui.ts";
import { checkCompatible, installComponent, notPortable, warnUnchosen } from "./add.ts";
import { DASHBOARD_DIR, dashboardFiles } from "../project/dashboard.ts";
import { Undo } from "../project/undo.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";
import * as starter from "./starter.ts";
import { checkUiTarget, installDashboardPackages, UI_COMPONENTS, uiNext, writeDashboard } from "./ui.ts";

export interface NewOptions {
  preset?: string;
  /** Answers to the preset's questions (`choose`): each replaces the preset's component of its kind. */
  with?: readonly string[];
  registry?: string;
  /** Print what to run next. Default: true; the guided path (`wizard.ts`) runs it instead. */
  next?: boolean;
  /** Say what is done, not each component's files and `bun install`'s output (the guided path). */
  quiet?: boolean;
  /** Where it runs: `server` (default) or `durable`. */
  target?: string;
  /** With a UI (SPEC §5): `src/dashboard/`, and the components it needs (`ui.ts`). */
  ui?: boolean;
}

/** Refuses a `--target` that is not one (exit 2). */
export function checkTarget(target: string): void {
  if (!(TARGETS as readonly string[]).includes(target)) throw new CliError(`--target is one of ${TARGETS.join(", ")}, not "${target}"`, 2);
}

/**
 * Written first in a new project's directory, deleted once doctor is green: a directory that has it is
 * a `pikit new` that stopped (a failed `bun install`, doctor's problems, Ctrl-C), not a project.
 * Nothing continues one, since what stopped it is not known: it is deleted and made again, which
 * only its own directory allows (it was empty or absent when `new` began).
 */
export const UNFINISHED = ".pikit-new-unfinished";

const UNFINISHED_TEXT = "`pikit new` did not finish this project: delete this directory, then run `pikit new` again.\n";

/** A project's directory name is its package name. */
export function validProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

export async function newProject(dir: string, options: NewOptions = {}): Promise<void> {
  const projectDir = resolve(dir);
  if (existsSync(join(projectDir, UNFINISHED))) throw new CliError(`${projectDir} is a \`pikit new\` that did not finish: delete it, then run it again`);
  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) throw new CliError(`${projectDir} exists and is not empty`);
  const name = basename(projectDir);
  if (!validProjectName(name)) throw new CliError(`"${name}" is not a valid package name: use lowercase letters, digits, "-", "." or "_"`);

  // Everything that can be refused is checked before the first file is written.
  const target = options.target ?? (NEW_PROJECT_TARGETS[0] as string);
  checkTarget(target);
  const targets = [target];
  const registry = openRegistry(options.registry ?? DEFAULT_REGISTRY);
  if (options.preset === undefined && (options.with?.length ?? 0) > 0) throw new CliError("--with answers a preset's questions: it needs --preset");
  const chosen = options.preset === undefined ? [] : registry.preset(options.preset, options.with ?? []);
  // What the chosen components bring (offered providers, `offers.ts`): durable delivery for a chat
  // channel, and what it needs. A preset lists only what every project of it uses, and names its
  // storage: an offer needs the registry's only provider, which a second one would take away
  // (`registry validate` checks that each preset composes, `checkPresets`).
  // A UI is the dashboard's files and what they need, added like the preset's own.
  if (options.ui === true) checkUiTarget(targets);
  const dashboard = options.ui === true ? dashboardFiles(registry) : undefined;
  if (options.ui === true && dashboard === undefined) throw new CliError(`the registry ${registry.root} has no dashboard (dashboard/files/)`);
  const asked = options.ui === true ? [...chosen, ...UI_COMPONENTS.filter((c) => !chosen.includes(c))] : chosen;
  const { order: components, installedFor } = withOffers(registry, asked, targets);
  warnUnchosen(registry, chosen, [], targets);
  // Each component is installed after the project's files are written: refuse one that cannot be first.
  try {
    for (const component of components) checkCompatible(targets, registry.manifest(component));
  } catch (error) {
    // The target is chosen, never guessed from the preset: say which one it runs on.
    const runsOn = TARGETS.find((t) => chosen.length > 0 && chosen.every((c) => registry.manifest(c).targets.includes(t)));
    if (!(error instanceof CliError) || options.target !== undefined || runsOn === undefined || runsOn === target) throw error;
    throw new CliError(`${error.message}; the preset "${options.preset}" runs on ${runsOn}: pikit new ${dir} --target ${runsOn} --preset ${options.preset}${(options.with ?? []).map((w) => ` --with ${w}`).join("")}`);
  }
  const tools = components.flatMap((c) => Object.keys(registry.manifest(c).replay?.tools ?? {}));
  const model = (options.preset === undefined ? undefined : registry.presetModel(options.preset)) ?? starter.starterModel(target);
  checkStarterModel(registry, components, target, model, options.preset);

  const step = (message: string) => options.quiet !== true && log.step(message);
  step(`creating ${projectDir}${options.preset ? ` from the preset "${options.preset}"` : ""}`);
  mkdirSync(projectDir, { recursive: true });
  const write = (file: string, text: string) => writeFileSync(join(projectDir, file), text);
  write(UNFINISHED, UNFINISHED_TEXT);
  let installed: string[];
  let report: Awaited<ReturnType<typeof doctor>>;
  try {
    mkdirSync(join(projectDir, "src", "agents", starter.STARTER_AGENT), { recursive: true });
    mkdirSync(join(projectDir, "src", "extensions"), { recursive: true });
    const kit = vendorKit(projectDir);
    write("package.json", starter.packageJson(name, kit));
    write("tsconfig.json", starter.tsconfig());
    write("bunfig.toml", starter.BUNFIG);
    write(".gitignore", starter.gitignore(target));
    write("README.md", starter.readme(name, components, target, dashboard !== undefined));
    write(CONFIG_FILE, starter.configFile(target));
    // Its prompt says where people reach it: the channels being installed.
    const channels = components.filter((c) => kindOf(c) === "channel").map((c) => ({ name: c, title: registry.manifest(c).title }));
    write(`src/agents/${starter.STARTER_AGENT}/agent.ts`, starter.agent(tools, model, channels));
    write("src/extensions/agents.ts", starter.AGENTS);
    // The kit's skills for AI agents: how to write a component for this project, and where the kit is.
    const commit = kitCommit();
    for (const skill of starter.skillFiles(PIKIT_ROOT, commit)) {
      mkdirSync(dirname(join(projectDir, skill.path)), { recursive: true });
      write(skill.path, skill.text);
    }
    // `builtin` for this CLI's registry: the project resolves it wherever it is cloned.
    const location = recordedLocation(projectDir, registry.root);
    if (!isPortable(location)) log.warn(notPortable(location));
    writeProjectManifest(projectDir, emptyManifest(location, commit, targets));

    for (const component of components) {
      const wiring = starter.STARTER_WIRING[component];
      const forComponent = installedFor.get(component);
      if (forComponent !== undefined) step(`${component}, for ${forComponent}`);
      await installComponent(projectDir, component, {
        yes: true,
        quiet: options.quiet === true,
        ...(wiring !== undefined && { wiring }),
        ...(forComponent !== undefined && { installedFor: forComponent }),
      });
    }
    installed = Object.keys(readProjectManifest(projectDir).components);
    let config = readFileSync(join(projectDir, CONFIG_FILE), "utf8");
    for (const [component, value] of Object.entries(starter.STARTER_CONFIG)) {
      if (installed.includes(component)) config = setConfigEntry(config, component, value);
    }
    write(CONFIG_FILE, config);
    if (dashboard !== undefined) {
      const project = readProjectManifest(projectDir);
      writeDashboard(projectDir, project, registry, "default", dashboard, UI_COMPONENTS, new Undo(projectDir));
      writeProjectManifest(projectDir, project);
    }

    await bunInstall(projectDir, { quiet: options.quiet === true });
    if (dashboard !== undefined) {
      step(`bun install in ${DASHBOARD_DIR}/`);
      await installDashboardPackages(projectDir, true);
    }

    step("pikit doctor");
    report = await doctor(projectDir, { quiet: true, componentChecks: false });
    for (const problem of report.problems) log.problem(problem);
    if (report.problems.length > 0) throw new CliError(`the new project has ${report.problems.length} problem(s)`);
  } catch (error) {
    // Kept, not deleted, so what failed can be read in it; it is marked, so nothing takes it for a project.
    const unfinished = `${projectDir} is left unfinished: delete it, then run \`pikit new\` again`;
    if (error instanceof CliError) throw new CliError(`${error.message}\n${unfinished}`, error.exitCode);
    // Not the user's to act on (a bug): it stays what it is, so `PIKIT_DEBUG` still prints its stack.
    if (error instanceof Error) error.message += `\n${unfinished}`;
    throw error;
  }
  rmSync(join(projectDir, UNFINISHED));
  if (options.quiet !== true) log.ok(`created ${name} with ${installed.length} component(s); the app composes`);
  if (options.next === false) return;
  const elsewhere = target === "durable" ? "deploy it to Cloudflare" : "run it in Docker";
  log.info(`\nNext:\n  cd ${dir}\n  pikit configure   # ${report.unconfigured.length > 0 ? "set the variables it needs, and log in to a model provider" : "log in to a model provider"}\n  pikit dev         # or \`pikit up\` to ${elsewhere}`);
  if (dashboard !== undefined) log.info(`\n${uiNext()}`);
}

/**
 * Refuses, before anything is written, a starter model whose provider the components do not install
 * (`starterModelProblem`). Only a preset installs components here, so there is always one to name.
 */
export function checkStarterModel(registry: Registry, components: readonly string[], target: string, model: string, preset: string | undefined): void {
  const problem = starterModelProblem(registry, components, target, model, preset);
  if (problem !== undefined) throw new CliError(problem);
}
