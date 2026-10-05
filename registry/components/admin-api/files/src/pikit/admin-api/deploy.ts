/**
 * admin-api's `beforeDeploy` (`component.json`: `"hooks": { "beforeDeploy": "deploy.ts" }`): the
 * deployment's `up` calls it before it bundles, and deploys nothing when it reports a problem.
 *
 * On Cloudflare (`pikit.json`'s `targets` has `durable`), in a project with a UI (`src/dashboard/`), it
 * builds the dashboard: `bun install --frozen-lockfile`, then `bun run build`, whose last step writes
 * `dashboard-files.ts` here, which the Worker bundles. A build that fails is the deploy's problem: a
 * Worker with a stale dashboard is worse than none deployed.
 *
 * On a server it builds nothing: deployment-docker's image builds the dashboard in a stage of its own
 * (its `Dockerfile`), from the project's directory alone, so `docker build` without the CLI has it
 * too. Building it here as well would build it twice.
 *
 * It runs on the machine that deploys, under Bun (the CLI's), never in the app: `Bun.spawn` and
 * `Bun.file` are its globals, and nothing is imported.
 */

/** What the deployment gives the hook (`hooks.beforeDeploy`). */
export interface BeforeDeployIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
  write(file: string, text: string): boolean;
  say(line: string): void;
}

/** Runs `command` in `cwd`: its exit code, and the end of what it printed. */
export type Run = (command: string[], cwd: string) => Promise<{ code: number; output: string }>;

/** The project's directory: this file is its `src/pikit/admin-api/deploy.ts`. */
const PROJECT = `${import.meta.dir}/../../..`;

export async function beforeDeploy(io: BeforeDeployIO): Promise<string[]> {
  return buildDashboard(PROJECT, io.say);
}

/** Builds `project`'s dashboard when it is on Cloudflare and has one; its problems (empty when done). */
export async function buildDashboard(project: string, say: (line: string) => void, run: Run = spawn): Promise<string[]> {
  const manifest = Bun.file(`${project}/pikit.json`);
  const targets = (await manifest.exists()) ? ((await manifest.json()) as { targets?: unknown }).targets : undefined;
  if (!Array.isArray(targets) || !targets.includes("durable")) return [];
  const dashboard = `${project}/src/dashboard`;
  if (!(await Bun.file(`${dashboard}/package.json`).exists())) return [];
  for (const command of [["bun", "install", "--frozen-lockfile"], ["bun", "run", "build"]]) {
    const { code, output } = await run(command, dashboard);
    if (code !== 0) {
      return [
        `the dashboard's \`${command.join(" ")}\` failed in src/dashboard/ (exit code ${code})${output === "" ? "" : `:\n${output}`}\n` +
          "Run it there to see why and fix it, then deploy again (or `pikit ui off` to deploy without a dashboard)",
      ];
    }
  }
  say("✓ admin-api: the dashboard is built into src/pikit/admin-api/dashboard-files.ts");
  return [];
}

/** At most this many characters of a failed command's output are reported. */
const OUTPUT_TAIL = 2_000;

const spawn: Run = async ([command, ...args], cwd) => {
  // `bun` is the CLI's own Bun.
  const child = Bun.spawn([command === "bun" ? process.execPath : (command as string), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}`.trim().slice(-OUTPUT_TAIL) };
};
