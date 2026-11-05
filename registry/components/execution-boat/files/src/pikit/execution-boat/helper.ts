/**
 * What runs inside the VM, through boat's exec: the file operations (one small Node script, the same
 * `fs` calls as pi-durable's own `NodeExecutionEnv`, so errors and symbolic links behave as there),
 * and the wrapper every command runs in.
 *
 * - **One call per operation.** The script is sent with each call (`node -e <script> <request>`): the
 *   VM keeps nothing of this component's, so a resumed, forked or restored VM needs no install step,
 *   and an agent that changed a file in its VM changed nothing the next call runs.
 * - **Answers are one JSON object** on stdout: `{ ok: true, value }` or `{ ok: false, code, message }`
 *   (`code` is Node's: `ENOENT`…). File contents travel inline (base64) up to `INLINE_BYTES`; larger
 *   ones through a file under the VM's `/tmp/pikit` and boat's signed file URLs (`env.ts`).
 * - **Commands are marked.** Every command starts with `PIKIT_BOAT_COMMAND=1` in its environment, so
 *   the idle check (`probe`) finds what a command left running (`sleep 600 &`, a dev server): Linux's
 *   `/proc/<pid>/environ` of the VM user's processes. A process that cleared its environment, or was
 *   not started by a command (a Docker container, a service), is not seen.
 */

/** The variable that marks a command's processes, and what `probe` looks for. */
export const MARKER = "PIKIT_BOAT_COMMAND=1";

/** File contents at most this large travel inside the call (base64 in the command line or its output). */
export const INLINE_BYTES = 48 * 1024;

/** The exit code of a command whose working directory or program was missing (`spawn_error`). */
export const SPAWN_EXIT = 254;

/** `word` as one word of a POSIX shell command line, whatever it holds. */
export const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** A variable name a command's `env` may set. */
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Plain CommonJS for `node -e` (and `bun -e`): no single quote anywhere, so it needs no escaping.
const SCRIPT = String.raw`
const fs = require("fs"), p = require("path"), cp = require("child_process"), crypto = require("crypto");
const r = JSON.parse(Buffer.from(process.argv[process.argv.length - 1], "base64").toString("utf8"));
const kindOf = (s) => (s.isFile() ? "file" : s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : undefined);
const fail = (code, message) => Object.assign(new Error(message), { code });
const infoOf = (path, s) => ({ name: p.basename(path), path, kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs });
const inside = (root, path) => path === root || path.startsWith(root + "/");
function walk(root, rel, list, skipped) {
  for (const name of fs.readdirSync(p.join(root, rel)).sort()) {
    const relative = rel === "" ? name : rel + "/" + name;
    const full = p.join(root, relative);
    const s = fs.lstatSync(full);
    if (s.isSymbolicLink()) {
      const target = fs.readlinkSync(full);
      if (target.startsWith("/") || !inside(root, p.resolve(p.dirname(full), target))) { skipped.push(relative); continue; }
      list.push(relative);
    } else if (s.isDirectory()) { list.push(relative); walk(root, relative, list, skipped); }
    else if (s.isFile()) list.push(relative);
    else skipped.push(relative);
  }
}
const ops = {
  info() { const s = fs.lstatSync(r.path); if (!kindOf(s)) throw fail("EINVAL", "Unsupported file type"); return infoOf(r.path, s); },
  names() { return fs.readdirSync(r.path); },
  infos() {
    const out = [];
    for (const name of r.names) {
      const path = p.join(r.path, name);
      let s;
      try { s = fs.lstatSync(path); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (kindOf(s)) out.push(infoOf(path, s));
    }
    return out;
  },
  real() { return fs.realpathSync(r.path); },
  read() {
    let flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
    if (r.noFollow) flags |= fs.constants.O_NOFOLLOW;
    let fd;
    try { fd = fs.openSync(r.path, flags); } catch (e) { if (r.noFollow && (e.code === "ELOOP" || e.code === "EMLINK")) throw fail("NOFOLLOW", "Refusing to follow a symbolic link"); throw e; }
    try {
      const s = fs.fstatSync(fd);
      if (s.isDirectory()) throw fail("EISDIR", "EISDIR: illegal operation on a directory, read");
      if (!s.isFile()) throw fail("EINVAL", "Not a regular file");
      const info = infoOf(r.path, s);
      if (s.size <= r.inline) return { info, base64: fs.readFileSync(fd).toString("base64") };
      fs.mkdirSync(p.dirname(r.xfer), { recursive: true });
      const out = fs.openSync(r.xfer, "w", 0o600);
      try { const b = Buffer.alloc(1 << 20); let n; let at = 0; while ((n = fs.readSync(fd, b, 0, b.length, at)) > 0) { fs.writeSync(out, b, 0, n); at += n; } info.size = at; } finally { fs.closeSync(out); }
      return { info, xfer: r.xfer };
    } finally { fs.closeSync(fd); }
  },
  write() {
    fs.mkdirSync(p.dirname(r.path), { recursive: true });
    const data = r.from === undefined ? Buffer.from(r.base64, "base64") : fs.readFileSync(r.from);
    try { if (r.append) fs.appendFileSync(r.path, data); else fs.writeFileSync(r.path, data); }
    finally { if (r.from !== undefined) fs.rmSync(r.from, { force: true }); }
    return null;
  },
  truncate() { const fd = fs.openSync(r.path, "r+"); try { fs.ftruncateSync(fd, r.size); } finally { fs.closeSync(fd); } return null; },
  flush() {
    const fd = fs.openSync(r.path, "r+");
    try { if (fs.fstatSync(fd).isDirectory()) throw fail("EISDIR", "Is a directory"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return null;
  },
  rename() { fs.renameSync(r.from, r.to); return null; },
  mkdir() { fs.mkdirSync(r.path, { recursive: r.recursive }); return null; },
  rm() { fs.rmSync(r.path, { recursive: r.recursive, force: r.force }); return null; },
  mkdtemp() { fs.mkdirSync(r.tmp, { recursive: true }); return fs.mkdtempSync(p.join(r.tmp, r.prefix)); },
  mktemp() {
    fs.mkdirSync(r.tmp, { recursive: true });
    const file = p.join(fs.mkdtempSync(p.join(r.tmp, "tmp-")), r.prefix + crypto.randomUUID() + r.suffix);
    fs.writeFileSync(file, "");
    return file;
  },
  spawned() { let why = ""; try { why = fs.readFileSync(r.path, "utf8"); fs.rmSync(r.path, { force: true }); } catch {} return why; },
  probe() {
    let pids = [];
    try { pids = fs.readdirSync(r.proc); } catch { return 0; }
    let found = 0;
    for (const pid of pids) {
      if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue;
      try { if (fs.readFileSync(p.join(r.proc, pid, "environ"), "latin1").split("\0").includes(r.marker)) found++; } catch {}
    }
    return found;
  },
  export() {
    fs.mkdirSync(r.ws, { recursive: true });
    fs.mkdirSync(p.dirname(r.out), { recursive: true });
    const list = [], skipped = [];
    walk(r.ws, "", list, skipped);
    const names = r.out + ".list";
    fs.writeFileSync(names, list.map((name) => name + "\0").join(""));
    const gnu = /GNU tar/.test(String(cp.spawnSync("tar", ["--version"]).stdout));
    const args = ["-c", "-z", "-f", r.out, "--format=pax", "--no-recursion", ...(gnu ? ["--hard-dereference"] : []), "-C", r.ws, "--null", "-T", names];
    const done = cp.spawnSync("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    fs.rmSync(names, { force: true });
    if (done.status !== 0) throw fail("ETAR", "tar failed: " + String(done.stderr).slice(0, 300));
    return { size: fs.statSync(r.out).size, entries: list.length, skipped: skipped.length };
  },
  restore() {
    const fresh = r.ws + ".restore-" + crypto.randomUUID();
    fs.mkdirSync(fresh, { recursive: true });
    const done = cp.spawnSync("tar", ["-x", "-z", "-f", r.archive, "-C", fresh, "--no-same-owner"]);
    fs.rmSync(r.archive, { force: true });
    if (done.status !== 0) { fs.rmSync(fresh, { recursive: true, force: true }); throw fail("ETAR", "tar failed: " + String(done.stderr).slice(0, 300)); }
    fs.rmSync(r.ws, { recursive: true, force: true });
    fs.renameSync(fresh, r.ws);
    return null;
  },
};
let answer;
try { answer = { ok: true, value: ops[r.op]() }; } catch (e) { answer = { ok: false, code: String((e && e.code) || ""), message: String((e && e.message) || e) }; }
process.stdout.write(JSON.stringify(answer));
`;

/** The shell command that runs operation `request` with `node` (the VM's Node, or Bun). */
export function helperCommand(node: string, request: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return `${quote(node)} -e ${quote(SCRIPT)} ${quote(encoded)}`;
}

export interface WrapOptions {
  run: string | readonly string[];
  cwd: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** Where the wrapper notes a missing working directory or program before it exits with `SPAWN_EXIT`. */
  spawnNote: string;
}

/**
 * The shell line a command runs as: in `cwd`, marked, with its variables; a string through
 * `bash -c`, an argv as its program with its arguments unparsed. A missing `cwd` or program notes
 * why in `spawnNote` and exits `SPAWN_EXIT`, so `env.ts` answers `spawn_error`.
 */
export function wrapCommand(options: WrapOptions): string {
  const note = (why: string) => `{ mkdir -p -- ${quote(dirOf(options.spawnNote))} && printf ${why} > ${quote(options.spawnNote)}; exit ${SPAWN_EXIT}; }`;
  const vars = Object.entries(options.env ?? {}).map(([name, value]) => quote(`${name}=${value}`));
  const lines = [`cd -- ${quote(options.cwd)} 2>/dev/null || ${note("cwd")}`];
  let program: string[];
  if (typeof options.run === "string") {
    program = [options.inheritEnv === false ? "/bin/bash" : "bash", "-c", quote(options.run)];
  } else {
    const [name, ...args] = options.run as string[];
    lines.push(`command -v ${quote(name as string)} >/dev/null 2>&1 || ${note("program")}`);
    program = [quote(name as string), ...args.map(quote)];
  }
  if (options.inheritEnv === false) {
    lines.push(`exec env -i ${MARKER} ${vars.join(" ")} ${program.join(" ")}`);
  } else {
    lines.push(`export ${MARKER}`);
    if (vars.length > 0) lines.push(`export ${vars.join(" ")}`);
    lines.push(`exec ${program.join(" ")}`);
  }
  return lines.join("\n");
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}
