/** `bun install` in the project: after `package.json` changed, as step 7 of SPEC §10.5. */

import { CliError, log } from "../ui.ts";

export async function bunInstall(projectDir: string): Promise<void> {
  log.step("bun install");
  const child = Bun.spawn([process.execPath, "install"], { cwd: projectDir, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new CliError(`\`bun install\` failed with code ${code} in ${projectDir}`);
}
