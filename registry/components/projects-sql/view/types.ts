/**
 * What projects-sql's admin routes answer (`/admin/api/projects*`): the shapes of `@pikit/contracts`'
 * projects.ts and change.ts, as JSON. The dashboard does not import the kit's packages, so they are
 * written here again; keep them in step with the contracts.
 */

export type Principal = { channel: string; id: string; name?: string };

export type Author =
  | { kind: "person"; principal: Principal; conversation?: string }
  | { kind: "agent"; agent: string; conversation: string; for?: Principal }
  | { kind: "operator"; id: string }
  | { kind: "component"; name: string };

export type Project = {
  id: string;
  space: string;
  name: string;
  description: string;
  agents: string[];
  owner: Principal;
  members: number;
  archivedAt?: number;
  removedAt?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
};

export type ProjectPage = { items: Project[]; next?: string };

export type Member = { principal: Principal; role: "owner" | "member"; source: string; checkedAt: number; by: Author; at: number };

export type Instructions = { text: string; version: number; by: Author; at: number };

export type ProjectDocument = {
  id: string;
  title: string;
  mode: "core" | "reference";
  chars: number;
  tokens: number;
  version: number;
  source?: { file: string; fileVersion: number };
  by: Author;
  at: number;
};

export type Link = { id: string; url: string; title: string; note?: string; by: Author; at: number };

/** `GET /admin/api/projects/:id`. */
export type ProjectOverview = { project: Project; members: Member[]; instructions?: Instructions; documents: ProjectDocument[]; links: Link[] };

/** `GET /admin/api/projects/:id/documents/:doc`. */
export type DocumentRead = { document: ProjectDocument; text: string; part: number; parts: number };

export type Change = {
  n: number;
  at: number;
  by: Author;
  action: "added" | "changed" | "removed" | "restored";
  item: { kind: string; id: string; title: string };
  version?: number;
  restores?: number;
  restorable: boolean;
  redacted?: { at: number; by: Author };
};

/** `GET /admin/api/projects/:id/history`. */
export type ChangePage = { items: Change[]; next?: number };

/** Who an author is, in a few words. */
export function authorName(author: Author): string {
  switch (author.kind) {
    case "person":
      return author.principal.name ?? `${author.principal.channel}:${author.principal.id}`;
    case "agent":
      return author.for === undefined ? `${author.agent} (agent)` : `${author.agent} (agent, for ${author.for.name ?? `${author.for.channel}:${author.for.id}`})`;
    case "operator":
      return `${author.id} (operator)`;
    case "component":
      return `${author.name} (component)`;
  }
}

export const principalName = (principal: Principal): string => principal.name ?? `${principal.channel}:${principal.id}`;
