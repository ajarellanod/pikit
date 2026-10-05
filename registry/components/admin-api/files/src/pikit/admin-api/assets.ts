/**
 * The dashboard's built files (`src/dashboard/dist/` by default), served under `/admin/`.
 *
 * - They hold no data: the page asks the operator for the token and sends it with every API call. A
 *   browser's navigation sends no `Authorization` header, so the files are served to anyone, and every
 *   `/admin/api/*` answer asks `admin.auth`.
 * - A path is decoded and confined to the folder: `..`, an encoded `/` or `\` and a NUL are not found.
 * - `/admin` redirects to `/admin/`, so the page's relative URLs resolve under it.
 * - A path with no file and no extension is a page of the app (`/admin/conversations/abc`): it gets
 *   `index.html`, and the app's router shows it. A missing file with an extension is a `404`.
 * - Vite's hashed files (`assets/`) are cached for good; everything else is revalidated.
 *
 * Server only: it reads the disk.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const HEADERS = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };

/** Where the files are mounted. */
export const BASE = "/admin";

export interface Assets {
  /** The folder, absolute. */
  root: string;
  /** Whether it holds a built dashboard (`index.html`). */
  built(): Promise<boolean>;
  /** The answer to a `GET` of `pathname` (under `/admin`). */
  serve(pathname: string): Promise<Response>;
}

export function createAssets(folder: string): Assets {
  const root = resolve(folder);
  const index = resolve(root, "index.html");

  const file = async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };

  const send = async (path: string, cache: string): Promise<Response> =>
    new Response(await readFile(path), {
      headers: { ...HEADERS, "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream", "cache-control": cache },
    });

  const notFound = (): Response => new Response("not found", { status: 404, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });

  return {
    root,
    built: () => file(index),
    async serve(pathname) {
      if (pathname === BASE) return new Response(null, { status: 308, headers: { ...HEADERS, location: `${BASE}/` } });
      const segments = decoded(pathname.slice(BASE.length + 1).split("/"));
      if (segments === undefined) return notFound();
      const path = resolve(root, ...segments);
      if (path !== root && !path.startsWith(root + sep)) return notFound();

      if (path !== root && (await file(path))) {
        return send(path, segments[0] === "assets" ? "public, max-age=31536000, immutable" : "no-cache");
      }
      if (extname(segments.at(-1) ?? "") !== "") return notFound();
      if (!(await file(index))) {
        return new Response("no dashboard is built here: the project has no src/dashboard/, or it was not built (its own `bun run build`)", {
          status: 404,
          headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
        });
      }
      return send(index, "no-cache");
    },
  };
}

/** The path's segments, decoded; `undefined` when one is malformed or tries to leave the folder. */
function decoded(raw: string[]): string[] | undefined {
  const segments: string[] = [];
  for (const each of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(each);
    } catch {
      return undefined;
    }
    if (segment === "..") return undefined;
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return undefined;
    if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return segments;
}
