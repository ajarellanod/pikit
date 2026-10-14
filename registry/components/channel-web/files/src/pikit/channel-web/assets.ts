/**
 * The chat page's built files, served under `/chat/`. They are a module (`chat-files.ts`), which the
 * page's own build writes: bundled with the app, so every host serves them the same way, a Worker
 * included, with no disk and no binding. The kit's copy is empty: then `/chat/` says no page is built.
 *
 * - They hold no data: the page signs in through `/chat/api/auth/*`, and every other `/chat/api/*`
 *   answer needs a user's session.
 * - A path is decoded and looked up among the files: `..`, an encoded `/` or `\` and a NUL find none.
 * - `/chat` redirects to `/chat/`, so the page's relative URLs resolve under it.
 * - Only `/chat/assets/…` is files alone: a missing one there is a `404`. Any other path that is not a
 *   file is a page of the app and gets `index.html` (`/chat/c/<id>`, a reset link's landing page).
 * - Every answer has a Content-Security-Policy (`cspOf`): scripts, styles, fonts and API calls from the
 *   same origin only; images also `data:`, `blob:` (one attached and not sent yet) and the avatar hosts
 *   of the configured built-in providers (`avatarHosts`), nothing else: an image in an answer that
 *   names another site loads nothing (the page shows it as a link), so an answer cannot carry what it
 *   read out in an image's address. An OIDC platform's avatar is not shown. No inline script, no
 *   framing, forms posted only here. Inline styles are allowed (a style runs no code).
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
  ".webmanifest": "application/manifest+json",
};

/** Where each built-in provider (better-auth's id) serves its users' avatars. Another has none shown. */
const AVATARS: Record<string, readonly string[]> = {
  google: ["https://*.googleusercontent.com"],
  github: ["https://avatars.githubusercontent.com"],
  gitlab: ["https://gitlab.com", "https://secure.gravatar.com"],
  discord: ["https://cdn.discordapp.com"],
  facebook: ["https://*.fbcdn.net", "https://platform-lookaside.fbsbx.com"],
  twitter: ["https://pbs.twimg.com"],
  linkedin: ["https://media.licdn.com"],
  slack: ["https://*.slack-edge.com", "https://secure.gravatar.com"],
};

/** The avatar hosts of the built-in providers `social` (their ids), once each. */
export const avatarHosts = (social: readonly string[]): string[] => [...new Set(social.flatMap((id) => AVATARS[id] ?? []))];

/** What the chat page may load: its own files and API, images of its own and `imageHosts` (avatars), nothing inline but styles. */
export function cspOf(imageHosts: readonly string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...imageHosts].join(" "),
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Where the files are mounted. */
export const BASE = "/chat";

/** The built files: path under `dist/` (`assets/index-abc.js`) → its bytes in base64. */
export type ChatFiles = Readonly<Record<string, string>>;

export interface Assets {
  /** Whether a page is built in (`index.html`). */
  built(): boolean;
  /** How many files. */
  size(): number;
  /** The answer to a `GET` of `pathname` (under `/chat`). */
  serve(pathname: string): Response;
}

/** The page's files `files`, under a CSP whose images may also come from `imageHosts()` (`avatarHosts`; read at the first answer). */
export function createAssets(files: ChatFiles, imageHosts: () => readonly string[] = () => []): Assets {
  let csp: string | undefined;
  const headers = () => ({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": (csp ??= cspOf(imageHosts())) });
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
    new Response(bytes(path), { headers: { ...headers(), "content-type": TYPES[extension(path)] ?? "application/octet-stream", "cache-control": cache } });
  const text = (status: number, body: string): Response => new Response(body, { status, headers: { ...headers(), "content-type": "text/plain; charset=utf-8" } });

  return {
    built: () => has("index.html"),
    size: () => Object.keys(files).length,
    serve(pathname) {
      if (pathname === BASE) return new Response(null, { status: 308, headers: { ...headers(), location: `${BASE}/` } });
      const raw = pathname.slice(BASE.length + 1);
      const segments = segmentsOf(raw.split("/"));
      const path = segments?.join("/") ?? "";
      if (path !== "" && has(path)) return send(path, segments?.[0] === "assets" ? "public, max-age=31536000, immutable" : "no-cache");
      if (segments?.[0] === "assets" || raw.startsWith("assets/")) return text(404, "not found");
      if (!has("index.html")) return text(404, "no chat page is built here: the project has no src/chat/, or it was not built (its own `bun run build`)");
      return send("index.html", "no-cache");
    },
  };
}

/** `.js` of `index-abc.js`, lowercased; `""` without one. */
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
