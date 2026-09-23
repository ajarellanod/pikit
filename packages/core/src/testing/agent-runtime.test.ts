/**
 * The `agent.runtime` suite run against an in-memory double (S12: a contract is proven by an
 * implementation plus a double passing the same suite). The double follows the suite's script
 * with a plain transcript and inbox; it exists only to show that the suite asks nothing Pi-specific.
 * It is not an agent runtime: pikit's only runtime is Pi, through the adapter.
 */

import { test } from "bun:test";
import { defineComponent, type AppContext } from "../app.ts";
import type { Admission, AgentRuntime, ConversationRef } from "../agent.ts";
import { BACKGROUND_CONTEXT } from "../context.ts";
import { type AgentRuntimeFixture, createAgentRuntimeConformance } from "./agent-runtime.ts";

interface Entry {
  kind: "in" | "tool" | "out";
  text: string;
  requestId?: string;
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
  hold(signal: AbortSignal): Promise<void>;
  atEnd(): Promise<void>;
}

function memoryRuntime(records: Map<string, Conversation>, script: Script) {
  return defineComponent({
    name: "runtime-memory",
    setup(pikit) {
      let background: AppContext | undefined;
      /** Runs this worker drives, by session. */
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
        const run = async (): Promise<{ kind: "completed" | "aborted"; text?: string }> => {
          if (entry !== undefined) record.transcript.push({ kind: "tool", text: entry.text });
          for (;;) {
            record.transcript.push(...record.inbox.splice(0));
            const last = record.transcript.at(-1);
            if (last?.kind === "in" && last.text === "hold") {
              try {
                await script.hold(controller.signal);
              } catch {
                return { kind: "aborted" };
              }
              record.transcript.push({ kind: "tool", text: "held" });
              continue;
            }
            const newest = [...record.transcript].reverse().find((e) => e.kind === "in");
            const text = `answer: ${newest?.text}`;
            record.transcript.push({ kind: "out", text });
            if (record.inbox.length > 0) continue;
            await script.atEnd();
            if (record.inbox.length > 0) continue;
            // The run ends in the same step that found the inbox empty: a message admitted as
            // queued is always taken by this run (the double's version of SPEC §6.4, gap 2).
            end();
            return { kind: "completed", text };
          }
        };
        const end = () => {
          delete record.open;
          live.delete(ref.sessionId);
        };
        const done = run().then(async (result) => {
          end();
          const ctx = background ?? notStarted();
          await ctx.emit("agent.settled", { conversation: ref, requestId, messages: [], ...result });
        });
        live.set(ref.sessionId, { controller, done });
      };

      /** Opening a conversation resumes the run a dead worker left open. */
      const open = async (ref: ConversationRef): Promise<Conversation> => {
        const record = records.get(ref.sessionId);
        if (record === undefined) throw new Error(`no session ${ref.sessionId}`);
        if (record.open !== undefined && !live.has(ref.sessionId)) {
          const { requestId } = record.open;
          await background?.emit("agent.started", { conversation: ref, requestId, resumed: true });
          drive(ref, record, requestId, { kind: "tool", text: "interrupted" });
        }
        return record;
      };

      const runtime: AgentRuntime = {
        dispatch: (request, ctx) =>
          serial(async () => {
            const { requestId, conversation } = request;
            const record = await open(conversation);
            const seen = [...record.transcript, ...record.inbox].some((e) => e.requestId === requestId);
            let admission: Admission;
            if (seen || record.withdrawn.has(requestId)) {
              admission = { kind: "duplicate", requestId };
            } else {
              record.inbox.push({ kind: "in", text: request.prompt, requestId });
              if (live.has(conversation.sessionId)) {
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
            const run = live.get(conversation.sessionId);
            if (run === undefined) return;
            for (const e of record.inbox.splice(0)) if (e.requestId !== undefined) record.withdrawn.add(e.requestId);
            run.controller.abort(new Error("aborted"));
            await run.done;
          }),
        resume: (conversation) => serial(async () => void (await open(conversation))),
      };
      pikit.provide("agent.runtime", runtime);
      return {
        start(ctx) {
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

function memoryFixture(): AgentRuntimeFixture {
  const records = new Map<string, Conversation>();
  let next = 0;
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holdStarted = new Promise<void>((resolve) => (started = resolve));
  let end: { reach(): void; released: Promise<void> } | undefined;

  const script: Script = {
    hold(signal) {
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
    const sessionId = `s${++next}`;
    records.set(sessionId, { transcript: [], inbox: [], withdrawn: new Set() });
    return { key: `test:memory:${sessionId}`, agent: "scripted", sessionId };
  };

  return {
    components: [memoryRuntime(records, script)],
    conversation: async () => conversation(),
    hold: { started: holdStarted, release: () => release() },
    holdAtEnd() {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      end = { reach, released: new Promise<void>((resolve) => (resume = resolve)) };
      return { reached, release: () => resume() };
    },
    async interrupted() {
      const ref = conversation();
      const record = records.get(ref.sessionId);
      // What a worker that died inside the hold tool leaves behind: the request in the transcript
      // and an open run nobody drives.
      record?.transcript.push({ kind: "in", text: "hold", requestId: "r-crashed" });
      if (record !== undefined) record.open = { requestId: "r-crashed" };
      return { conversation: ref, requestId: "r-crashed" };
    },
  };
}

for (const c of createAgentRuntimeConformance(memoryFixture)) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
