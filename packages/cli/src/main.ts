#!/usr/bin/env bun
/**
 * `pikit`: the CLI. It is tooling: it copies components into a project, edits the
 * project's files and runs the project, and it may use Node and Bun APIs to do so. It never imports
 * Pi (only `@pikit/pi-adapter` does), and it runs a project's own code in child processes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { add } from "./commands/add.ts";
import { newWizard } from "./commands/wizard.ts";
import { configure, LOGIN_METHODS, type LoginMethod } from "./commands/configure.ts";
import { DEPLOYMENT_COMMANDS, type DeploymentCommand, deployment, dev } from "./commands/deployment.ts";
import { doctor } from "./commands/doctor.ts";
import { newProject } from "./commands/new.ts";
import { registryCommand } from "./commands/registry.ts";
import { remove } from "./commands/remove.ts";
import { uiOff, uiOn } from "./commands/ui.ts";
import { upgrade } from "./commands/upgrade.ts";
import { PIKIT_ROOT } from "./paths.ts";
import { Cancelled, CliError, isInteractive, log } from "./ui.ts";

const USAGE = `pikit: a kit for Pi.

Usage:
  pikit new [--target <t>] [--preset <p>]   a new agent, step by step (in a terminal); flags answer its questions
  pikit new <dir> [--target server|durable] [--preset <name> [--with <component>]...] [--ui] [--registry <path>]   a new project (--ui: with the dashboard)
  pikit add <component>... [--registry <path>] [--force] [--yes]   several at once: one transaction, one install
  pikit remove <component> [--force]
  pikit upgrade [<component>...] [--dry-run] [--force] [--yes]   take the registry's version, merging your edits (without names, the dashboard too)
  pikit ui on | off [--force] [--yes]  the dashboard: src/dashboard/ and the admin API, or neither
  pikit doctor                        the component graph, and what is missing
  pikit configure [--yes] [--generate <NAME>]... [--login <provider> [--login-method browser|code] [--local]]
  pikit dev                           run the project here, reloading on change (on Cloudflare: wrangler dev)
  pikit up | down | restart | status  delegate to the installed deployment-* component
  pikit logs [--follow] [--tail <n>]
  pikit registry validate | generate | capabilities [<registry-root>]
  pikit --version

Project commands run in the current directory.`;

/**
 * Commands the former SPEC (§11) planned and pikit does not have yet: where each is specified now (a
 * file of the kit, and what to read there), or `""` when nothing current specifies it.
 */
const LATER: Record<string, string> = {
  init: "",
  create: "",
  outdated: "SPEC.md, P6",
  diff: "SPEC.md, P6",
  config: "features/config-files.md",
  expose: "",
  deploy: "",
};

const MINIMUM_BUN = "1.4.0";

async function main(argv: string[]): Promise<number> {
  // Bun ignores `engines`; older Bun never fires some stop deadlines.
  if (!Bun.semver.satisfies(Bun.version, `>=${MINIMUM_BUN}`)) {
    throw new CliError(`pikit requires Bun >= ${MINIMUM_BUN}, found ${Bun.version}. Run \`bun upgrade\`.`);
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      preset: { type: "string" },
      target: { type: "string" },
      with: { type: "string", multiple: true },
      ui: { type: "boolean" },
      registry: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      generate: { type: "string", multiple: true },
      login: { type: "string" },
      "login-method": { type: "string" },
      local: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      tail: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  const cwd = process.cwd();

  if (values.version) {
    console.log(`pikit ${version()}`);
    return 0;
  }
  if (command === undefined || values.help || command === "help") {
    console.log(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  const one = (what: string): string => {
    if (rest.length !== 1) throw new CliError(`usage: pikit ${command} <${what}>`, 2);
    return rest[0] as string;
  };

  switch (command) {
    case "new":
      // Without a directory, the guided path asks; `--target`, `--preset` and `--with` answer its questions.
      if (rest.length === 0) {
        if (!isInteractive()) throw new CliError("usage: pikit new <dir> [--preset <name>] (without <dir>, run it in a terminal: it asks)", 2);
        return await newWizard(cwd, {
          ...(values.registry !== undefined && { registry: values.registry }),
          ...(values.target !== undefined && { target: values.target }),
          ...(values.preset !== undefined && { preset: values.preset }),
          ...(values.with !== undefined && { with: values.with }),
          ...(values.ui !== undefined && { ui: values.ui }),
        });
      }
      await newProject(one("dir"), {
        ...(values.ui === true && { ui: true }),
        ...(values.target !== undefined && { target: values.target }),
        ...(values.preset !== undefined && { preset: values.preset }),
        ...(values.with !== undefined && { with: values.with }),
        ...(values.registry !== undefined && { registry: values.registry }),
      });
      return 0;
    case "add":
      if (rest.length === 0) throw new CliError("usage: pikit add <component>...", 2);
      await add(cwd, rest, {
        ...(values.registry !== undefined && { registry: values.registry }),
        force: values.force === true,
        yes: values.yes === true,
      });
      return 0;
    case "remove":
      await remove(cwd, one("component"), { force: values.force === true });
      return 0;
    case "upgrade":
      await upgrade(cwd, rest, { force: values.force === true, yes: values.yes === true, dryRun: values["dry-run"] === true });
      return 0;
    case "doctor": {
      const report = await doctor(cwd);
      return report.problems.length + report.unconfigured.length > 0 ? 1 : 0;
    }
    case "configure": {
      const method = values["login-method"];
      if (method !== undefined && values.login === undefined) throw new CliError("--login-method needs --login <provider>", 2);
      if (method !== undefined && !(LOGIN_METHODS as readonly string[]).includes(method)) {
        throw new CliError(`--login-method must be one of: ${LOGIN_METHODS.join(", ")}`, 2);
      }
      await configure(cwd, {
        yes: values.yes === true,
        generate: values.generate ?? [],
        ...(values.login !== undefined && { login: values.login }),
        ...(method !== undefined && { loginMethod: method as LoginMethod }),
        local: values.local === true,
      });
      return 0;
    }
    case "ui": {
      const action = one("on|off");
      if (action !== "on" && action !== "off") throw new CliError("usage: pikit ui on | off", 2);
      await (action === "on" ? uiOn : uiOff)(cwd, { force: values.force === true, yes: values.yes === true });
      return 0;
    }
    case "dev":
      return await dev(cwd);
    case "registry":
      return await registryCommand(rest[0], rest[1]);
  }
  if ((DEPLOYMENT_COMMANDS as readonly string[]).includes(command)) {
    const tail = values.tail === undefined ? undefined : Number(values.tail);
    if (tail !== undefined && !Number.isInteger(tail)) throw new CliError("--tail takes a number of lines", 2);
    await deployment(cwd, command as DeploymentCommand, { follow: values.follow === true, ...(tail !== undefined && { tail }) });
    return 0;
  }
  const later = LATER[command];
  if (later !== undefined) {
    log.info(`pikit ${command}: not built yet${later === "" ? "" : ` (see ${join(PIKIT_ROOT, later)})`}`);
    return 1;
  }
  throw new CliError(`unknown command "${command}"\n\n${USAGE}`, 2);
}

/** The CLI's version and the commit of the checkout it runs from. */
function version(): string {
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
  const head = Bun.spawnSync(["git", "-C", PIKIT_ROOT, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return head.exitCode === 0 ? `${version} (${head.stdout.toString().trim()})` : version;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Cancelled) {
    process.exitCode = 130;
  } else if (error instanceof CliError) {
    log.problem(error.message);
    process.exitCode = error.exitCode;
  } else if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    log.problem(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    // The message is what a user acts on; the stack is for reporting a bug in the CLI.
    log.problem(error instanceof Error ? error.message : String(error));
    if (process.env.PIKIT_DEBUG !== undefined) console.error(error);
    process.exitCode = 1;
  }
}
