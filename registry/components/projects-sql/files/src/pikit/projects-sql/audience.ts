/**
 * projects-sql's stage of `conversation.audience` (`@pikit/contracts`' conversation-audience.ts,
 * features/completed/conversation-directory.md): a project's members belong to its space, `owner` for its owner.
 * Both halves register it (`audienceStage(AUDIENCE_SOURCE, …)`, id `projects-sql`), over the App's
 * own `projects` client.
 *
 * - **Only a project's own space** (`projectSpace(id)`, `project:<id>`): a space a project adopted (an
 *   operator's `POST` with `space`, a Google Chat space) is never granted through it; that space's
 *   people come from its platform's own stage (the operator's decision of 2026-11-19).
 * - **A list** (no `space`): the people `list` of these principals, active and archived, page after
 *   page: the directory's current members (a stale sourced member none), never a removed project. It
 *   stops one past `AUDIENCE_MAX`, so `audienceGrants` refuses it (`limit`), never a silent cut. The
 *   list may lag a moment behind a project, as the directory does.
 * - **The fresh check** (`space` given): `roleOf` on the project's actor now, after `locate` confirms
 *   the space is its project's own; any other space is answered `[]` without a call.
 * - **Fail closed**: a store that throws makes `audienceStage` append nothing (logged).
 */

import type { AppContext } from "@pikit/core";
import { AUDIENCE_MAX, type AudienceProvider, type Caller, isProjectId, PROJECT_SPACE_PREFIX, type Principal, type ProjectRole, type ProjectStore, projectSpace } from "@pikit/contracts";

/** The `source` of projects-sql's grants. */
export const AUDIENCE_SOURCE = "projects";

/** The project id a space of its own names, or `undefined` for any other space. */
const ownId = (space: string): string | undefined => {
  const id = space.startsWith(PROJECT_SPACE_PREFIX) ? space.slice(PROJECT_SPACE_PREFIX.length) : "";
  return isProjectId(id) ? id : undefined;
};

type Grant = { space: string; role: ProjectRole };

export function projectsAudience(projects: () => ProjectStore): AudienceProvider {
  const listed = async (principals: Principal[], ctx: AppContext): Promise<Grant[]> => {
    const caller: Caller = { kind: "people", principals };
    const grants: Grant[] = [];
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      do {
        const page = await projects().list({ archived, limit: 200, ...(cursor !== undefined && { cursor }) }, caller, ctx);
        for (const project of page.items) {
          if (project.space === projectSpace(project.id) && project.role !== undefined) grants.push({ space: project.space, role: project.role });
        }
        if (grants.length > AUDIENCE_MAX) return grants;
        cursor = page.next;
      } while (cursor !== undefined);
    }
    return grants;
  };

  return {
    async grants(principals, space, ctx) {
      if (principals.length === 0) return [];
      if (space === undefined) return listed([...principals], ctx);
      const id = ownId(space);
      if (id === undefined || (await projects().locate(id, ctx)) !== space) return [];
      const role = await projects().roleOf(space, principals, ctx);
      return role === undefined ? [] : [{ space, role }];
    },
  };
}
