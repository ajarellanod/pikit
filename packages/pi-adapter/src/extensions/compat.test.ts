/**
 * Scenario 7 (SPEC §15): existing Pi extensions run in pikit unmodified. The three extensions in
 * `pi-examples/` are Pi's own examples, byte for byte; they import `@earendil-works/pi-coding-agent`,
 * which resolves to `@pikit/pi-extension-shim`. The rest of the file checks the mapping of Pi's
 * extension events onto the harness (SPEC §6.2b).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentHarnessTool, BACKGROUND_CONTEXT, JsonlSessionRepo, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type Message, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentDefinition,
  type AppEvents,
  defineAgent,
  defineApp,
  defineComponent,
  type Logger,
  silentLogger,
} from "@pikit/core";
import { createPiRuntime, type ExtensionAPI, modelsFrom, type PiExtension, type SessionStore } from "../index.ts";
import { holdTool, killMidRun, scriptedAgent, scriptedProvider } from "../testing/index.ts";
import hello from "./pi-examples/hello.ts";
import permissionGate from "./pi-examples/permission-gate.ts";
import protectedPaths from "./pi-examples/protected-paths.ts";

const ctx = BACKGROUND_CONTEXT;
type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];
type ModelRequest = Parameters<FauxResponseFactory>[0];

function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * A model that calls tools on request: `bash: <command>`, `write: <path>`, `hello: <name>`. After a
 * tool it says `tool said: <result>`; otherwise `answer: <message>`.
 */
function toolCallingProvider(requests: ModelRequest[]) {
  const faux = fauxProvider({ provider: "compat", models: [{ id: "tools" }] });
  const step: FauxResponseFactory = (context) => {
    requests.push(structuredClone(context));
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage(`tool said: ${textOf(last)}`);
    const said = textOf(last);
    const [, tool, argument = ""] = /^(bash|write|hello): (.*)$/.exec(said) ?? [];
    if (tool === "bash") return fauxAssistantMessage(fauxToolCall("bash", { command: argument }), { stopReason: "toolUse" });
    if (tool === "write") {
      return fauxAssistantMessage(fauxToolCall("write", { path: argument, content: "x" }), { stopReason: "toolUse" });
    }
    if (tool === "hello") return fauxAssistantMessage(fauxToolCall("hello", { name: argument }), { stopReason: "toolUse" });
    return fauxAssistantMessage(`answer: ${said}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  return faux.provider;
}

const RECORDED = Type.Object({
  command: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
});

/** Stand-ins for Pi's `bash` and `write`: they record what they were asked to do. */
function recordingTool(name: "bash" | "write", ran: string[]): AgentHarnessTool<undefined, typeof RECORDED> {
  return {
    name,
    label: name,
    description: `Records ${name} calls`,
    parameters: RECORDED,
    async execute(_toolCallId, params) {
      ran.push(`${name}: ${params.command ?? params.path}`);
      return { content: [{ type: "text", text: "ran" }], details: undefined };
    },
  };
}

async function newSession(sessions: SessionStore): Promise<string> {
  const session = await sessions.create({ cwd: "/" }, ctx);
  await session.close(ctx);
  return session.metadata.id;
}

interface SetupOptions {
  logger?: Logger;
  systemPrompt?: string;
  /** Another store (JSONL, for a killed worker). Default: Pi's in-memory repo. */
  sessions?: SessionStore;
  /** Another agent. Default: `coder` on `faux/tools` with the recording `bash` and `write`. */
  agent?: AgentDefinition;
  /** An existing conversation's session; default: a new one. */
  sessionId?: string;
}

async function setup(extensions: PiExtension[], options: SetupOptions = {}) {
  const sessions = options.sessions ?? new MemorySessionRepo();
  const ran: string[] = [];
  const requests: ModelRequest[] = [];
  const results: Result[] = [];
  const waiters: (() => void)[] = [];
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const record = (result: Result) => {
        results.push(result);
        for (const wake of waiters.splice(0)) wake();
      };
      pikit.on("agent.settled", record);
      pikit.on("agent.failed", record);
    },
  });
  const app = await defineApp({ components: [observer], logger: options.logger ?? silentLogger }).create();
  const agent =
    options.agent ??
    defineAgent({
      name: "coder",
      model: "compat/tools",
      tools: [recordingTool("bash", ran), recordingTool("write", ran)],
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    });
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => (name === agent.name ? agent : undefined),
    models: modelsFrom([toolCallingProvider(requests), scriptedProvider()]),
    events: app.context(),
    extensions,
  });
  const sessionId = options.sessionId ?? (await newSession(sessions));
  const conversation = { key: "test:compat", agent: agent.name, sessionId };
  let next = 0;
  const result = async (requestId: string): Promise<Result> => {
    for (;;) {
      const found = results.find((result) => result.requestId === requestId);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const say = async (prompt: string): Promise<Result> => {
    const requestId = `r${++next}`;
    await runtime.dispatch({ requestId, conversation, prompt }, app.context());
    return result(requestId);
  };
  return {
    say,
    result,
    ran,
    requests,
    sessions,
    conversation,
    resume: () => runtime.resume(conversation, app.context()),
    close: () => runtime.close(app.context()),
  };
}

describe("scenario 7: Pi's own example extensions, unmodified", () => {
  test("permission-gate blocks a dangerous bash command, with no UI to ask", async () => {
    const s = await setup([permissionGate]);

    const blocked = await s.say("bash: rm -rf /");
    const allowed = await s.say("bash: ls");

    expect(blocked.text).toContain("Dangerous command blocked (no UI for confirmation)");
    expect(allowed.text).toBe("tool said: ran");
    expect(s.ran).toEqual(["bash: ls"]);
    await s.close();
  });

  test("protected-paths blocks a write to .env and lets others through", async () => {
    const s = await setup([protectedPaths]);

    const blocked = await s.say("write: .env");
    await s.say("write: notes.md");

    expect(blocked.text).toContain('Path ".env" is protected');
    expect(s.ran).toEqual(["write: notes.md"]);
    await s.close();
  });

  test("hello registers a tool with defineTool, and the agent calls it", async () => {
    const s = await setup([hello]);

    const greeted = await s.say("hello: Alex");

    expect(greeted.text).toBe("tool said: Hello, Alex!");
    await s.close();
  });

  test("several extensions work together", async () => {
    const s = await setup([permissionGate, protectedPaths, hello]);

    expect((await s.say("bash: sudo reboot")).text).toContain("Dangerous command blocked");
    expect((await s.say("write: .git/config")).text).toContain("is protected");
    expect((await s.say("hello: Pi")).text).toBe("tool said: Hello, Pi!");
    expect(s.ran).toEqual([]);
    await s.close();
  });
});

describe("the mapping of Pi's extension events (SPEC §6.2b)", () => {
  test("a conversation sees session, run, turn and tool events in Pi's order", async () => {
    const seen: string[] = [];
    const recorder: PiExtension = (pi: ExtensionAPI) => {
      for (const event of [
        "session_start",
        "agent_start",
        "turn_start",
        "tool_call",
        "tool_execution_start",
        "tool_execution_end",
        "tool_result",
        "turn_end",
        "agent_end",
        "session_shutdown",
      ]) {
        pi.on(event, () => void seen.push(event));
      }
    };
    const s = await setup([recorder]);

    await s.say("bash: ls");
    await s.close();

    expect(seen).toEqual([
      "session_start",
      "agent_start",
      "turn_start",
      "tool_call",
      "tool_execution_start",
      "tool_result",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "turn_end",
      "agent_end",
      "session_shutdown",
    ]);
  });

  test("tool_call can patch arguments in place, and tool_result can rewrite the result", async () => {
    const patcher: PiExtension = (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "bash") event.input.command = "echo patched";
      });
      pi.on("tool_result", () => ({ content: [{ type: "text", text: "rewritten" }] }));
    };
    const s = await setup([patcher]);

    const result = await s.say("bash: ls");

    expect(s.ran).toEqual(["bash: echo patched"]);
    expect(result.text).toBe("tool said: rewritten");
    await s.close();
  });

  test("before_agent_start replaces the system prompt; context rewrites what the model sees", async () => {
    const prompter: PiExtension = (pi) => {
      pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt} Be terse.` }));
      pi.on("context", (event) => ({ messages: event.messages.slice(-1) }));
    };
    const s = await setup([prompter], { systemPrompt: "You help." });

    await s.say("first");
    await s.say("second");

    // The provider receives the system prompt as its first message, then the conversation.
    const [system, ...conversation] = s.requests.at(-1)?.messages ?? [];
    expect(system).toMatchObject({ role: "system", content: "You help. Be terse." });
    expect(conversation.map(textOf)).toEqual(["second"]);
    await s.close();
  });

  test("what pikit does not provide is a no-op with a warning, not a crash", async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (_message, fields) => void warnings.push(String(fields?.what)) };
    const tui: PiExtension = (pi) => {
      pi.registerCommand("deploy", { handler: async () => {} });
      pi.on("input", () => undefined);
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.setStatus("tui", "ready");
        ctx.ui.notify("hello", "info");
      });
    };
    const s = await setup([tui], { logger });

    expect((await s.say("hi")).text).toBe("answer: hi");
    expect(warnings).toEqual(['pi.registerCommand("deploy")', 'pi.on("input")']);
    await s.close();
  });

  test("actions are not available while an extension loads", async () => {
    let failure: unknown;
    const eager: PiExtension = (pi) => {
      try {
        pi.setActiveTools([]);
      } catch (error) {
        failure = error;
      }
    };
    const s = await setup([eager]);

    await s.say("hi");

    expect(String(failure)).toContain("not available while an extension loads");
    await s.close();
  });
});

describe("taking a conversation up again, with extensions loaded (SPEC §6.2b)", () => {
  /** An extension that records every event it sees, in order. */
  function recorder(seen: string[]): PiExtension {
    return (pi) => {
      for (const event of [
        "session_start",
        "agent_start",
        "tool_call",
        "tool_execution_start",
        "tool_execution_end",
        "tool_result",
        "agent_end",
        "session_shutdown",
      ]) {
        pi.on(event, () => void seen.push(event));
      }
    };
  }

  test("reopened after idle: extensions load again, their tools stay active, their handlers act", async () => {
    const seen: string[] = [];
    const s = await setup([recorder(seen), permissionGate, hello]);

    expect((await s.say("hello: A")).text).toBe("tool said: Hello, A!");
    // Idle in between: the conversation closed and opens again for each message.
    expect((await s.say("bash: rm -rf /")).text).toContain("Dangerous command blocked");
    expect((await s.say("hello: B")).text).toBe("tool said: Hello, B!");
    await s.close();

    expect(seen.filter((event) => event === "session_start")).toHaveLength(3);
    expect(seen.filter((event) => event === "session_shutdown")).toHaveLength(3);
    expect(s.ran).toEqual([]);
  });

  describe("resumed after a crash", () => {
    /** A conversation whose worker was killed inside `hold`, resumed here with `extensions`. */
    async function resumeKilled(replay: "safe" | "never", extensions: PiExtension[]) {
      const root = mkdtempSync(join(tmpdir(), "pikit-compat-"));
      const sessions = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
      const sessionId = await newSession(sessions);
      await killMidRun(root, sessionId, "r-killed", replay);
      let runs = 0;
      const agent = scriptedAgent(holdTool(async () => `ran ${++runs}`, replay));
      const s = await setup(extensions, { sessions, agent, sessionId });

      await s.resume();
      const result = await s.result("r-killed");
      await s.close();
      rmSync(root, { recursive: true, force: true });
      return { result, runs: () => runs };
    }

    test("replay: safe — the extensions see the resumed run and the replayed tool's result", async () => {
      const seen: string[] = [];

      const { result, runs } = await resumeKilled("safe", [recorder(seen)]);

      expect(result.kind).toBe("completed");
      expect(runs()).toBe(1);
      expect(seen).toEqual([
        "session_start",
        "agent_start",
        "tool_execution_start",
        "tool_result",
        "tool_execution_end",
        "agent_end",
        "session_shutdown",
      ]);
    }, 20_000);

    test("replay: never — the tool is not run again; the extensions see it end, with no result to rewrite", async () => {
      const seen: string[] = [];

      const { result, runs } = await resumeKilled("never", [recorder(seen)]);

      expect(result.kind).toBe("completed");
      expect(runs()).toBe(0);
      expect(seen).toEqual(["session_start", "agent_start", "tool_execution_end", "agent_end", "session_shutdown"]);
    }, 20_000);

    test("the interrupted call is not put to tool_call again: it was decided before the crash (Pi)", async () => {
      const blocker: PiExtension = (pi) => void pi.on("tool_call", () => ({ block: true, reason: "blocked" }));

      const { runs } = await resumeKilled("safe", [blocker]);

      // Pi records the intent of a call after its before_tool check and replays that decision.
      // In a real deployment the same extensions ran before the crash, so the call was checked.
      expect(runs()).toBe(1);
    }, 20_000);
  });

  test("reopening keeps the provider's prompt cache: same system prompt, same tools, same prefix", async () => {
    const terse: PiExtension = (pi) => void pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt} Be terse.` }));
    const s = await setup([hello, permissionGate, terse], { systemPrompt: "You help." });

    await s.say("first");
    const second = await s.say("second");
    await s.close();

    const [before, after] = s.requests;
    if (before === undefined || after === undefined) throw new Error("expected two model requests");
    const { messages: beforeMessages, ...beforeRest } = before;
    const { messages: afterMessages, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    expect(afterMessages.slice(0, beforeMessages.length)).toEqual(beforeMessages);
    // The extension's tool is offered in both, in the same place.
    expect(JSON.stringify(beforeMessages[0])).toContain('"name":"hello"');
    const answer = second.messages.find((message) => message.role === "assistant");
    if (answer?.role !== "assistant") throw new Error("expected an answer");
    expect(answer.usage.cacheRead).toBeGreaterThan(0);
  });

  test("an extension's closure starts over on each reopen; what it appends to the session stays", async () => {
    const counted: number[] = [];
    const counter: PiExtension = (pi) => {
      let runs = 0;
      // Slow on purpose, like a handler that does I/O first: the conversation must not close
      // under it, or the entry is lost.
      pi.on("agent_end", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        runs++;
        counted.push(runs);
        pi.appendEntry("counter", { runs });
      });
    };
    const s = await setup([counter]);

    await s.say("one");
    await s.say("two");
    await s.close();

    // Loaded again for the second message, as Pi loads extensions per session.
    expect(counted).toEqual([1, 1]);
    const metadata = (await s.sessions.list(undefined, ctx)).find((m: { id: string }) => m.id === s.conversation.sessionId);
    const session = await s.sessions.open(metadata, ctx);
    const entries = await session.findEntries({ type: "custom", customType: "counter", order: "asc" }, ctx);
    await session.close(ctx);
    expect(entries.map((entry) => (entry.type === "custom" ? entry.data : undefined))).toEqual([{ runs: 1 }, { runs: 1 }]);
  });
});
