/**
 * @pikit/pi-adapter/execution/testing: the `execution` contract on pi-durable, and two ways to
 * run pi-durable tools in a test. Runner-independent (a failed check throws) and neutral: the workerd
 * lane runs it in a Durable Object.
 *
 * - `createDurableExecutionConformance`: pi-durable's `ExecutionEnv`. pi-durable's own suite
 *   (`createEnvConformance`: binary and directory readers, `watch`, argv `exec`, output streams and
 *   window, timeout and abort), then what it does not check: `id` and paths, text reads and writes,
 *   `truncateFile`, `flushFile`, metadata, rename and remove, temporary files, a string command's
 *   `cwd`, `env` and `inheritEnv`, `spill`, a throwing `onOutput`, a missing working directory, and an
 *   environment without a shell or without `watch`. Run it on pi-durable's `NodeExecutionEnv` too: it is
 *   the reference.
 * - `callTool`: one direct `execute`, its result built as the Harness builds it (the retained output
 *   when it returns no content, an error result when it throws).
 * - `runToolCalls`: a real `Harness` (memory storage, pi-ai 1.0's faux model) whose model calls the
 *   tools one per turn, so arguments are validated and each call runs as its own durable task.
 * - `createWorkspaceGitConformance` (`workspace-git.ts`): the steward's git flow through an
 *   environment's shell against a remote, with real git's meaning, on every `execution` provider.
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  type EnvTarget,
  Harness,
  MemoryStorage,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import { createEnvConformance, createExpectAssertions, type ExpectLike } from "@earendil-works/pi-durable/testing";
import type { ConformanceCase } from "@pikit/core/testing";
import type { ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export {
  createWorkspaceGitConformance,
  WORKSPACE_GIT_FILES,
  type WorkspaceGitConformanceOptions,
  type WorkspaceGitFixture,
} from "./workspace-git.ts";

/** An environment built for one case. */
export interface DurableExecutionFixture {
  /** Its `cwd` is a new, empty directory the suite may write to. */
  env: ExecutionEnv;
  /** Release what the fixture holds (the directory, the app). */
  dispose?(): Promise<void>;
}

export interface DurableExecutionConformanceOptions {
  /** The test runner's `expect` (Bun's or Vitest's): pi-durable's cases check with it. */
  expect: ExpectLike;
  /** Whether `exec` runs commands (`execution.shell`). Without a shell it must answer `shell_unavailable`. Default: true. */
  shell?: boolean;
  /** Whether `watch` reports changes. Without, it must answer `not_supported`. Default: true. */
  watch?: boolean;
  /** Whether the shell's `ln -s` makes symbolic links. Default: `shell`. */
  symlinks?: boolean;
}

/** A case, and how long it may take when that is longer than a runner's default (pi-durable's `watch` cases). */
export type DurableExecutionCase = ConformanceCase & { readonly timeoutMs?: number };

const GROUP = "durable execution";
const ctx = BACKGROUND_CONTEXT;

export function createDurableExecutionConformance(
  factory: () => DurableExecutionFixture | Promise<DurableExecutionFixture>,
  options: DurableExecutionConformanceOptions,
): readonly DurableExecutionCase[] {
  const shell = options.shell ?? true;
  const watch = options.watch ?? true;
  const withFixture = async (run: (env: ExecutionEnv) => Promise<void>) => {
    const fixture = await factory();
    try {
      await run(fixture.env);
    } finally {
      await fixture.dispose?.();
    }
  };
  const executionCase = (name: string, run: (env: ExecutionEnv) => Promise<void>, needs?: "shell" | "no shell" | "no watch"): DurableExecutionCase | undefined => {
    if ((needs === "shell" && !shell) || (needs === "no shell" && shell) || (needs === "no watch" && watch)) return undefined;
    return { group: GROUP, name, run: () => withFixture(run) };
  };

  // pi-durable's cases, less those of what the environment does not have: they fail loudly if pi-durable renames them.
  const pi = createEnvConformance({ assertions: createExpectAssertions(options.expect), withEnv: withFixture, symlinks: options.symlinks ?? shell })
    .filter((c) => (shell || !/\bexec\b/.test(c.name)) && (watch || !c.name.startsWith("watch ")))
    .map((c): DurableExecutionCase => ({ group: "pi-durable env", name: c.name, run: () => c.run(), ...(c.timeoutMs !== undefined && { timeoutMs: c.timeoutMs }) }));

  return [...pi, ...[
    executionCase("id names the file namespace, and a relative path is relative to cwd", async (env) => {
      check(typeof env.id === "string" && env.id !== "", "a non-empty id");
      const expected = value(await env.joinPath([env.cwd, "notes", "a.txt"], ctx), "joinPath");
      same(value(await env.absolutePath("notes/a.txt", ctx), "absolutePath"), expected, "absolutePath of a relative path");
      same(value(await env.joinPath([expected, ".."], ctx), "joinPath"), value(await env.joinPath([env.cwd, "notes"], ctx), "joinPath"), "joinPath with ..");
    }),

    executionCase("writeFile creates parent directories, and readTextFile reads the text back", async (env) => {
      value(await env.writeFile("dir/sub/a.txt", "héllo ✓\nsecond line\n", ctx), "writeFile");

      same(value(await env.readTextFile("dir/sub/a.txt", ctx), "readTextFile"), "héllo ✓\nsecond line\n", "the text");
      same(value(await env.readTextLines("dir/sub/a.txt", { maxLines: 1 }, ctx), "readTextLines"), ["héllo ✓"], "the first line");
    }),

    executionCase("openTextLineReader reads line by line, saying whether each one ended", async (env) => {
      value(await env.writeFile("lines.txt", "one\ntwo\nlast", ctx), "writeFile");
      const reader = value(await env.openTextLineReader("lines.txt", ctx), "openTextLineReader");
      const lines = [];
      for (let line = value(await reader.readLine(ctx), "readLine"); line !== undefined; line = value(await reader.readLine(ctx), "readLine")) lines.push(line);
      await reader.close(ctx);
      same(
        lines,
        [
          { text: "one", terminated: true },
          { text: "two", terminated: true },
          { text: "last", terminated: false },
        ],
        "the lines",
      );
    }),

    executionCase("appendFile appends, and readBinaryFile returns the bytes", async (env) => {
      value(await env.writeFile("log.txt", "one\n", ctx), "writeFile");
      value(await env.appendFile("log.txt", "two\n", ctx), "appendFile");
      value(await env.writeFile("bytes.bin", new Uint8Array([0, 1, 254, 255]), ctx), "writeFile");

      same(value(await env.readTextFile("log.txt", ctx), "readTextFile"), "one\ntwo\n", "the appended text");
      same([...value(await env.readBinaryFile("bytes.bin", ctx), "readBinaryFile")], [0, 1, 254, 255], "the bytes");
    }),

    executionCase("truncateFile cuts a file and extends it with zeros; a missing file is not_found", async (env) => {
      value(await env.writeFile("t.bin", new Uint8Array([1, 2, 3, 4, 5]), ctx), "writeFile");
      value(await env.truncateFile("t.bin", 2, ctx), "truncateFile to 2");
      same([...value(await env.readBinaryFile("t.bin", ctx), "readBinaryFile")], [1, 2], "the cut file");
      value(await env.truncateFile("t.bin", 4, ctx), "truncateFile to 4");
      same([...value(await env.readBinaryFile("t.bin", ctx), "readBinaryFile")], [1, 2, 0, 0], "the extended file");
      same(code(await env.truncateFile("missing.bin", 0, ctx)), "not_found", "truncateFile of a missing file");
      same(code(await env.truncateFile("t.bin", -1, ctx)), "invalid", "truncateFile to a negative size");
    }),

    executionCase("flushFile succeeds on a file, and a missing file is not_found", async (env) => {
      value(await env.writeFile("f.txt", "kept", ctx), "writeFile");
      value(await env.flushFile("f.txt", ctx), "flushFile");
      same(value(await env.readTextFile("f.txt", ctx), "readTextFile"), "kept", "the flushed file");
      same(code(await env.flushFile("missing.txt", ctx)), "not_found", "flushFile of a missing file");
    }),

    executionCase("fileInfo, exists and listDir describe what is there", async (env) => {
      value(await env.writeFile("dir/a.txt", "12345", ctx), "writeFile");
      value(await env.createDir("dir/inner", undefined, ctx), "createDir");

      const info = value(await env.fileInfo("dir/a.txt", ctx), "fileInfo");
      same([info.name, info.kind, info.size], ["a.txt", "file", 5], "fileInfo");
      same(value(await env.exists("dir/a.txt", ctx), "exists"), true, "exists of a file");
      same(value(await env.exists("dir/missing.txt", ctx), "exists"), false, "exists of a missing file");
      const listed = value(await env.listDir("dir", ctx), "listDir").map((entry) => `${entry.name}:${entry.kind}`).sort();
      same(listed, ["a.txt:file", "inner:directory"], "listDir");
    }),

    executionCase("canonicalPath finds an existing path; a missing one is not_found (edit and write key their queue on it)", async (env) => {
      value(await env.writeFile("c/file.txt", "x", ctx), "writeFile");
      const dir = value(await env.canonicalPath(env.cwd, ctx), "canonicalPath of cwd");
      same(value(await env.canonicalPath("c/file.txt", ctx), "canonicalPath"), value(await env.joinPath([dir, "c", "file.txt"], ctx), "joinPath"), "the canonical path");
      same(code(await env.canonicalPath("c/missing.txt", ctx)), "not_found", "canonicalPath of a missing file");
    }),

    executionCase("renameFile replaces the destination, and remove deletes", async (env) => {
      value(await env.writeFile("from.txt", "new", ctx), "writeFile");
      value(await env.writeFile("to.txt", "old", ctx), "writeFile");
      value(await env.renameFile("from.txt", "to.txt", ctx), "renameFile");

      same(value(await env.readTextFile("to.txt", ctx), "readTextFile"), "new", "the renamed file");
      same(value(await env.exists("from.txt", ctx), "exists"), false, "the old name");
      value(await env.writeFile("tree/a/b.txt", "x", ctx), "writeFile");
      check(!(await env.remove("tree", undefined, ctx)).ok, "remove of a non-empty directory without recursive to fail");
      value(await env.remove("tree", { recursive: true }, ctx), "remove recursive");
      same(value(await env.exists("tree", ctx), "exists"), false, "the removed directory");
    }),

    executionCase("failures are results, never throws: a missing file is not_found", async (env) => {
      same(code(await env.readTextFile("missing.txt", ctx)), "not_found", "readTextFile of a missing file");
      same(code(await env.remove("missing.txt", undefined, ctx)), "not_found", "remove of a missing file");
      check((await env.remove("missing.txt", { force: true }, ctx)).ok, "remove with force of a missing file to succeed");
    }),

    executionCase("createTempDir returns an existing directory, createTempFile an empty file", async (env) => {
      const dir = value(await env.createTempDir("pikit-conformance-", ctx), "createTempDir");
      same(value(await env.fileInfo(dir, ctx), "fileInfo").kind, "directory", "the temporary directory");
      const file = value(await env.createTempFile({ prefix: "pikit-", suffix: ".log" }, ctx), "createTempFile");
      const info = value(await env.fileInfo(file, ctx), "fileInfo");
      same([info.kind, info.size, info.name.startsWith("pikit-"), info.name.endsWith(".log")], ["file", 0, true, true], "the temporary file");
      await env.remove(dir, { recursive: true, force: true }, ctx);
      await env.remove(file, { force: true }, ctx);
    }),

    executionCase(
      "a command runs in cwd; its exit code is the result, its output goes to onOutput",
      async (env) => {
        const run = await exec(env, "pwd -P > where.txt; echo hello; echo world; exit 3");
        const cwd = value(await env.canonicalPath(env.cwd, ctx), "canonicalPath");

        same(run.exitCode, 3, "the exit code");
        same(run.output, "hello\nworld\n", "the output");
        same(run.spillPath, undefined, "the spill path of a short output");
        same(value(await env.readTextFile("where.txt", ctx), "readTextFile").trim(), cwd, "the working directory");
      },
      "shell",
    ),

    executionCase(
      "options.cwd and options.env reach the command",
      async (env) => {
        value(await env.createDir("sub", undefined, ctx), "createDir");
        await exec(env, 'pwd -P > ../where.txt; printf "%s" "$PIKIT_CONFORMANCE" > ../value.txt', { cwd: "sub", env: { PIKIT_CONFORMANCE: "given ✓" } });
        const sub = value(await env.canonicalPath("sub", ctx), "canonicalPath");

        same(value(await env.readTextFile("where.txt", ctx), "readTextFile").trim(), sub, "the working directory");
        same(value(await env.readTextFile("value.txt", ctx), "readTextFile"), "given ✓", "the variable");
      },
      "shell",
    ),

    executionCase(
      "with inheritEnv false, a command sees only the variables it is given",
      async (env) => {
        await exec(env, 'printf "%s|%s" "${HOME:-unset}" "$ONLY" > seen.txt', { inheritEnv: false, env: { ONLY: "this" } });

        same(value(await env.readTextFile("seen.txt", ctx), "readTextFile"), "unset|this", "what the command saw");
      },
      "shell",
    ),

    executionCase(
      "output past the spill thresholds is kept whole in spillPath, and still reaches onOutput",
      async (env) => {
        const run = await exec(env, "for i in 1 2 3 4 5 6 7 8 9 10; do echo line-$i; done", { spill: { afterBytes: 1_000_000, afterLines: 4 } });
        const expected = Array.from({ length: 10 }, (_, i) => `line-${i + 1}\n`).join("");

        same(run.output, expected, "the output");
        check(run.spillPath !== undefined, "a spill path");
        same(value(await env.readTextFile(run.spillPath as string, ctx), "readTextFile"), expected, "the spilled output");
        const bytes = await exec(env, "printf '%s' 0123456789abcdef", { spill: { afterBytes: 8, afterLines: 100 } });
        check(bytes.spillPath !== undefined, "a spill path past afterBytes");
        const within = await exec(env, "echo short", { spill: { afterBytes: 1_000, afterLines: 10 } });
        same(within.spillPath, undefined, "the spill path of an output within the thresholds");
      },
      "shell",
    ),

    executionCase(
      "an onOutput that throws fails the command with callback_error",
      async (env) => {
        const result = await env.exec(
          "echo hello",
          {
            onOutput: () => {
              throw new Error("conformance: the callback failed");
            },
          },
          ctx,
        );
        same(code(result), "callback_error", "the result");
      },
      "shell",
    ),

    executionCase(
      "a working directory that does not exist fails the command",
      async (env) => {
        const result = await env.exec("echo hello", { cwd: "no/such/dir" }, ctx);
        same(code(result), "spawn_error", "the result");
      },
      "shell",
    ),

    executionCase(
      "without a shell, exec answers shell_unavailable",
      async (env) => {
        same(code(await env.exec("echo hello", undefined, ctx)), "shell_unavailable", "the result");
      },
      "no shell",
    ),

    executionCase(
      "without watching, watch answers not_supported",
      async (env) => {
        same(code(await env.watch([{ path: "." }], () => {}, ctx)), "not_supported", "the result");
      },
      "no watch",
    ),
  ].filter((c): c is DurableExecutionCase => c !== undefined)];
}

/** Runs `command`, collecting its output from `onOutput`. Fails the case if exec fails. */
async function exec(env: ExecutionEnv, command: string, options: Omit<ShellExecOptions, "onOutput"> = {}) {
  let output = "";
  const result = await env.exec(command, { ...options, onOutput: (text) => void (output += text) }, ctx);
  if (!result.ok) throw new Error(`${GROUP}: exec("${command}") failed: ${result.error.code} ${result.error.message}`);
  return { exitCode: result.value.exitCode, output, spillPath: result.value.spillPath };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }, what: string): T {
  if (!result.ok) throw new Error(`${GROUP}: ${what} failed: ${result.error.code ?? ""} ${result.error.message}`);
  return result.value;
}

function code(result: { ok: true } | { ok: false; error: { code: string } }): string {
  return result.ok ? "ok" : result.error.code;
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${GROUP}: expected ${what}`);
}

/** What a tool call gave the model: its text (diagnostics after it), and whether it failed. */
export interface ToolCallOutcome {
  text: string;
  isError: boolean;
  diagnostics: ToolDiagnostic[];
  details: unknown;
}

export interface CallToolOptions {
  /** `api.env`: the call's environment. */
  env?: ExecutionEnv;
  /** The call's context (its cancellation). Default: never cancelled. */
  context?: Context;
}

/**
 * Calls `tool` once, as the Harness would but with no Harness: `args` unvalidated, the result's text
 * (or, when it returns no content, the output it streamed), and a throw as an error result with the
 * error's message. Diagnostics are listed, not appended to the text.
 */
export async function callTool(tool: ToolRegistration, args: unknown, options: CallToolOptions = {}): Promise<ToolCallOutcome> {
  let output = "";
  const diagnostics: ToolDiagnostic[] = [];
  let details: unknown;
  const api = {
    taskId: "task-1",
    conversationId: "conversation-1",
    callId: "call-1",
    env: options.env,
    output: (chunk: string | Uint8Array) => void (output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    diagnostic: (diagnostic: ToolDiagnostic) => void diagnostics.push(diagnostic),
    details: async (value: unknown) => void (details = value),
  } as unknown as ToolExecutionApi;
  try {
    const result = await tool.execute(args as never, api, options.context ?? ctx);
    const text = result.content === undefined ? output : result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return { text, isError: result.isError === true, diagnostics: [...diagnostics, ...(result.diagnostics ?? [])], details: result.details ?? details };
  } catch (error) {
    diagnostics.push({ severity: "error", code: "tool_error", message: error instanceof Error ? error.message : String(error) });
    return { text: output, isError: true, diagnostics, details };
  }
}

/** One call the faux model makes, in its own turn. */
export interface ScriptedCall {
  name: string;
  /** JSON arguments, as a model sends them. */
  args: ToolCall["arguments"];
}

/** A tool result as the transcript holds it. */
export interface RecordedResult {
  name: string;
  /** The result's text, with pi-durable's rendered diagnostics block after it when there were any. */
  text: string;
  isError: boolean;
}

export interface RunToolCallsOptions {
  /** The tools the conversation is offered, as one extension. */
  tools: readonly ToolRegistration[];
  /** The model's calls, one per turn, then its final answer. */
  calls: readonly ScriptedCall[];
  /** `HarnessOptions.env`. Default: none (the coding tools then fail). */
  env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
}

/**
 * A pi-durable `Harness` over memory storage whose faux model makes `calls`, one per turn, then
 * answers "Done.". Returns the tool results in the transcript, in call order. Throws when the input
 * is not answered.
 */
export async function runToolCalls(options: RunToolCallsOptions): Promise<RecordedResult[]> {
  const faux = fauxProvider();
  faux.setResponses([
    ...options.calls.map((call, index) => fauxAssistantMessage(fauxToolCall(call.name, call.args, { id: `call-${index + 1}` }), { stopReason: "toolUse" })),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "pikit-test-tools", tools: [...options.tools] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, ...(options.env !== undefined && { env: options.env }) }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const settled = await (await root.submit({ type: "input", content: "Use the tools." }, ctx)).wait(ctx);
    if (settled.status !== "done") throw new Error(`runToolCalls: the input was not answered: ${JSON.stringify(settled)}`);
    const page = await root.entries({}, 1000, undefined, ctx);
    const results: RecordedResult[] = [];
    for (const entry of [...page.items].reverse()) {
      const message = entry.model?.[0];
      if (entry.kind !== "pi.tool-result" || message?.role !== "toolResult") continue;
      results.push({
        name: message.toolName,
        text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        isError: message.isError,
      });
    }
    return results;
  } finally {
    await harness.close(ctx);
  }
}
