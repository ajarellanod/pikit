/**
 * `execution` / `execution.shell` conformance (SPEC §8.3, §14). The contract is Pi's `ExecutionEnv`
 * and Pi ships no suite for it, so this one lives with the adapter, and Pi's own `NodeExecutionEnv`
 * is its double. Runner-independent, like the core's suites:
 *
 *   for (const c of createExecutionConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * It checks what Pi's tools (`read`, `write`, `edit`, `bash`) rely on: paths relative to `cwd`,
 * failures returned as results and never thrown, and, for a shell, exit codes, output, the working
 * directory, the variables a command sees, timeouts and cancellation. An environment without a
 * shell (`execution` only) must answer `shell_unavailable`.
 */

import { BACKGROUND_CONTEXT, type ExecutionEnv, type ShellOutputUpdate, withAbortSignal } from "@earendil-works/pi-agent-core";
import type { ConformanceCase } from "@pikit/core/testing";

/** An environment built for one case. */
export interface ExecutionFixture {
  /** Its `cwd` is a new, empty directory the suite may write to. */
  env: ExecutionEnv;
  /** Whether `exec` runs commands (`execution.shell`). Without a shell it must answer `shell_unavailable`. */
  shell: boolean;
  /** Release what the fixture holds (the directory, the app). */
  dispose?(): Promise<void>;
}

const GROUP = "execution";
const ctx = BACKGROUND_CONTEXT;

export function createExecutionConformance(factory: () => ExecutionFixture | Promise<ExecutionFixture>): readonly ConformanceCase[] {
  const executionCase = (name: string, run: (env: ExecutionEnv, fixture: ExecutionFixture) => Promise<void>, needs?: "shell" | "no shell"): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        if (needs === "shell" && !fixture.shell) return;
        if (needs === "no shell" && fixture.shell) return;
        await run(fixture.env, fixture);
      } finally {
        await fixture.dispose?.();
      }
    },
  });

  return [
    executionCase("a relative path is relative to cwd", async (env) => {
      const expected = value(await env.joinPath([env.cwd, "notes", "a.txt"], ctx), "joinPath");
      expect(value(await env.absolutePath("notes/a.txt", ctx), "absolutePath"), expected, "absolutePath of a relative path");
    }),

    executionCase("writeFile creates parent directories, and readTextFile reads the text back", async (env) => {
      value(await env.writeFile("dir/sub/a.txt", "héllo ✓\nsecond line\n", ctx), "writeFile");

      expect(value(await env.readTextFile("dir/sub/a.txt", ctx), "readTextFile"), "héllo ✓\nsecond line\n", "the text");
      expect(value(await env.readTextLines("dir/sub/a.txt", { maxLines: 1 }, ctx), "readTextLines"), ["héllo ✓"], "the first line");
    }),

    executionCase("appendFile appends, and readBinaryFile returns the bytes", async (env) => {
      value(await env.writeFile("log.txt", "one\n", ctx), "writeFile");
      value(await env.appendFile("log.txt", "two\n", ctx), "appendFile");
      value(await env.writeFile("bytes.bin", new Uint8Array([0, 1, 254, 255]), ctx), "writeFile");

      expect(value(await env.readTextFile("log.txt", ctx), "readTextFile"), "one\ntwo\n", "the appended text");
      expect([...value(await env.readBinaryFile("bytes.bin", ctx), "readBinaryFile")], [0, 1, 254, 255], "the bytes");
    }),

    executionCase("fileInfo, exists and listDir describe what is there", async (env) => {
      value(await env.writeFile("dir/a.txt", "12345", ctx), "writeFile");
      value(await env.createDir("dir/inner", undefined, ctx), "createDir");

      const info = value(await env.fileInfo("dir/a.txt", ctx), "fileInfo");
      expect([info.name, info.kind, info.size], ["a.txt", "file", 5], "fileInfo");
      expect(value(await env.exists("dir/a.txt", ctx), "exists"), true, "exists of a file");
      expect(value(await env.exists("dir/missing.txt", ctx), "exists"), false, "exists of a missing file");
      const listed = value(await env.listDir("dir", ctx), "listDir").map((entry) => `${entry.name}:${entry.kind}`).sort();
      expect(listed, ["a.txt:file", "inner:directory"], "listDir");
    }),

    executionCase("renameFile replaces the destination, and remove deletes", async (env) => {
      value(await env.writeFile("from.txt", "new", ctx), "writeFile");
      value(await env.writeFile("to.txt", "old", ctx), "writeFile");
      value(await env.renameFile("from.txt", "to.txt", ctx), "renameFile");

      expect(value(await env.readTextFile("to.txt", ctx), "readTextFile"), "new", "the renamed file");
      expect(value(await env.exists("from.txt", ctx), "exists"), false, "the old name");
      value(await env.writeFile("tree/a/b.txt", "x", ctx), "writeFile");
      check(!(await env.remove("tree", undefined, ctx)).ok, "remove of a non-empty directory without recursive to fail");
      value(await env.remove("tree", { recursive: true }, ctx), "remove recursive");
      expect(value(await env.exists("tree", ctx), "exists"), false, "the removed directory");
    }),

    executionCase("failures are results, never throws: a missing file is not_found", async (env) => {
      const missing = await env.readTextFile("missing.txt", ctx);
      expect(missing.ok ? "ok" : missing.error.code, "not_found", "readTextFile of a missing file");
      const removed = await env.remove("missing.txt", undefined, ctx);
      expect(removed.ok ? "ok" : removed.error.code, "not_found", "remove of a missing file");
      const forced = await env.remove("missing.txt", { force: true }, ctx);
      check(forced.ok, "remove with force of a missing file to succeed");
    }),

    executionCase("createTempDir returns an existing directory", async (env) => {
      const dir = value(await env.createTempDir("pikit-conformance-", ctx), "createTempDir");
      const info = value(await env.fileInfo(dir, ctx), "fileInfo");
      expect(info.kind, "directory", "the temporary directory");
      await env.remove(dir, { recursive: true, force: true }, ctx);
    }),

    executionCase(
      "a command runs in cwd, and its exit code and output are reported",
      async (env) => {
        const run = await exec(env, "pwd -P > where.txt; echo hello; echo world; exit 3");
        const cwd = value(await env.canonicalPath(env.cwd, ctx), "canonicalPath");

        expect(run.exitCode, 3, "the exit code");
        expect(run.output, "hello\nworld\n", "the output");
        expect(value(await env.readTextFile("where.txt", ctx), "readTextFile").trim(), cwd, "the working directory");
      },
      "shell",
    ),

    executionCase(
      "options.cwd and options.env reach the command",
      async (env) => {
        value(await env.createDir("sub", undefined, ctx), "createDir");
        await exec(env, 'pwd -P > ../where.txt; printf "%s" "$PIKIT_CONFORMANCE" > ../value.txt', {
          cwd: "sub",
          env: { PIKIT_CONFORMANCE: "given ✓" },
        });
        const sub = value(await env.canonicalPath("sub", ctx), "canonicalPath");

        expect(value(await env.readTextFile("where.txt", ctx), "readTextFile").trim(), sub, "the working directory");
        expect(value(await env.readTextFile("value.txt", ctx), "readTextFile"), "given ✓", "the variable");
      },
      "shell",
    ),

    executionCase(
      "with inheritEnv false, a command sees only the variables it is given",
      async (env) => {
        await exec(env, 'printf "%s|%s" "${HOME:-unset}" "$ONLY" > seen.txt', { inheritEnv: false, env: { ONLY: "this" } });

        expect(value(await env.readTextFile("seen.txt", ctx), "readTextFile"), "unset|this", "what the command saw");
      },
      "shell",
    ),

    executionCase(
      "a command past its timeout is stopped with a timeout error",
      async (env) => {
        const started = Date.now();
        const result = await env.exec("sleep 10", { timeout: 0.3 }, ctx);

        expect(result.ok ? "ok" : result.error.code, "timeout", "the result");
        check(Date.now() - started < 5000, "the command to stop at its timeout");
      },
      "shell",
    ),

    executionCase(
      "cancelling the context stops the command with an aborted error",
      async (env) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("conformance: cancelled")), 200);
        const started = Date.now();
        const result = await env.exec("sleep 10", undefined, withAbortSignal(controller.signal, ctx));

        expect(result.ok ? "ok" : result.error.code, "aborted", "the result");
        check(Date.now() - started < 5000, "the command to stop when cancelled");
      },
      "shell",
    ),

    executionCase(
      "without a shell, exec answers shell_unavailable",
      async (env) => {
        const result = await env.exec("echo hello", undefined, ctx);
        expect(result.ok ? "ok" : result.error.code, "shell_unavailable", "the result");
      },
      "no shell",
    ),
  ];
}

/** Run `command` and collect its output from the updates. Fails the case if exec fails. */
async function exec(env: ExecutionEnv, command: string, options: { cwd?: string; env?: Record<string, string>; inheritEnv?: boolean } = {}) {
  let output = "";
  const apply = (update: ShellOutputUpdate) => {
    if (update.kind === "replace") output = update.output.text;
    else if (update.kind === "append") output += update.text;
    else if (update.kind === "slide") output = output.slice(update.drop) + update.text;
  };
  const result = await env.exec(command, { ...options, capture: { limits: { maxBytes: 65536, maxLines: 1000 } }, onUpdate: apply }, ctx);
  if (!result.ok) throw new Error(`${GROUP}: exec("${command}") failed: ${result.error.code} ${result.error.message}`);
  return { exitCode: result.value.exitCode, output };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }, what: string): T {
  if (!result.ok) throw new Error(`${GROUP}: ${what} failed: ${result.error.code ?? ""} ${result.error.message}`);
  return result.value;
}

function expect(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${GROUP}: expected ${what}`);
}
