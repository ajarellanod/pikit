/**
 * The three-way merge of one file, for `pikit upgrade` (SPEC P6): the user's copy ("yours"), the
 * file as it was installed (its base, `bases.ts`) and the registry's new version.
 *
 * It is `git merge-file -p`. Git is already required: the installer clones pikit with it, and the CLI
 * asks it for commits (`git.ts`). Its merge is the one users know from `git merge`: the same conflict
 * markers, conflicts narrowed to the lines that differ, line endings kept. The alternative, a diff3 on
 * top of `diff` (a root dev dependency, not the CLI's), would be a new dependency and our own merge
 * to maintain. Nothing is written: the merged text is returned, and `upgrade` writes it.
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
export function mergeFile(ours: string, base: string | undefined, theirs: string, theirsLabel: string): MergeResult {
  const empty = base === undefined ? mkdtempSync(join(tmpdir(), "pikit-merge-")) : undefined;
  try {
    if (empty !== undefined) writeFileSync(join(empty, "base"), "");
    const basePath = empty === undefined ? (base as string) : join(empty, "base");
    let run: ReturnType<typeof Bun.spawnSync>;
    try {
      run = Bun.spawnSync(["git", "merge-file", "-p", "-L", "yours", "-L", "base", "-L", theirsLabel, ours, basePath, theirs], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new CliError("pikit upgrade merges your edits with `git merge-file`, and git is not on PATH: install Git");
    }
    // The number of conflicts (at most 127), or 255 when it could not merge.
    const code = run.exitCode ?? 255;
    if (code > 127) return { error: run.stderr?.toString().trim().replace(/^error: /, "") || `git merge-file exited with ${code}` };
    return { content: Buffer.from(run.stdout as Uint8Array), conflicts: code };
  } finally {
    if (empty !== undefined) rmSync(empty, { recursive: true, force: true });
  }
}
