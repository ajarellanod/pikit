/**
 * projects-sql's admin routes (the dashboard's view, `view/`), in whichever App serves HTTP: a
 * server's, or the Worker's on Cloudflare (`worker.ts`). Every route asks `admin.auth` first, before
 * reading anything (`401` without an operator, or without a provider), and acts through `projects`
 * as the operator (`{ kind: "operator", id }`): the project's actor decides, as for anyone.
 *
 * - `GET /admin/api/projects?archived=&cursor=&limit=`: a page of every project (removed ones too).
 * - `POST /admin/api/projects` `{ space?, name, description?, owner, agents? }`: a new project, `201`
 *   with it; `space` adopts an existing space (a Google Chat space's key), else a new one. A space that
 *   has a project already is `409` `{ error: "space_taken", id }` with that project's id, so a script
 *   adopting spaces may run again.
 * - `GET /admin/api/projects/:id`: `{ project, members, instructions?, documents, links }`.
 * - `GET /admin/api/projects/:id/history?before=&limit=`: a page of its log, newest first.
 * - `GET /admin/api/projects/:id/documents/:doc?part=&version=`: a part of a document.
 * - `POST /admin/api/projects/:id/history/:n/restore`, `.../history/:n/redact`.
 * - `POST /admin/api/projects/:id/archive` `{ archived }`, `.../remove`, `.../recover`.
 * - `POST /admin/api/projects/:id/members` `{ principal }`, `.../members/remove` `{ principal }`,
 *   `.../owner` `{ principal }`.
 *
 * A project id that is not one, or no project, is `404`; the store's refusals map to `403`
 * (`forbidden`), `409` (`conflict`, `space_taken`), `410` (`gone`) and `400` (`invalid`, `limit`,
 * `refused`), as `{ error: <code>, message }`. Operators' acts are logged with the operator and the
 * project's id, never a name or a text.
 */

import type { AppContext, Pikit } from "@pikit/core";
import { type Caller, type ChangePageRequest, isJsonObject, isProjectId, type NewProject, type Operator, type Principal, ProjectError, type ProjectStore } from "@pikit/contracts";

export const ROUTE = "/admin/api/projects";
const MAX_BODY = 16 * 1024;
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, conflict: 409, space_taken: 409, gone: 410, invalid: 400, limit: 400, refused: 400 };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store", "www-authenticate": 'Bearer realm="pikit"' } });
const notFound = () => json({ error: "not_found" }, 404);

/** The path's segments after `/admin/api/projects`, decoded; `undefined` when one does not decode. */
function segments(request: Request): string[] | undefined {
  try {
    return new URL(request.url).pathname.slice(ROUTE.length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) ? value : json({ error: "invalid_request", message: "the body is a JSON object" }, 400);
  } catch {
    return json({ error: "invalid_request", message: "the body is JSON" }, 400);
  }
}

/** The routes over `store` (the App's `projects`). */
export function provideRoutes(pikit: Pikit, store: () => ProjectStore): void {
  const auth = pikit.useOptional("admin.auth");

  /** A route that needs an operator and, with `project`, the space of the path's project id. */
  const route =
    (work: (request: Request, ctx: AppContext, operator: Caller, at: { space: string; id: string; rest: string[] }) => Promise<Response>) =>
    async (request: Request, ctx: AppContext): Promise<Response> => {
      const operator: Operator | undefined = await auth.get()?.verify(request, ctx);
      if (operator === undefined) return unauthorized();
      const caller: Caller = { kind: "operator", id: operator.id };
      const [id = "", ...rest] = segments(request) ?? [];
      try {
        if (!isProjectId(id)) return notFound();
        const space = await store().locate(id, ctx);
        if (space === undefined) return notFound();
        return await work(request, ctx, caller, { space, id, rest });
      } catch (error) {
        if (error instanceof ProjectError) return json({ error: error.code, message: error.message }, STATUS[error.code] ?? 400);
        throw error;
      }
    };
  /** An operator's act, logged with the operator and the project's id only. */
  const acted = (ctx: AppContext, operator: Caller, id: string, act: string) =>
    ctx.logger.info("projects-sql: an operator's act", { operator: operator.kind === "operator" ? operator.id : "", project: id, act });
  const principalIn = (fields: Record<string, unknown>): Principal | Response => {
    const value = fields.principal;
    if (!isJsonObject(value) || typeof value.channel !== "string" || typeof value.id !== "string") return json({ error: "invalid_request", message: "the body is { principal: { channel, id } }" }, 400);
    return value as unknown as Principal;
  };

  const NEW_PROJECT = new Set(["space", "name", "description", "owner", "agents"]);
  /** The body of `POST /admin/api/projects`, its shape only: the store checks the rest (`invalid`, `refused`). */
  const newProjectIn = (fields: Record<string, unknown>): NewProject | Response => {
    const { space, name, description, owner, agents } = fields;
    const invalid = json({ error: "invalid_request", message: "the body is { space?, name, description?, owner: { channel, id }, agents? }" }, 400);
    if (Object.keys(fields).some((key) => !NEW_PROJECT.has(key))) return invalid;
    if (typeof name !== "string" || (space !== undefined && typeof space !== "string") || (description !== undefined && typeof description !== "string")) return invalid;
    if (!isJsonObject(owner) || typeof owner.channel !== "string" || typeof owner.id !== "string") return invalid;
    if (agents !== undefined && (!Array.isArray(agents) || agents.some((agent) => typeof agent !== "string"))) return invalid;
    return {
      name,
      owner: owner as unknown as Principal,
      ...(space !== undefined && { space }),
      ...(description !== undefined && { description }),
      ...(agents !== undefined && { agents: agents as string[] }),
    };
  };

  pikit.provideKeyed("http.route", `GET ${ROUTE}`, async (request, ctx) => {
    const operator = await auth.get()?.verify(request, ctx);
    if (operator === undefined) return unauthorized();
    const params = new URL(request.url).searchParams;
    const limit = params.get("limit");
    try {
      return json(
        await store().list(
          {
            ...(params.get("archived") === "true" && { archived: true }),
            ...(params.get("cursor") !== null && { cursor: params.get("cursor") as string }),
            ...(limit !== null && { limit: Number(limit) }),
          },
          { kind: "operator", id: operator.id },
          ctx,
        ),
      );
    } catch (error) {
      if (error instanceof ProjectError) return json({ error: error.code, message: error.message }, STATUS[error.code] ?? 400);
      throw error;
    }
  });

  pikit.provideKeyed("http.route", `POST ${ROUTE}`, async (request, ctx) => {
    const operator = await auth.get()?.verify(request, ctx);
    if (operator === undefined) return unauthorized();
    const caller: Caller = { kind: "operator", id: operator.id };
    const fields = await body(request);
    if (fields instanceof Response) return fields;
    const input = newProjectIn(fields);
    if (input instanceof Response) return input;
    try {
      const project = await store().create(input, caller, ctx);
      acted(ctx, caller, project.id, "create");
      return json(project, 201);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      // The space has a project: which one, so the caller can tell it is done (removed ones too).
      const existing = error.code === "space_taken" && input.space !== undefined ? await store().get(input.space, caller, ctx) : undefined;
      return json({ error: error.code, message: error.message, ...(existing !== undefined && { id: existing.id }) }, STATUS[error.code] ?? 400);
    }
  });

  pikit.provideKeyed(
    "http.route",
    `GET ${ROUTE}/:id`,
    route(async (_request, ctx, operator, { space }) => {
      const projects = store();
      const project = await projects.get(space, operator, ctx);
      if (project === undefined) return notFound();
      const [members, instructions, documents, links] = await Promise.all([
        projects.members(space, { limit: 200 }, operator, ctx),
        projects.instructions(space, {}, operator, ctx),
        projects.documents(space, operator, ctx),
        projects.links(space, operator, ctx),
      ]);
      return json({ project, members: members.items, ...(instructions !== undefined && { instructions }), documents, links });
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `GET ${ROUTE}/:id/history`,
    route(async (request, ctx, operator, { space }) => {
      const params = new URL(request.url).searchParams;
      const page: ChangePageRequest = { limit: Number(params.get("limit") ?? 50), ...(params.get("before") !== null && { before: Number(params.get("before")) }) };
      return json(await store().changes(space, page, operator, ctx));
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `GET ${ROUTE}/:id/documents/:doc`,
    route(async (request, ctx, operator, { space, rest }) => {
      const params = new URL(request.url).searchParams;
      const version = params.get("version");
      const read = await store().read(space, rest[1] ?? "", { part: Number(params.get("part") ?? 1), ...(version !== null && { version: Number(version) }) }, operator, ctx);
      return read === undefined ? notFound() : json(read);
    }),
  );

  for (const act of ["restore", "redact"] as const) {
    pikit.provideKeyed(
      "http.route",
      `POST ${ROUTE}/:id/history/:n/${act}`,
      route(async (_request, ctx, operator, { space, id, rest }) => {
        const n = Number(rest[1]);
        if (!Number.isInteger(n) || n < 1) return notFound();
        acted(ctx, operator, id, act);
        if (act === "redact") {
          await store().redact(space, n, operator, ctx);
          return json({ ok: true });
        }
        return json(await store().restore(space, n, operator, ctx));
      }),
    );
  }

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/archive`,
    route(async (request, ctx, operator, { space, id }) => {
      const fields = await body(request);
      if (fields instanceof Response) return fields;
      if (typeof fields.archived !== "boolean") return json({ error: "invalid_request", message: "the body is { archived: true | false }" }, 400);
      acted(ctx, operator, id, fields.archived ? "archive" : "unarchive");
      return json(await store().update(space, { archived: fields.archived }, operator, ctx));
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/remove`,
    route(async (_request, ctx, operator, { space, id }) => {
      acted(ctx, operator, id, "remove");
      await store().remove(space, operator, ctx);
      return json({ ok: true });
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/recover`,
    route(async (_request, ctx, operator, { space, id }) => {
      acted(ctx, operator, id, "recover");
      return json(await store().recover(space, operator, ctx));
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/members`,
    route(async (request, ctx, operator, { space, id }) => {
      const fields = await body(request);
      if (fields instanceof Response) return fields;
      const principal = principalIn(fields);
      if (principal instanceof Response) return principal;
      acted(ctx, operator, id, "add a member");
      return json(await store().addMember(space, principal, operator, ctx));
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/members/remove`,
    route(async (request, ctx, operator, { space, id }) => {
      const fields = await body(request);
      if (fields instanceof Response) return fields;
      const principal = principalIn(fields);
      if (principal instanceof Response) return principal;
      acted(ctx, operator, id, "remove a member");
      return json({ removed: await store().removeMember(space, principal, operator, ctx) });
    }),
  );

  pikit.provideKeyed(
    "http.route",
    `POST ${ROUTE}/:id/owner`,
    route(async (request, ctx, operator, { space, id }) => {
      const fields = await body(request);
      if (fields instanceof Response) return fields;
      const principal = principalIn(fields);
      if (principal instanceof Response) return principal;
      acted(ctx, operator, id, "transfer the ownership");
      return json(await store().transferOwnership(space, principal, operator, ctx));
    }),
  );
}
