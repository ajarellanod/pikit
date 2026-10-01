/**
 * The three-way merge of one file, for `pikit upgrade` (SPEC P6): the user's copy ("yours"), the
 * file as it was installed (its base, `bases.ts`) and the registry's new version.
 *
 * It is `git merge-file -p`. Git is already required: the installer clones pikit with it, and the CLI
 * asks it for commits (`git.ts`). Its merge is the one users know from `git merge`: the same conflict
 * markers, conflicts narrowed to the lines that differ, line endings kept. The alternative, a diff3 on
 * top of `diff` (a root dev dependency, not the CLI's), would be a new dependency and our own merge
 * to maintain. Nothing is written: the merged text is returned, and `upgrade` writes it.
 *
 * Git runs through async `Bun.spawn`, not `Bun.spawnSync`: on Bun 1.4.x a spawnSync can lose its
 * child's exit and spin at 100% CPU forever (oven-sh/bun#34069), and an upgrade runs one merge per
 * file you edited, so its odds grow with how much you made the components yours.
 *
 * TEMPORARY. When a Bun release ships the fix (oven-sh/bun#40078):
 * 1. Go back to `Bun.spawnSync` here, and make `mergeFile` and `planUpgrade` (`upgrade.ts`)
 *    synchronous again, as they were.
 * 2. Raise the minimum Bun to that release everywhere it is held, so no supported Bun has the bug:
 *    `scripts/require-bun.ts` (`MINIMUM`), `packages/cli/src/main.ts` (`MINIMUM_BUN`),
 *    `installer/install.sh` (`BUN_MINIMUM`, and `BUN_PINNED` at least as high), and `engines.bun`
 *    in the root and every `packages/*` package.json.
 * 3. `packages/cli/src/testing/cli.ts` may stay async; it cites the same issue.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../ui.ts";

export type MergeResult =
  /** Merged; with `conflicts` > 0, `content` has `<<<<<<< yours` … `>>>>>>> <theirs>` sections. */
  | { content: Buffer; conflicts: number }
  /** Git could not merge them (a binary file): nothing to write. */
  | { error: string };

/**
 * Merges `theirs`' changes since `base` into `ours` (absolute paths). Without a base (its file is
 * gone), every line is taken as added on both sides: what differs is a conflict. `theirsLabel`
 * names the new version in the markers (`log-events@0.2.0`).
 */
export async function mergeFile(ours: string, base: string | undefined, theirs: string, theirsLabel: string): Promise<MergeResult> {
  const empty = base === undefined ? mkdtempSync(join(tmpdir(), "pikit-merge-")) : undefined;
  try {
    if (empty !== undefined) writeFileSync(join(empty, "base"), "");
    const basePath = empty === undefined ? (base as string) : join(empty, "base");
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      // Throws at once (ENOENT) when git is not on PATH.
      child = Bun.spawn(["git", "merge-file", "-p", "-L", "yours", "-L", "base", "-L", theirsLabel, ours, basePath, theirs], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new CliError("pikit upgrade merges your edits with `git merge-file`, and git is not on PATH: install Git");
    }
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    // The number of conflicts (at most 127), or 255 when it could not merge.
    const code = exitCode ?? 255;
    if (code > 127) return { error: err.trim().replace(/^error: /, "") || `git merge-file exited with ${code}` };
    return { content: Buffer.from(out), conflicts: code };
  } finally {
    if (empty !== undefined) rmSync(empty, { recursive: true, force: true });
  }
}
