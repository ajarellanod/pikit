/**
 * The proposals repository over git's smart HTTP (`ProposalsRemote.serve`), for a shell that cannot
 * reach its path: execution-gondolin answers its guest's requests to the proposals remote with it, in
 * the host. Nothing exposes it on a network: no route, no port.
 *
 * - Only the three smart endpoints, under any URL: `GET …/info/refs?service=git-upload-pack|git-receive-pack`,
 *   `POST …/git-upload-pack`, `POST …/git-receive-pack`. Anything else (the dumb protocol's `/HEAD`,
 *   `/objects/…`) is `404`.
 * - **A push is read before git sees it** (`refusal`): each of its commands must create or update a
 *   branch under the prefix (`refs/heads/<prefix><topic>`, the topic as proposals-local takes ids).
 *   The main branch, any other ref, a deletion, or a request it cannot read refuse the whole push,
 *   answered as git's `ERR` line (git prints `remote error: …`): nothing reaches the repository.
 * - Git itself answers the rest: `git http-backend` over the repository, with an environment of its
 *   own (no variable of the server's, no user or system config), `receive.denyDeletes` and
 *   `receive.fsckObjects` on, bounded in time and in the size of what it reads.
 *
 * Real git is the server's (deployment-docker's image installs it): without it the answer is `500`,
 * saying so. Never throws.
 */

import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { gunzipSync } from "node:zlib";

/** The most a request body may hold (a push's pack): bigger is `413`. */
export const MAX_REQUEST = 64 * 1024 * 1024;
/** How long git may take to answer one request. */
export const GIT_TIMEOUT_MS = 120_000;

const ZERO = /^0{40}$|^0{64}$/;
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface ServeOptions {
  /** The bare repository (`<directory>/project.git`). */
  gitdir: string;
  branchPrefix: string;
  mainBranch: string;
  /** Whether a topic is one proposals-local takes as an id. */
  validId(topic: string): boolean;
  /** Whether the repository is ready (it has its main branch). */
  ready(): Promise<boolean>;
}

const text = (status: number, body: string) => new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** One pkt-line: four hexadecimal digits of length (themselves included), then the data. */
export function pktLine(data: string): Uint8Array {
  const bytes = new TextEncoder().encode(data);
  const length = (bytes.length + 4).toString(16).padStart(4, "0");
  const line = new Uint8Array(bytes.length + 4);
  line.set(new TextEncoder().encode(length));
  line.set(bytes, 4);
  return line;
}

/**
 * The commands at the start of a receive-pack request (`<old> <new> <ref>`, the first with its
 * capabilities after a NUL), up to the flush. Throws when they cannot be read.
 */
export function pushCommands(body: Uint8Array): { commands: { old: string; next: string; ref: string }[]; capabilities: string[] } {
  const decoder = new TextDecoder();
  const commands: { old: string; next: string; ref: string }[] = [];
  let capabilities: string[] = [];
  let at = 0;
  for (;;) {
    if (at + 4 > body.length) throw new Error("the push ends before its commands do");
    const length = Number.parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (!Number.isInteger(length) || (length !== 0 && length < 4)) throw new Error("the push is not git's pkt-line format");
    if (length === 0) break;
    if (at + length > body.length) throw new Error("the push ends inside a command");
    let line = decoder.decode(body.subarray(at + 4, at + length));
    at += length;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (commands.length === 0) capabilities = line.slice(nul + 1).replace(/\n$/, "").split(" ").filter((each) => each !== "");
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, "");
    // A push certificate or a shallow line is not a command.
    if (line.startsWith("shallow ") || line.startsWith("push-cert")) throw new Error(`this repository takes no ${line.split(" ")[0]}`);
    const [old, next, ref, ...rest] = line.split(" ");
    if (old === undefined || next === undefined || ref === undefined || rest.length > 0 || !OID.test(old) || !OID.test(next)) throw new Error(`not a push command: ${JSON.stringify(line.slice(0, 120))}`);
    commands.push({ old, next, ref });
  }
  if (commands.length === 0) throw new Error("the push names no branch");
  return { commands, capabilities };
}

/** Why the push `commands` is refused, or `undefined` when every one creates or updates a branch under the prefix. */
export function refusal(commands: readonly { next: string; ref: string }[], options: Pick<ServeOptions, "branchPrefix" | "mainBranch" | "validId">): string | undefined {
  const heads = `refs/heads/${options.branchPrefix}`;
  for (const { next, ref } of commands) {
    if (ref === `refs/heads/${options.mainBranch}`) return `pushing to ${options.mainBranch} is refused: push a branch ${options.branchPrefix}<topic>, which the operator approves`;
    if (!ref.startsWith(heads) || !options.validId(ref.slice(heads.length))) return `pushing ${ref} is refused: only branches ${options.branchPrefix}<topic> are proposals`;
    if (ZERO.test(next)) return `deleting ${ref} is refused: the operator closes a proposal from the dashboard`;
  }
  return undefined;
}

/**
 * A refusal as receive-pack's answer, which git prints as `remote error: …`: on the side band's error
 * band (3) when the client asked for one, else git's `ERR` line.
 */
export function refused(message: string, sideBand: boolean): Response {
  const line = sideBand ? pktLine(`\u0003${message}\n`) : pktLine(`ERR ${message}\n`);
  const body = new Uint8Array([...line, ...new TextEncoder().encode("0000")]);
  return new Response(body, { status: 200, headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" } });
}

/** Reads `request`'s body, `undefined` past `MAX_REQUEST`. */
async function bodyOf(request: Request): Promise<Uint8Array | undefined> {
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_REQUEST) return undefined;
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}

/** Runs `git http-backend` (CGI) for one request; resolves with its answer as a `Response`. */
function backend(options: ServeOptions, request: Request, endpoint: string, query: string, body: Uint8Array): Promise<Response> {
  const config: [string, string][] = [
    ["receive.denyDeletes", "true"],
    ["receive.fsckObjects", "true"],
    ["http.receivepack", "true"],
    ["http.uploadpack", "true"],
    ["http.getanyfile", "false"],
    ["core.hooksPath", "/dev/null"],
    ["safe.directory", "*"],
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PROJECT_ROOT: dirname(options.gitdir),
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_HTTP_MAX_REQUEST_BUFFER: String(MAX_REQUEST),
    REMOTE_USER: "pikit-agent",
    REQUEST_METHOD: request.method,
    PATH_INFO: `/${basename(options.gitdir)}/${endpoint}`,
    QUERY_STRING: query,
    CONTENT_TYPE: request.headers.get("content-type") ?? "",
    CONTENT_LENGTH: String(body.length),
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
  // Protocol v2, when the client asks for it (and nothing else in that header).
  const protocol = request.headers.get("git-protocol");
  if (protocol !== null && /^version=[0-9]$/.test(protocol)) env.GIT_PROTOCOL = protocol;

  return new Promise((resolve) => {
    const child = spawn("git", ["http-backend"], { env, cwd: dirname(options.gitdir), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (response: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(text(504, `git took more than ${GIT_TIMEOUT_MS / 1000} s to answer`));
    }, GIT_TIMEOUT_MS);
    child.on("error", (error: NodeJS.ErrnoException) =>
      done(text(500, error.code === "ENOENT" ? "git is not installed on this server: the proposals repository cannot be served" : `git could not start: ${error.message}`)),
    );
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    child.on("close", (code) => {
      const output = Buffer.concat(out);
      const split = output.indexOf("\r\n\r\n");
      if (split < 0) {
        const said = Buffer.concat(err).toString("utf8").trim().split("\n").at(-1) ?? "";
        done(text(500, `git http-backend exited with code ${code}${said === "" ? "" : `: ${said}`}`));
        return;
      }
      const headers = new Headers();
      let status = 200;
      for (const line of output.subarray(0, split).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 500;
        else headers.append(name, value);
      }
      done(new Response(output.subarray(split + 4), { status, headers }));
    });
  });
}

/** `ProposalsRemote.serve`: one request of git's smart HTTP over the proposals repository. */
export function createServe(options: ServeOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const service = url.searchParams.get("service");
      let endpoint: string;
      if (request.method === "GET" && url.pathname.endsWith("/info/refs") && (service === "git-upload-pack" || service === "git-receive-pack")) endpoint = "info/refs";
      else if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) endpoint = "git-upload-pack";
      else if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) endpoint = "git-receive-pack";
      else return text(404, "not a git smart HTTP request: only clone, fetch and push are served");

      if (!(await options.ready())) return text(503, `the proposals repository has no ${options.mainBranch} yet: the deployer makes it when it starts (\`pikit up\`)`);

      let body = await bodyOf(request);
      if (body === undefined) return text(413, `the request is over ${MAX_REQUEST} bytes`);
      const encoding = request.headers.get("content-encoding");
      if (encoding === "gzip" || encoding === "x-gzip") {
        try {
          body = new Uint8Array(gunzipSync(body, { maxOutputLength: MAX_REQUEST }));
        } catch {
          return text(413, `the request is not gzip, or is over ${MAX_REQUEST} bytes once unzipped`);
        }
      }
      else if (encoding !== null && encoding !== "identity") return text(415, `content-encoding ${encoding} is not taken`);

      if (endpoint === "git-receive-pack") {
        let why: string | undefined;
        let sideBand = false;
        try {
          const push = pushCommands(body);
          sideBand = push.capabilities.some((capability) => capability === "side-band-64k" || capability === "side-band");
          why = refusal(push.commands, options);
        } catch (error) {
          why = `the push cannot be read: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (why !== undefined) return refused(why, sideBand);
      }
      return await backend(options, request, endpoint, url.search.slice(1), body);
    } catch (error) {
      return text(500, `the proposals repository could not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
