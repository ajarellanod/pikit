/**
 * The adapter's `agent.state`, a Pi session value, against the `agent.state` suite (SPEC §6.2a), on
 * Pi's in-memory repo and on JSONL files, where a new worker reads the state back from disk.
 */

import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo, MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT } from "@pikit/core";
import { type AgentStateFixture, createAgentStateConformance } from "@pikit/core/testing";
import { sessionState } from "./state.ts";
import type { SessionStore } from "./types.ts";

const ctx = BACKGROUND_CONTEXT;

/** One conversation over `repo`: reopening closes the session and opens it again from the repo. */
function fixture(repo: SessionStore, dispose?: () => Promise<void>): AgentStateFixture {
  let session: Session | undefined;
  let initial: Record<string, unknown> = {};
  const close = async () => void (await session?.close(ctx));
  return {
    async open(declared) {
      initial = declared;
      session = await repo.create({ cwd: "/" }, ctx);
      return sessionState(session, initial);
    },
    async reopen() {
      if (session === undefined) throw new Error("open() first");
      const metadata = session.metadata;
      await close();
      session = await repo.open(metadata, ctx);
      return sessionState(session, initial);
    },
    async reset() {
      await close();
      session = await repo.create({ cwd: "/" }, ctx);
      return sessionState(session, initial);
    },
    async dispose() {
      await close();
      await dispose?.();
    },
  };
}

for (const c of createAgentStateConformance(() => fixture(new MemorySessionRepo()))) {
  test(`memory sessions ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createAgentStateConformance(() => {
  const root = mkdtempSync(join(tmpdir(), "pikit-state-"));
  const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
  return fixture(repo, async () => rmSync(root, { recursive: true, force: true }));
})) {
  test(`jsonl sessions ${c.group}: ${c.name}`, () => c.run());
}
