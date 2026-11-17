/**
 * `projects` as every App gives it (`projectsOver`): each method one `actor.mailbox.call`, to the
 * directory (`projects:index`: `create`, `list`, `locate`) or to the project's actor
 * (`projects:space:<space>`: the rest), whose handlers projects-sql's default export registers. The
 * same in a server's App (every key is the App), a Durable Object's and the Worker's (`worker.ts`).
 *
 * A refusal crosses as an `ActorCallError` with the store's code, and is thrown again here as the
 * `ProjectError` it was; any other (`unreachable`, `failed`) is thrown as it came. `locate`'s answers
 * are kept: a project's space never changes.
 */

import type { AppContext } from "@pikit/core";
import { ActorCallError, type ActorMailbox, type Caller, type JsonValue, type Project, ProjectError, type ProjectErrorCode, type ProjectStore } from "@pikit/contracts";
import { INDEX_KEY } from "./directory.ts";
import { projectKey } from "./project.ts";

/** The calls projects-sql's actors answer. */
export const CALL = {
  create: "projects-sql.create",
  list: "projects-sql.list",
  locate: "projects-sql.locate",
  indexed: "projects-sql.indexed",
  unindexed: "projects-sql.unindexed",
  /** Every call of one project: `{ space, op, caller, ... }`. */
  project: "projects-sql.project",
} as const;

const CODES: ReadonlySet<string> = new Set<ProjectErrorCode>(["not_found", "forbidden", "conflict", "gone", "space_taken", "limit", "refused", "invalid"]);
/** How many `locate` answers a store keeps. */
const LOCATED_MAX = 2_000;

/** `value` as the JSON a call carries (absent fields dropped). */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

/** A refusal the store made, thrown again as its `ProjectError`. */
export function projectErrorOf(error: unknown): unknown {
  return error instanceof ActorCallError && CODES.has(error.code) ? new ProjectError(error.code as ProjectErrorCode, error.message) : error;
}

export function projectsOver(mailbox: () => ActorMailbox): ProjectStore {
  const located = new Map<string, string>();
  const ask = async <T>(key: string, type: string, message: unknown, ctx: AppContext): Promise<T> => {
    try {
      return (await mailbox().call(key, type, json(message), ctx)) as T;
    } catch (error) {
      throw projectErrorOf(error);
    }
  };
  /** One call of `space`'s project; `null` answers become `undefined`. */
  const project = async <T>(space: string, op: string, caller: Caller | undefined, args: Record<string, unknown>, ctx: AppContext): Promise<T> =>
    ((await ask<T | null>(projectKey(space), CALL.project, { space, op, ...(caller !== undefined && { caller }), ...args }, ctx)) ?? undefined) as T;

  return {
    create: (input, caller, ctx) => ask<Project>(INDEX_KEY, CALL.create, { caller, input }, ctx),
    list: (query, caller, ctx) => ask(INDEX_KEY, CALL.list, { caller, query }, ctx),
    async locate(id, ctx) {
      const known = located.get(id);
      if (known !== undefined) return known;
      const space = (await ask<string | null>(INDEX_KEY, CALL.locate, { id }, ctx)) ?? undefined;
      if (space !== undefined) {
        if (located.size >= LOCATED_MAX) located.clear();
        located.set(id, space);
      }
      return space;
    },
    get: (space, caller, ctx) => project(space, "get", caller, {}, ctx),
    roleOf: (space, principals, ctx) => project(space, "roleOf", undefined, { principals }, ctx),
    update: (space, change, caller, ctx) => project(space, "update", caller, { change }, ctx),
    members: (space, page, caller, ctx) => project(space, "members", caller, { page }, ctx),
    addMember: (space, principal, caller, ctx) => project(space, "addMember", caller, { principal }, ctx),
    removeMember: (space, principal, caller, ctx) => project(space, "removeMember", caller, { principal }, ctx),
    transferOwnership: (space, principal, caller, ctx) => project(space, "transferOwnership", caller, { principal }, ctx),
    syncMembers: async (space, sync, caller, ctx) => void (await project(space, "syncMembers", caller, { sync }, ctx)),
    instructions: (space, query, caller, ctx) => project(space, "instructions", caller, { query }, ctx),
    setInstructions: (space, input, caller, ctx) => project(space, "setInstructions", caller, { input }, ctx),
    documents: (space, caller, ctx) => project(space, "documents", caller, {}, ctx),
    putDocument: (space, input, caller, ctx) => project(space, "putDocument", caller, { input }, ctx),
    removeDocument: (space, id, caller, ctx) => project(space, "removeDocument", caller, { id }, ctx),
    read: (space, id, query, caller, ctx) => project(space, "read", caller, { id, query }, ctx),
    versions: (space, item, caller, ctx) => project(space, "versions", caller, { item }, ctx),
    search: (space, query, limit, caller, ctx) => project(space, "search", caller, { query, limit }, ctx),
    links: (space, caller, ctx) => project(space, "links", caller, {}, ctx),
    addLink: (space, link, caller, ctx) => project(space, "addLink", caller, { link }, ctx),
    removeLink: (space, id, caller, ctx) => project(space, "removeLink", caller, { id }, ctx),
    context: (space, known, caller, ctx) => project(space, "context", caller, { known: known ?? null }, ctx),
    changes: (space, page, caller, ctx) => project(space, "changes", caller, { page }, ctx),
    restore: (space, n, caller, ctx) => project(space, "restore", caller, { n }, ctx),
    redact: async (space, n, caller, ctx) => void (await project(space, "redact", caller, { n }, ctx)),
    remove: async (space, caller, ctx) => void (await project(space, "remove", caller, {}, ctx)),
    recover: (space, caller, ctx) => project(space, "recover", caller, {}, ctx),
  };
}
