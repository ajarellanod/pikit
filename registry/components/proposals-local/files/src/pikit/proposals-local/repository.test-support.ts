/**
 * A proposals repository for proposals-local's tests, made with isomorphic-git (no git binary
 * needed): a bare repository whose `main` has a few files, and branches committed onto it as the
 * steward pushes them. Test support: only tests import it.
 */

import * as fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import git from "isomorphic-git";

const AUTHOR = { name: "pikit agent", email: "agent@pikit.invalid" };

/** Commits `files` (a path's text, or `null` to delete it) onto `parent` (or as a first commit), on `ref`; resolves with the commit. */
export async function commitOnto(gitdir: string, ref: string, parent: string | undefined, files: Record<string, string | null>, message: string, timestamp = 1_790_000_000): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pikit-proposals-work-"));
  try {
    if (parent !== undefined) await git.checkout({ fs, dir, gitdir, ref: parent, force: true });
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        await rm(join(dir, path), { force: true });
        await git.remove({ fs, dir, gitdir, filepath: path });
      } else {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
        await git.add({ fs, dir, gitdir, filepath: path });
      }
    }
    const author = { ...AUTHOR, timestamp, timezoneOffset: 0 };
    return await git.commit({ fs, dir, gitdir, ref, message, author, committer: author, ...(parent !== undefined && { parent: [parent] }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A bare repository at `gitdir` whose `main` holds `files`; resolves with main's commit. */
export async function makeRepository(gitdir: string, files: Record<string, string> = { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" }): Promise<string> {
  await git.init({ fs, gitdir, bare: true, defaultBranch: "main" });
  return await commitOnto(gitdir, "refs/heads/main", undefined, files, "The project");
}
