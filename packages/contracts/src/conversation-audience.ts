/**
 * `conversation.audience`: who belongs to which space, for `conversations.directory`'s people viewers
 * (features/conversation-directory.md). A **pipeline**, not a capability: each membership provider adds
 * a stage that appends the grants it knows of for a person, as each channel's stage of
 * `conversation.describe` describes only its own keys:
 *
 *   pikit.pipeline("conversation.audience", audienceStage("projects", {
 *     async grants(principals, space, ctx) {
 *       // space given: check that one now (`roleOf`); absent: every project of these principals, for a list
 *       return (await projectsOf(principals, space, ctx)).map((p) => ({ space: p.space, role: p.role }));
 *     },
 *   }), { id: "projects-sql" });
 *
 * - **Why a pipeline:** a keyed capability would make the directory depend on every membership provider,
 *   and a provider may itself use the directory (a channel's index of a platform's members whose channel
 *   writes titles to the directory): a start-order cycle. A pipeline orders nobody and needs no provider.
 * - **Value** `{ principals, space?, grants }`: the principals of one person (a people `Viewer`'s), and,
 *   when `space` is given, the one space to check now (a provider's fresh bound: before opening a
 *   conversation or acting on it); absent, every space they belong to, for a list (a provider's list
 *   bound: rooms 30 minutes, projects now).
 * - **Fail closed.** A pipeline tolerates a broken stage; authorization must not. So a provider's stage is
 *   `audienceStage(source, provider)`: it appends only grants of its own `source` (a grant of another
 *   source, a malformed one, or, when `space` is given, one of another space is dropped, logged), never
 *   removes or changes an earlier stage's, and a provider that throws appends none (logged). The runner
 *   reads it only through `audienceGrants(ctx, principals, space?)`: a stage that halts or a pipeline
 *   that throws gives no grants (logged); duplicates are dropped; past `AUDIENCE_MAX` grants it rejects
 *   with `DirectoryError` `limit` (logged), never a silent cut.
 * - **What a grant says**: the space, the role there (`owner` of a project, `member`), and the source.
 *   A grant names a space as the conversations record it (`ConversationRef.space`): a project's
 *   `project:<id>`, a Google Chat space `googlechat:spaces/AAA`. A project is made from scratch, never
 *   adopted (the operator's decision of 2026-11-19), so a project's grant never names another channel's
 *   space: a Google Chat conversation is seen only through its platform's membership.
 *
 * Stages: projects-sql (its projects' spaces, `owner` for a project's owner). Downstream: neural-agents'
 * rooms (a person's verified Google Chat spaces). Runner: conversations-directory. Suite:
 * `createConversationAudienceConformance` (`@pikit/contracts/testing`).
 */

import { type AppContext, Halt } from "@pikit/core";
import type { Principal } from "./change.ts";
import { AUDIENCE_MAX, DirectoryError } from "./conversation-directory.ts";

/** One space a person belongs to, as one membership provider (`source`) says. */
export type AudienceGrant = { space: string; role: "member" | "owner"; source: string };

/** The value of `conversation.audience`. */
export type Audience = {
  /** One person's principals (a people viewer's). */
  principals: readonly Principal[];
  /** Given: check this one space now (the fresh bound). Absent: every space, for a list (the list bound). */
  space?: string;
  grants: AudienceGrant[];
};

/** A membership provider: its stage of `conversation.audience` is `audienceStage(source, provider)`. */
export interface AudienceProvider {
  /** The spaces `principals` belong to by this provider (only `space` when given), each with the role; `[]` for none. */
  grants(principals: readonly Principal[], space: string | undefined, ctx: AppContext): Promise<readonly { space: string; role: "member" | "owner" }[]>;
}

/** The longest space a grant names, in characters. */
const SPACE_MAX = 1024;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A grant as a provider answered it, checked: a non-empty space of at most `SPACE_MAX`, a role; `undefined` otherwise. */
function cleanGrant(value: unknown, source: string): AudienceGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { space, role } = value as Record<string, unknown>;
  if (typeof space !== "string" || space.trim() === "" || space.length > SPACE_MAX) return undefined;
  if (role !== "member" && role !== "owner") return undefined;
  return { space, role, source };
}

/**
 * A provider's stage of `conversation.audience`: appends the grants `provider` gives, as `source`'s, and
 * nothing else (see the header). Never throws.
 */
export function audienceStage(source: string, provider: AudienceProvider): (value: Audience, ctx: AppContext) => Promise<Audience> {
  return async (value, ctx) => {
    let answered: readonly unknown[];
    try {
      const got: unknown = await provider.grants(value.principals, value.space, ctx);
      if (!Array.isArray(got)) throw new Error("a provider answers a list of grants");
      answered = got;
    } catch (error) {
      ctx.logger.warn("conversation.audience: a membership provider failed; it grants nothing", { source, error: errorText(error) });
      return value;
    }
    const own: AudienceGrant[] = [];
    let dropped = 0;
    for (const each of answered) {
      const grant = cleanGrant(each, source);
      const foreign = typeof each === "object" && each !== null && "source" in each && (each as { source: unknown }).source !== source;
      if (grant === undefined || foreign || (value.space !== undefined && grant.space !== value.space)) dropped++;
      else own.push(grant);
    }
    if (dropped > 0) ctx.logger.warn("conversation.audience: a membership provider answered grants it may not give; they are dropped", { source, dropped });
    return own.length === 0 ? value : { ...value, grants: [...value.grants, ...own] };
  };
}

/** One string per grant: what `audienceGrants` dedupes by. */
const grantKey = (grant: AudienceGrant): string => JSON.stringify([grant.role, grant.source, grant.space]);

/**
 * The grants of `principals` (only for `space` when given): `conversation.audience` run, its grants
 * deduplicated, in order. `[]` when a stage halted or the pipeline threw (logged): fail closed. Rejects
 * with `DirectoryError` `limit` past `AUDIENCE_MAX` grants (logged).
 */
export async function audienceGrants(ctx: AppContext, principals: readonly Principal[], space?: string): Promise<AudienceGrant[]> {
  let result: Audience | Halt;
  try {
    result = await ctx.run("conversation.audience", { principals, ...(space !== undefined && { space }), grants: [] });
  } catch (error) {
    ctx.logger.warn("conversation.audience: the pipeline failed; no grants", { error: errorText(error) });
    return [];
  }
  if (result instanceof Halt) return [];
  const seen = new Set<string>();
  const grants: AudienceGrant[] = [];
  for (const each of Array.isArray(result.grants) ? result.grants : []) {
    const grant = cleanGrant(each, typeof each?.source === "string" && each.source !== "" ? each.source : "");
    if (grant === undefined || grant.source === "" || (space !== undefined && grant.space !== space)) continue;
    const key = grantKey(grant);
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push(grant);
  }
  if (grants.length > AUDIENCE_MAX) {
    ctx.logger.warn("conversation.audience: more grants than the directory takes", { grants: grants.length, max: AUDIENCE_MAX });
    throw new DirectoryError("limit", `a person belongs to more than ${AUDIENCE_MAX} spaces`);
  }
  return grants;
}

declare module "@pikit/core" {
  interface AppPipelines {
    /** Who belongs to which space: each membership provider's stage (`audienceStage`) appends its own grants and leaves every other one as it is. */
    "conversation.audience": Audience;
  }
}
