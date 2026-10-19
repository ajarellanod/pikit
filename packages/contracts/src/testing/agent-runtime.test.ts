/**
 * The `agent.runtime` suite run against an in-memory double (a contract is proven by an
 * implementation plus a double passing the same suite). The double follows the suite's script
 * with a plain transcript and inbox; it exists only to show that the suite asks nothing Pi-specific.
 * It is not an agent runtime: pikit's only runtime is Pi (pi-durable), through the adapter. Like
 * pi-durable with follow-ups taken all at once, a run takes the whole inbox when it starts, and what is
 * queued while it goes waits for the next run; steers queued while it goes join it after its tool round.
 */

import { expect, test } from "bun:test";
import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { type Admission, type AgentRuntime, type ConversationRef, type Sender, stewardProblem } from "../agent.ts";
import { type MessagePart, partProblem } from "../parts.ts";
import type { RunRequest } from "../run-requests.ts";
import { type AgentRuntimeFixture, createAgentRuntimeConformance } from "./agent-runtime.ts";

interface Entry {
  kind: "in" | "tool" | "out";
  text: string;
  requestId?: string;
  sender?: Sender;
  parts?: MessagePart[];
  /** A steer, waiting in the inbox for the run's tool round. */
  steer?: boolean;
}

/** The durable records of one conversation, shared by every worker of a fixture. */
interface Conversation {
  transcript: Entry[];
  inbox: Entry[];
  withdrawn: Set<string>;
  /** The run the records say is open, whether or not a worker drives it. */
  open?: { requestId: string };
}

interface Script {
  /** The tool: `requests` are the run's, as `RUN_REQUESTS` would list them; `conversation`, as `CONVERSATION` would give it. */
  hold(signal: AbortSignal, requests: readonly RunRequest[], conversation: ConversationRef): Promise<void>;
  atEnd(): Promise<void>;
  /** Before each answer: rejects when the model call fails. */
  answer(): Promise<void>;
}

/** What a broken double loses or lets through, to see the suite catch it. */
type Broken = { dropSenders?: boolean; dropParts?: boolean; uncheckedParts?: boolean; takeOrigin?: boolean };

/** `broken`: a runtime that loses what the suite checks (a sender, parts) or lets in what it refuses, to see the suite catch it. */
function memoryRuntime(records: Map<string, Conversation>, script: Script, broken: Broken = {}) {
  return defineComponent({
    name: "runtime-memory",
    setup(pikit) {
      let background: AppContext | undefined;
      /** Runs this worker drives, by conversation id. */
      const live = new Map<string, { controller: AbortController; done: Promise<void> }>();
      let line: Promise<unknown> = Promise.resolve();
      const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const next = line.then(work);
        line = next.catch(() => {});
        return next;
      };

      const drive = (ref: ConversationRef, record: Conversation, requestId: string, entry?: Entry): void => {
        const controller = new AbortController();
        record.open = { requestId };
        /** The requests this run took: its starter, then what was queued with it. */
        const taken = [requestId];
        // A new run takes everything queued; a resumed one takes nothing more.
        if (entry === undefined) {
          for (const e of record.inbox.splice(0)) {
            record.transcript.push(e);
            if (e.requestId !== undefined && !taken.includes(e.requestId)) taken.push(e.requestId);
          }
        }
        const run = async (): Promise<
          { kind: "completed" | "aborted"; text?: string } | { kind: "failed"; error: { code: string; message: string } }
        > => {
          if (entry !== undefined) record.transcript.push({ kind: "tool", text: entry.text });
          for (;;) {
            const last = record.transcript.at(-1);
            if (last?.kind === "in" && last.text === "hold") {
              const requests = taken.map((id): RunRequest => {
                const sender = record.transcript.find((e) => e.requestId === id)?.sender;
                return { requestId: id, ...(sender !== undefined && broken.dropSenders !== true && { sender }) };
              });
              try {
                await script.hold(controller.signal, requests, ref);
              } catch {
                return { kind: "aborted" };
              }
              record.transcript.push({ kind: "tool", text: "held" });
              // After the tool round: the steers queued meanwhile join this run.
              for (const steer of record.inbox.filter((e) => e.steer === true)) {
                record.inbox.splice(record.inbox.indexOf(steer), 1);
                record.transcript.push(steer);
                if (steer.requestId !== undefined) taken.push(steer.requestId);
              }
              continue;
            }
            try {
              await script.answer();
            } catch (error) {
              // The inbox stays as it is: what was queued is not taken by a run that failed.
              end();
              return { kind: "failed", error: { code: "provider", message: String(error) } };
            }
            const newest = [...record.transcript].reverse().find((e) => e.kind === "in");
            const text = `answer: ${newest?.text}`;
            record.transcript.push({ kind: "out", text });
            await script.atEnd();
            // What was queued meanwhile waits for the next run.
            end();
            return { kind: "completed", text };
          }
        };
        const end = () => {
          delete record.open;
          live.delete(ref.conversationId);
        };
        const done = run().then(async (result) => {
          end();
          const ctx = background ?? notStarted();
          // The parts of the messages it took, in the order it took them.
          const parts = taken.flatMap((id) => record.transcript.find((e) => e.requestId === id)?.parts ?? []);
          const base = { conversation: ref, requestId, requestIds: taken, messages: [], ...(parts.length > 0 && broken.dropParts !== true && { parts }) };
          if (result.kind === "failed") await ctx.emit("agent.failed", { ...base, ...result });
          else await ctx.emit("agent.settled", { ...base, ...result });
          // What was queued while the run went gets the next run, named after the oldest message. Not
          // awaited: `abort()` waits for `done` in the line.
          void serial(async () => {
            const next = record.inbox.find((e) => e.requestId !== undefined)?.requestId;
            if (next === undefined || live.has(ref.conversationId)) return;
            drive(ref, record, next);
            await background?.emit("agent.started", { conversation: ref, requestId: next, resumed: false });
          });
        });
        live.set(ref.conversationId, { controller, done });
      };

      /** Opening a conversation resumes the run a dead worker left open. */
      const open = async (ref: ConversationRef): Promise<Conversation> => {
        const record = records.get(ref.conversationId);
        if (record === undefined) throw new Error(`no conversation ${ref.conversationId}`);
        if (record.open !== undefined && !live.has(ref.conversationId)) {
          const { requestId } = record.open;
          await background?.emit("agent.started", { conversation: ref, requestId, resumed: true });
          drive(ref, record, requestId, { kind: "tool", text: "interrupted" });
        }
        return record;
      };

      const runtime: AgentRuntime = {
        dispatch: (request, ctx) =>
          serial(async () => {
            const { requestId } = request;
            // The origin is the runtime's to record: a ref's is ignored.
            const { origin: _given, ...own } = request.conversation;
            const conversation: ConversationRef = broken.takeOrigin === true ? request.conversation : own;
            const parts = request.parts ?? [];
            const problem = parts.map((each) => partProblem(each)).find((found) => found !== undefined);
            if (problem !== undefined && broken.uncheckedParts !== true) throw new TypeError(`dispatch(${requestId}): a part ${problem}`);
            const record = await open(conversation);
            const seen = [...record.transcript, ...record.inbox].some((e) => e.requestId === requestId);
            let admission: Admission;
            if (seen || record.withdrawn.has(requestId)) {
              admission = { kind: "duplicate", requestId };
            } else {
              record.inbox.push({
                kind: "in",
                text: request.prompt,
                requestId,
                ...(request.sender !== undefined && { sender: { ...request.sender } }),
                ...(parts.length > 0 && { parts: structuredClone([...parts]) }),
                ...(request.whenBusy === "steer" && { steer: true }),
              });
              if (live.has(conversation.conversationId)) {
                admission = { kind: "queued", requestId };
              } else {
                admission = { kind: "started", requestId };
                drive(conversation, record, requestId);
                await background?.emit("agent.started", { conversation, requestId, resumed: false });
              }
            }
            await ctx.emit("agent.dispatched", { conversation, admission });
            return admission;
          }),
        abort: (conversation) =>
          serial(async () => {
            const record = await open(conversation);
            const run = live.get(conversation.conversationId);
            if (run === undefined) return;
            for (const e of record.inbox.splice(0)) if (e.requestId !== undefined) record.withdrawn.add(e.requestId);
            run.controller.abort(new Error("aborted"));
            await run.done;
          }),
        resume: (conversation) => serial(async () => void (await open(conversation))),
      };
      pikit.provide("agent.runtime", runtime);
      // Its one agent is the script; the definitions are read only for what a runtime refuses at start.
      const agents = pikit.useKeyed("agent.definition");
      return {
        start(ctx) {
          const stewards = stewardProblem(agents.keys().flatMap((name) => agents.get(name) ?? []));
          if (stewards !== undefined) throw new Error(`runtime-memory: ${stewards}`);
          background = ctx.derive(() => BACKGROUND_CONTEXT);
        },
        async stop() {
          for (const run of live.values()) run.controller.abort(new Error("worker stopped"));
        },
      };
    },
  });
}

function notStarted(): never {
  throw new Error("runtime-memory: a run ended before start()");
}

function memoryFixture(broken: Broken = {}): AgentRuntimeFixture {
  const records = new Map<string, Conversation>();
  let next = 0;
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holdStarted = new Promise<void>((resolve) => (started = resolve));
  let end: { reach(): void; released: Promise<void> } | undefined;
  let failing: { reach(): void; released: Promise<void> } | undefined;
  let requests: readonly RunRequest[] | undefined;
  let seen: ConversationRef | undefined;

  const script: Script = {
    async answer() {
      const armed = failing;
      failing = undefined;
      if (armed === undefined) return;
      armed.reach();
      await armed.released;
      throw new Error("scripted failure");
    },
    hold(signal, taken, conversation) {
      requests = taken;
      seen = conversation;
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void released.then(resolve);
      });
    },
    async atEnd() {
      const paused = end;
      end = undefined;
      if (paused === undefined) return;
      paused.reach();
      await paused.released;
    },
  };
  const conversation = (): ConversationRef => {
    const conversationId = `s${++next}`;
    records.set(conversationId, { transcript: [], inbox: [], withdrawn: new Set() });
    return { key: `test:memory:${conversationId}`, agent: "scripted", conversationId };
  };

  return {
    components: [memoryRuntime(records, script, broken)],
    model: "memory/scripted",
    conversation: async () => conversation(),
    hold: { started: holdStarted, release: () => release(), requests: () => requests, conversation: () => seen },
    holdAtEnd() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      end = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    failNext() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      failing = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    async interrupted() {
      const ref = conversation();
      const record = records.get(ref.conversationId);
      // What a worker that died inside the hold tool leaves behind: the request in the transcript
      // and an open run nobody drives.
      record?.transcript.push({ kind: "in", text: "hold", requestId: "r-crashed" });
      if (record !== undefined) record.open = { requestId: "r-crashed" };
      return { conversation: ref, requestId: "r-crashed" };
    },
  };
}

for (const c of createAgentRuntimeConformance(() => memoryFixture())) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

test("a runtime that loses a message's sender fails the sender cases", async () => {
  const cases = createAgentRuntimeConformance(() => memoryFixture({ dropSenders: true })).filter((c) => /sender|requests/.test(c.name));
  expect(cases.length).toBeGreaterThanOrEqual(3);
  for (const c of cases) await expect(c.run()).rejects.toThrow("the requests");
});

test("a runtime that loses a message's parts fails the parts cases", async () => {
  const cases = createAgentRuntimeConformance(() => memoryFixture({ dropParts: true })).filter((c) => /parts/.test(c.name) && !/refused/.test(c.name));
  expect(cases.length).toBeGreaterThanOrEqual(3);
  for (const c of cases) await expect(c.run()).rejects.toThrow(/agent\.runtime: .*(result|parts|the run it joined)/);
});

test("a runtime that admits what is no part fails the refusal case", async () => {
  const [refusal] = createAgentRuntimeConformance(() => memoryFixture({ uncheckedParts: true })).filter((c) => /is no part is refused/.test(c.name));
  await expect(refusal?.run()).rejects.toThrow("was admitted; a runtime refuses it");
});

test("a runtime that takes a ref's origin from dispatch fails the origin case", async () => {
  const [origin] = createAgentRuntimeConformance(() => memoryFixture({ takeOrigin: true })).filter((c) => /origin/.test(c.name));
  await expect(origin?.run()).rejects.toThrow("the conversation its tool read");
});
