/**
 * How the agent's shell reaches `git.ts`: a built-in, as execution-do's just-bash has one, made of
 * two halves.
 * - **In the server:** a small HTTP endpoint on 127.0.0.1 (a random port), answering only requests
 *   with this start's random key. It runs `git <args>` in the directory given, which must be inside
 *   the working directory, and answers with the output and the exit code.
 * - **On the shell's `PATH`:** a program named `git` (a script this same runtime runs) that sends its
 *   arguments and its directory there and prints what comes back. It holds the port and the key,
 *   never the GitHub token: anything that reads the program learns only how to run the same fenced
 *   `git`.
 *
 * The program sits in a directory of its own under the system's temporary directory, made at start
 * and removed at stop; the directory is chosen at setup, because the commands' `PATH` is fixed then.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandResult } from "./git.ts";

export interface GitShimOptions {
  /** Where the `git` program goes: a directory of its own, put first on the commands' `PATH`. */
  dir: string;
  /** The working directory: `git` runs only inside it. */
  root: string;
  run(args: string[], cwd: string): Promise<CommandResult>;
}

export interface GitShim {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Larger than any `git` command line; anything bigger is refused unread. */
const MAX_REQUEST_BYTES = 1024 * 1024;

export function createGitShim(options: GitShimOptions): GitShim {
  let server: Server | undefined;
  // Made real at start (the program reports its real directory: on macOS /var is /private/var).
  let root = resolve(options.root);

  const answer = async (body: string): Promise<CommandResult> => {
    const request = JSON.parse(body) as { args?: unknown; cwd?: unknown };
    const args = Array.isArray(request.args) && request.args.every((arg) => typeof arg === "string") ? (request.args as string[]) : undefined;
    if (args === undefined || typeof request.cwd !== "string") return { stdout: "", stderr: "git: a malformed request\n", exitCode: 128 };
    const cwd = resolve(request.cwd);
    const inside = relative(root, cwd);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return { stdout: "", stderr: `fatal: git works here only inside the workspace (${root})\n`, exitCode: 128 };
    }
    return await options.run(args, cwd);
  };

  return {
    async start() {
      root = await realpath(resolve(options.root));
      const key = randomBytes(32).toString("hex");
      const listening = createServer((request, response) => {
        const reply = (status: number, result: CommandResult) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        };
        if (request.method !== "POST" || request.headers.authorization !== `Bearer ${key}`) {
          reply(403, { stdout: "", stderr: "git: refused\n", exitCode: 128 });
          request.resume();
          return;
        }
        let body = "";
        let size = 0;
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          size += chunk.length;
          if (size > MAX_REQUEST_BYTES) request.destroy();
          else body += chunk;
        });
        request.on("end", () => {
          answer(body).then(
            (result) => reply(200, result),
            (error: unknown) => reply(200, { stdout: "", stderr: `git: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 128 }),
          );
        });
      });
      await new Promise<void>((done, failed) => {
        listening.once("error", failed);
        listening.listen(0, "127.0.0.1", () => done());
      });
      server = listening;
      const { port } = listening.address() as AddressInfo;
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      const program = join(options.dir, "git");
      await writeFile(program, shimProgram(process.execPath, port, key), { mode: 0o700 });
      await chmod(program, 0o700);
    },
    async stop() {
      const closing = server;
      server = undefined;
      if (closing !== undefined) {
        closing.closeAllConnections();
        await new Promise<void>((done) => closing.close(() => done()));
      }
      await rm(options.dir, { recursive: true, force: true });
    },
  };
}

/** The `git` program: CommonJS, so Bun or Node runs it as it is. */
export function shimProgram(runtime: string, port: number, key: string): string {
  return `#!${runtime}
// execution-local's \`git\`: the server runs it (git.ts), with the fences there. Written at start.
const http = require("node:http");
const body = JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() });
const request = http.request(
  { host: "127.0.0.1", port: ${port}, path: "/git", method: "POST", headers: { authorization: "Bearer ${key}", "content-type": "application/json" } },
  (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => (text += chunk));
    response.on("end", () => {
      try {
        const result = JSON.parse(text);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exitCode = result.exitCode;
      } catch {
        process.stderr.write("git: the server answered something else\\n");
        process.exitCode = 128;
      }
    });
  },
);
request.on("error", (error) => {
  process.stderr.write("git: the server's git is not reachable: " + error.message + "\\n");
  process.exitCode = 128;
});
request.end(body);
`;
}
