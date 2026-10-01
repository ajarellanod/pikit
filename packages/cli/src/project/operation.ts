/**
 * The marker of a command that changes the project and has not finished: `.pikit-operation-unfinished`
 * at the project's root. `Undo` (`undo.ts`) puts the files back when a step fails, but it lives in
 * memory: a command killed between its first write and its end (Ctrl-C, a crash, a closed terminal)
 * leaves the project half-changed, and nothing would say so. And `node_modules` is never put back: once
 * `bun install` ran, even a clean rollback leaves it as the new `package.json` wanted it.
 *
 * So `add`, `remove` and `upgrade` refuse to start while the marker is there
 * (`assertNoIncompleteOperation`, before they plan anything), create it right before their first
 * write (`beginOperation`), and delete it once every write and `bun install` succeeded, or once a
 * rollback put everything back without `bun install` having run (`finishOperation`). `pikit doctor`
 * reports it as a problem. No later command removes an interrupted operation's marker automatically:
 * the person checks the project, runs `bun install`, deletes it, and runs `pikit doctor`. It holds the command, as JSON, to say which one.
 */

import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../ui.ts";
import { confinedPath } from "./paths.ts";

export const OPERATION_MARKER = ".pikit-operation-unfinished";

/** What the marker records. */
export interface Operation {
  /** The command as typed: `pikit remove log-events --force`. */
  command: string;
  /** When it began, ISO 8601. */
  startedAt: string;
}

function markerPath(projectDir: string): string {
  return join(projectDir, OPERATION_MARKER);
}

/**
 * The unfinished operation the marker names; `undefined` without a marker. A marker that is not a file
 * (a symlink, a directory) or not the JSON `beginOperation` writes still counts: its content is not
 * read, or not trusted, and `command` says so.
 */
export function incompleteOperation(projectDir: string): Operation | undefined {
  const path = markerPath(projectDir);
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const unknown: Operation = { command: "an unknown pikit command", startedAt: "" };
  if (!isFile) return unknown;
  try {
    const recorded = JSON.parse(readFileSync(path, "utf8")) as Partial<Operation>;
    return {
      command: typeof recorded.command === "string" && recorded.command !== "" ? recorded.command : unknown.command,
      startedAt: typeof recorded.startedAt === "string" ? recorded.startedAt : "",
    };
  } catch {
    return unknown;
  }
}

/** What to say about an unfinished operation, and what to do about it. */
export function incompleteOperationMessage(operation: Operation): string {
  const when = operation.startedAt === "" ? "" : `, started ${operation.startedAt},`;
  return (
    `\`${operation.command}\`${when} did not finish (${OPERATION_MARKER} is still there): the project may be half-changed, and node_modules may not match it.\n` +
    "Check the project (`git status` and `git diff`: pikit.json, package.json, bun.lock, pikit.config.ts, src/pikit/), put back or finish what is half-done, " +
    `run \`bun install\`, then delete ${OPERATION_MARKER} and run \`pikit doctor\``
  );
}

/** Refuses, before anything is planned, while an earlier command's marker is there. */
export function assertNoIncompleteOperation(projectDir: string): void {
  const operation = incompleteOperation(projectDir);
  if (operation !== undefined) throw new CliError(incompleteOperationMessage(operation));
}

/**
 * Creates the marker, right before the command's first write. Never over one that exists, a symlink
 * included (`wx`): another command may have created it since the check.
 */
export function beginOperation(projectDir: string, command: string): void {
  assertNoIncompleteOperation(projectDir);
  const operation: Operation = { command, startedAt: new Date().toISOString() };
  try {
    writeFileSync(confinedPath(projectDir, OPERATION_MARKER), `${JSON.stringify(operation, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(incompleteOperationMessage(incompleteOperation(projectDir) ?? { command: "another pikit command", startedAt: "" }));
    }
    throw error;
  }
}

/** Deletes the marker: every write succeeded, or all of them were put back and `bun install` never ran. */
export function finishOperation(projectDir: string): void {
  // rmSync unlinks a marker symlink, never its target; this fixed root-relative name has no ancestors below the root.
  rmSync(markerPath(projectDir), { force: true });
}
