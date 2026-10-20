/**
 * `pikit new <dir> [--target <server|durable>] [--preset <name> [--with <component>]...] [--ui] [--registry <path>]`:
 * a new project.
 *
 * `--with` answers the preset's questions (several channels: `--with channel-telegram --with
 * channel-http`) and adds the features it offers (`--with tool-mcp`): each a component, installed like
 * the preset's own, with the providers it brings (`withOffers`).
 *
 * A preset's `ui: true`, or `--ui`, gives it a UI (SPEC 5, `ui.ts`): the dashboard's files in
 * `src/dashboard/` and the components it needs, installed with the preset's: admin-api, and the defaults for `admin.auth` and `settings`
 * unless what the project gets declares them in every App (`uiComponentsFor`); its own `bun install`
 * runs after the project's. A feature the preset marks `ui: true` (self-improvement) brings it too.
 *
 * What the preset decides beside its components is resolved once, with the wizard (`preset-plan.ts`):
 * what the starter agent is granted (`steward`, never what happens to be installed), the config it
 * sets for the components chosen, the agent layout (`agents.folders`: SYSTEM.md, then the command its
 * feature declares), and whether the deployment does what the components need (`composition.ts`).
 * Its problems (a feature the deployment cannot run, a grant nothing provides) refuse the project
 * before its directory is made.
 *
 * On a server the new project is a git repository on `main`, everything committed (`initRepository`):
 * self-improvement's deployer merges approved proposals there. Without git it says so and goes on.
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
import { resolvePresetPlan } from "../project/preset-plan.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { isPortable, recordedLocation } from "../project/registry-location.ts";
import { initRepository } from "../project/git.ts";
import { kitCommit, vendorKit } from "../project/vendor.ts";
import { kindOf, TARGETS } from "../registry/manifest.ts";
import { CliError, log } from "../ui.ts";
import { checkCompatible, installComponent, installUiPackages, notPortable, warnUnchosen } from "./add.ts";
import { DASHBOARD_DIR, dashboardFiles } from "../project/dashboard.ts";
import { Undo } from "../project/undo.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";
import * as starter from "./starter.ts";
import { installDashboardPackages, uiComponentsFor, uiNext, writeDashboard } from "./ui.ts";
import { installedCommand, runComponentCommand } from "./component-commands.ts";

export interface NewOptions {
  preset?: string;
  /**
   * Answers to the preset's questions (`choose`): they replace the preset's component of their kind
   * (several of a `multiple` kind: Telegram and HTTP). And the preset's features to add (`features`).
   */
  with?: readonly string[];
  registry?: string;
  /** Print what to run next. Default: true; the guided path (`wizard.ts`) runs it instead. */
  next?: boolean;
  /** Say what is done, not each component's files and `bun install`'s output (the guided path). */
  quiet?: boolean;
  /** Where it runs: `server` (default) or `durable`. */
  target?: string;
  /** Add the dashboard when the preset does not already include it: `src/dashboard/` and its components. */
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
  if (options.preset === undefined && (options.with?.length ?? 0) > 0) throw new CliError("--with answers a preset's questions and adds its features: it needs --preset");
  const chosen = options.preset === undefined ? [] : registry.preset(options.preset, options.with ?? []);
  // The preset resolved once (`preset-plan.ts`), as the wizard showed it: what the chosen components
  // bring (offered providers, `offers.ts`: durable delivery for a chat channel, and what it needs), the
  // dashboard's components (`--ui`, the preset's `ui`, or a chosen feature's), what the steward is
  // granted, the config the preset sets and its agent layout; and whether the deployment does what
  // they need (`composition.ts`). A preset names its storage: an offer needs the registry's only
  // provider, which a second one would take away (`registry validate` checks each preset, `checkPresets`).
  const plan = options.preset === undefined ? undefined : resolvePresetPlan(registry, { preset: options.preset, targets, choices: options.with ?? [], ...(options.ui === true && { ui: true }) });
  const ui = plan?.ui ?? options.ui === true;
  const dashboard = ui ? dashboardFiles(registry) : undefined;
  if (ui && dashboard === undefined) throw new CliError(`the registry ${registry.root} has no dashboard (dashboard/files/)`);
  const forUi = plan?.uiComponents ?? (ui ? uiComponentsFor(registry, chosen, targets) : []);
  const { order: components, installedFor } = withOffers(registry, [...chosen, ...forUi], targets);
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
  if (plan !== undefined && plan.problems.length > 0) {
    throw new CliError(`the preset "${plan.preset}" cannot be made with these answers:\n${plan.problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  const installedTools = [...new Set(components.flatMap((c) => Object.keys(registry.manifest(c).replay?.tools ?? {})))];
  const steward = plan?.steward ?? { tools: [], extensions: [] };
  const folders = plan?.agents?.folders;
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
    write(".gitattributes", starter.GITATTRIBUTES);
    // Where `pikit` and the kit are, written in as in the skills.
    const commit = kitCommit();
    write("README.md", starter.withKitLocation(starter.readme(name, components, target, dashboard !== undefined, folders), PIKIT_ROOT, commit));
    write(CONFIG_FILE, starter.configFile(target));
    // Its prompt says where people reach it: the channels being installed.
    const channels = components.filter((c) => kindOf(c) === "channel").map((c) => ({ name: c, title: registry.manifest(c).title }));
    // What the steward is granted is the preset's (and its chosen features'): never what is installed.
    const layout = folders?.chosen === true ? folders.command : undefined;
    write(
      `src/agents/${starter.STARTER_AGENT}/agent.ts`,
      starter.agent({ model, channels, tools: steward.tools, extensions: steward.extensions, installed: installedTools, folders: layout }),
    );
    if (layout !== undefined) write(`src/agents/${starter.STARTER_AGENT}/SYSTEM.md`, `${starter.agentPrompt(steward.tools, channels)}\n`);
    write("src/extensions/agents.ts", starter.AGENTS);
    // The kit's skills for AI agents: how to write a component for this project, and where the kit is.
    for (const skill of starter.skillFiles(PIKIT_ROOT, commit)) {
      mkdirSync(dirname(join(projectDir, skill.path)), { recursive: true });
      write(skill.path, skill.text);
    }
    // `builtin` for this CLI's registry: the project resolves it wherever it is cloned.
    const location = recordedLocation(projectDir, registry.root);
    if (!isPortable(location)) log.warn(notPortable(location));
    writeProjectManifest(projectDir, emptyManifest(location, commit, targets));
    // The dashboard before the components: those with a view install it in src/dashboard/.
    if (dashboard !== undefined) {
      const project = readProjectManifest(projectDir);
      writeDashboard(projectDir, project, registry, "default", dashboard, forUi, new Undo(projectDir));
      writeProjectManifest(projectDir, project);
    }

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
    // The preset's config, for the components chosen (`plan.config`), as plain values.
    for (const [component, value] of Object.entries(plan?.config ?? {})) {
      if (installed.includes(component)) config = setConfigEntry(config, component, starter.configLiteral(value));
    }
    write(CONFIG_FILE, config);

    await bunInstall(projectDir, { quiet: options.quiet === true });
    if (dashboard !== undefined) {
      step(`bun install in ${DASHBOARD_DIR}/`);
      await installDashboardPackages(projectDir, true);
    }
    // The installed components' UI projects (their manifest's `ui`), each with its own packages.
    for (const component of Object.values(readProjectManifest(projectDir).components)) {
      if (component.ui === undefined) continue;
      step(`bun install in ${component.ui}/`);
      await installUiPackages(projectDir, component.ui, true);
    }

    // Agent folders own their generated registry: the preset's command (`agents.folders.command`, which
    // its feature declares) writes it once, so the project is current, not one that fails doctor.
    if (layout !== undefined) {
      step(`pikit ${layout}`);
      const command = installedCommand(projectDir, layout);
      if (command === undefined || (await runComponentCommand(projectDir, command, [])) !== 0) throw new CliError(`\`pikit ${layout}\` failed to generate the initial agent registry`);
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
  // On a server the project is a git repository: self-improvement's deployer merges into its main branch.
  if (target === "server") {
    const repository = await initRepository(projectDir, `pikit new ${name}`);
    if (repository.made) step(`git: a repository on main, everything committed (${repository.commit.slice(0, 7)})`);
    else log.warn(`not a git repository (${repository.why}): self-improvement needs one; \`git init\` and commit the project to have it`);
  }
  if (options.quiet !== true) log.ok(`created ${name} with ${installed.length} component(s); the app composes`);
  if (options.next === false) return;
  // What `pikit up` does is the installed deployment's: nothing is said of one that is not there.
  const elsewhere = starter.upText(installed);
  log.info(`\nNext:\n  cd ${dir}\n  pikit configure   # ${report.unconfigured.length > 0 ? "set the variables it needs, and log in to a model provider" : "log in to a model provider"}\n  pikit dev${elsewhere === undefined ? "         # run it here" : `         # or \`pikit up\` to ${elsewhere}`}`);
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
