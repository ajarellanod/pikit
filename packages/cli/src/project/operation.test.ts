/** The marker of an unfinished `add`, `remove` or `upgrade` (`operation.ts`). */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../ui.ts";
import { assertNoIncompleteOperation, beginOperation, finishOperation, incompleteOperation, OPERATION_MARKER } from "./operation.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-operation-test-"));
  dirs.push(dir);
  return dir;
};

const thrown = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

test("begin writes the command as JSON; while it is there every check refuses, with what to do; finish deletes it", () => {
  const dir = temp();
  expect(incompleteOperation(dir)).toBeUndefined();
  assertNoIncompleteOperation(dir);

  beginOperation(dir, "pikit remove log-events --force");
  const recorded = JSON.parse(readFileSync(join(dir, OPERATION_MARKER), "utf8"));
  expect(recorded.command).toBe("pikit remove log-events --force");
  expect(Number.isNaN(Date.parse(recorded.startedAt))).toBe(false);

  const refused = thrown(() => assertNoIncompleteOperation(dir));
  expect(refused).toBeInstanceOf(CliError);
  const message = (refused as CliError).message;
  expect(message).toContain("`pikit remove log-events --force`");
  expect(message).toContain("did not finish");
  expect(message).toContain("run `bun install`");
  expect(message).toContain(`delete ${OPERATION_MARKER} and run \`pikit doctor\``);

  finishOperation(dir);
  expect(existsSync(join(dir, OPERATION_MARKER))).toBe(false);
  // Twice is fine: a rollback and a finish may both get there.
  finishOperation(dir);
});

test("begin never replaces a marker, nor writes through a symlink in its place", () => {
  const dir = temp();
  beginOperation(dir, "pikit add tool-bash");
  const second = thrown(() => beginOperation(dir, "pikit upgrade"));
  expect(second).toBeInstanceOf(CliError);
  expect((second as CliError).message).toContain("`pikit add tool-bash`");
  expect(JSON.parse(readFileSync(join(dir, OPERATION_MARKER), "utf8")).command).toBe("pikit add tool-bash");

  const linked = temp();
  const target = join(temp(), "elsewhere");
  symlinkSync(target, join(linked, OPERATION_MARKER));
  expect(thrown(() => beginOperation(linked, "pikit add tool-bash"))).toBeInstanceOf(CliError);
  expect(existsSync(target)).toBe(false);
});

test("a marker that is not the JSON begin writes, or not a file, still counts; a symlink's target is not read", () => {
  const dir = temp();
  writeFileSync(join(dir, OPERATION_MARKER), "not json");
  expect(incompleteOperation(dir)).toEqual({ command: "an unknown pikit command", startedAt: "" });
  expect(thrown(() => assertNoIncompleteOperation(dir))).toBeInstanceOf(CliError);

  const linked = temp();
  const secret = join(temp(), "secret.json");
  writeFileSync(secret, JSON.stringify({ command: "SECRET", startedAt: "" }));
  symlinkSync(secret, join(linked, OPERATION_MARKER));
  expect(incompleteOperation(linked)?.command).toBe("an unknown pikit command");
  // Deleting it deletes the link, never its target.
  finishOperation(linked);
  expect(existsSync(join(linked, OPERATION_MARKER))).toBe(false);
  expect(existsSync(secret)).toBe(true);
});
