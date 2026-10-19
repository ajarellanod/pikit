/**
 * proposals-local's step of `pikit doctor`, which `pikit dev` and `pikit up` run first: Compose, over
 * the project's files as `pikit up` reads them (compose.yaml, then every Compose file pikit.json lists,
 * in its order), lists a `deployer` service. Without it nothing deploys an approval: no deployment's
 * compose.yaml with the service, this component's Compose file not recorded, or a Compose that does
 * not apply its `!reset`. It runs `docker compose … config --services`, which starts nothing.
 * Without Docker here (a laptop running `pikit dev`), a note: nothing to check.
 *
 * `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`); the CLI calls `doctor(io)` in the
 * project's directory, in its own process, never in the app.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What the CLI gives the check (`component-doctor.ts`). */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

/** Runs `command` in `cwd`; rejects when it cannot start (`code: "ENOENT"` without the program). */
export type ComposeRunner = (command: readonly string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const spawnCompose: ComposeRunner = (command, cwd) =>
  new Promise((resolve, reject) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** `-f compose.yaml -f <file>…`: compose.yaml, then the Compose files pikit.json lists, as deployment-docker adds them. */
function composeArgs(cwd: string): string[] {
  const path = join(cwd, "pikit.json");
  const components = existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { components?: Record<string, { compose?: unknown }> }).components ?? {}) : {};
  const files = Object.values(components).flatMap((installed) => (typeof installed?.compose === "string" ? [installed.compose] : []));
  return ["compose.yaml", ...files].flatMap((file) => ["-f", file]);
}

export async function doctor(_io: DoctorIO, run: ComposeRunner = spawnCompose, cwd = process.cwd()): Promise<{ problems: string[]; notes: string[] }> {
  const command = ["docker", "compose", ...composeArgs(cwd), "config", "--services"];
  let result: Awaited<ReturnType<ComposeRunner>>;
  try {
    result = await run(command, cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { problems: [], notes: ["Docker is not installed here, so whether Compose runs the deployer was not checked: `pikit up` runs this check where Docker is"] };
    throw error;
  }
  const said = result.stderr.trim().split("\n").at(-1) ?? "";
  if (result.code !== 0) return { problems: [`\`${command.join(" ")}\` exited with code ${result.code}${said === "" ? "" : `: ${said}`}`], notes: [] };
  if (!result.stdout.split("\n").some((line) => line.trim() === "deployer")) {
    return {
      problems: [`Compose lists no deployer service (\`${command.join(" ")}\`): nothing would deploy what you approve. It needs deployment-docker's compose.yaml, this component's Compose file in pikit.json (\`pikit add proposals-local\` records it), and a Compose that applies its \`!reset\``],
      notes: [],
    };
  }
  return { problems: [], notes: [] };
}
