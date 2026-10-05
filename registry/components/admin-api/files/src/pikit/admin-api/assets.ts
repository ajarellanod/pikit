/**
 * The dashboard's built files, served under `/admin/`. They are a module (`dashboard-files.ts`), which
 * the dashboard's own build writes (`src/dashboard/scripts/embed.ts`, after `vite build`): bundled
 * with the app, so every host serves them the same way, a Worker included, with no disk and no binding.
 *
 * - They hold no data: the page asks the operator for the token and sends it with every API call. A
 *   browser's navigation sends no `Authorization` header, so the files are served to anyone, and every
 *   `/admin/api/*` answer asks `admin.auth`.
 * - A path is decoded and looked up among the files: `..`, an encoded `/` or `\` and a NUL are not found.
 * - `/admin` redirects to `/admin/`, so the page's relative URLs resolve under it.
 * - A path with no file and no extension is a page of the app (`/admin/conversations/abc`): it gets
 *   `index.html`, and the app's router shows it. A missing file with an extension is a `404`.
 * - Vite's hashed files (`assets/`) are cached for good; everything else is revalidated.
 */

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

/** The built files: path under `dist/` (`assets/index-abc.js`) → its bytes in base64. */
export type DashboardFiles = Readonly<Record<string, string>>;

export interface Assets {
  /** Whether a dashboard is built in (`index.html`). */
  built(): boolean;
  /** How many files. */
  size(): number;
  /** The answer to a `GET` of `pathname` (under `/admin`). */
  serve(pathname: string): Response;
}

export function createAssets(files: DashboardFiles): Assets {
  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  const bytes = (path: string): Uint8Array<ArrayBuffer> => {
    let found = decoded.get(path);
    if (found === undefined) {
      const binary = atob(files[path] as string);
      found = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) found[i] = binary.charCodeAt(i);
      decoded.set(path, found);
    }
    return found;
  };
  const has = (path: string): boolean => Object.hasOwn(files, path);

  const send = (path: string, cache: string): Response =>
    new Response(bytes(path), { headers: { ...HEADERS, "content-type": TYPES[extension(path)] ?? "application/octet-stream", "cache-control": cache } });

  const notFound = (): Response => new Response("not found", { status: 404, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });

  return {
    built: () => has("index.html"),
    size: () => Object.keys(files).length,
    serve(pathname) {
      if (pathname === BASE) return new Response(null, { status: 308, headers: { ...HEADERS, location: `${BASE}/` } });
      const segments = segmentsOf(pathname.slice(BASE.length + 1).split("/"));
      if (segments === undefined) return notFound();
      const path = segments.join("/");

      if (path !== "" && has(path)) return send(path, segments[0] === "assets" ? "public, max-age=31536000, immutable" : "no-cache");
      if (extension(segments.at(-1) ?? "") !== "") return notFound();
      if (!has("index.html")) {
        return new Response("no dashboard is built here: the project has no src/dashboard/, or it was not built (its own `bun run build`)", {
          status: 404,
          headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
        });
      }
      return send("index.html", "no-cache");
    },
  };
}

/** `.js` of `index-abc.js`, lowercased; `""` without one (a leading dot is a name, not an extension). */
function extension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The path's segments, decoded; `undefined` when one is malformed or tries to leave the folder. */
function segmentsOf(raw: string[]): string[] | undefined {
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
