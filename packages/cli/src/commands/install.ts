/** `bun install` in the project: after `package.json` changed, as step 7 of SPEC §10.5. */

import { CliError, log } from "../ui.ts";

/** With `quiet`, Bun's output is shown only when the install fails. */
export async function bunInstall(projectDir: string, options: { quiet?: boolean } = {}): Promise<void> {
  if (options.quiet !== true) log.step("bun install");
  const output = options.quiet === true ? "pipe" : "inherit";
  const child = Bun.spawn([process.execPath, "install"], { cwd: projectDir, stdin: "ignore", stdout: output, stderr: output });
  const [code, out, err] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  if (code !== 0) {
    if (options.quiet === true) process.stderr.write(out + err);
    throw new CliError(`\`bun install\` failed with code ${code} in ${projectDir}`);
  }
}
