/**
 * A fake celld fleet for the tests, with no celld, no node and no bucket:
 * - a fake S3 bucket (path-style, at `<url>/s3`): GET and PUT with ETags and `If-Match`, refusing
 *   requests that are not SigV4-signed with the fleet's key;
 * - `/health` as the fleet would answer it: from the deployment the bucket's pointer selects, its
 *   `PIKIT_DEPLOYMENT` (ok, or failing for a broken deploy, or the old one for a fleet that never
 *   adopts);
 * - a fake `celld` executable on a PATH of its own: `--version`, `deploy` (writes the deployment's
 *   manifest and pointers into the fake bucket as celld does, prints `--json`'s line), `dev` and
 *   `diagnose`; and a fake `ssh`. Each run is noted in a log the tests read.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One run of a fake executable, as it noted it. */
export interface Call {
  command: string;
  args: string[];
  /** For `deploy` and `dev`: the derived config's text, and its mode. */
  config?: string;
  mode?: number;
  /** For `dev`: `.dev.vars`' text. */
  devVars?: string;
  env: Record<string, string | undefined>;
}

export interface FakeFleet {
  dir: string;
  bin: string;
  url: string;
  /** The bucket's objects by key. */
  objects: Map<string, { body: string; etag: string }>;
  /** Every S3 request: method, key, If-Match. */
  requests: { method: string; key: string; ifMatch: string | null }[];
  /** `/health` answers `ok: false` for every deployment but `healthy` ones (default: all ok). */
  unhealthy: boolean;
  healthy: Set<string>;
  /** `/health` keeps answering from the deployment served when this was set (a fleet that never adopts). */
  frozen: string | undefined;
  /** The fake executables' runs. */
  calls(): Call[];
  /** The environment a command runs with: the fake executables first on the PATH, the bucket and URL set. */
  env(extra?: Record<string, string>): Record<string, string>;
  /** Puts a deployment in the bucket as `celld deploy` would, and points the fleet at it. */
  seed(worker: string, deployment: string, classes?: string[]): string;
  /** The `PIKIT_DEPLOYMENT` the bucket's pointer selects now. */
  serving(): string | undefined;
  stop(): void;
}

export const KEY = { id: "AKIDFLEET", secret: "fleet-secret" };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The fake `celld`: a Bun script, so it can read the config and write the fake bucket. */
const FAKE_CELLD = `
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const env = { CELLD_ESBUILD: process.env.CELLD_ESBUILD, CELLD_BUCKET: process.env.CELLD_BUCKET, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
const note = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: "celld", args, env, ...entry }) + "\\n");
const strip = (text) => text.split("\\n").filter((line) => !line.trim().startsWith("//")).join("\\n");
if (args[0] === "--version") {
  note({});
  console.log("celld " + (process.env.FAKE_CELLD_VERSION ?? "0.6.2"));
} else if (args[0] === "deploy") {
  const path = args[args.indexOf("--config") + 1];
  const text = readFileSync(path, "utf8");
  note({ config: text, mode: statSync(path).mode & 0o777 });
  if (process.env.FAKE_DEPLOY_CODE) { console.error("fake celld: the deploy failed"); process.exit(Number(process.env.FAKE_DEPLOY_CODE)); }
  const config = JSON.parse(strip(text));
  const version = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const worker = config.name;
  const prefix = "deploy/" + worker + "/" + version;
  const manifest = { version, script_name: worker, do_classes: config.durable_objects.bindings.map((b) => b.class_name), sqlite_classes: config.migrations.flatMap((m) => m.new_sqlite_classes ?? []), raw_metadata: { vars: config.vars } };
  const pointer = { script_name: worker, version, prefix, rollout: { percent: 100 } };
  const put = (key, body) => fetch(process.env.FAKE_FLEET + "/__put", { method: "POST", body: JSON.stringify({ key, body: JSON.stringify(body, null, 2) }) });
  await put(prefix + "/manifest.json", manifest);
  await put("deploy/" + worker + "/current.json", pointer);
  await put("deploy/current.json", pointer);
  console.error("Uploaded " + worker);
  console.log(JSON.stringify({ worker, version, location: "s3://fleet/" + prefix, dry_run: false }));
} else if (args[0] === "dev") {
  const config = readFileSync(args[1], "utf8");
  const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : undefined;
  note({ config, mode: statSync(args[1]).mode & 0o777, devVars });
  if (process.env.FAKE_DEV_UNTIL_SIGTERM) {
    process.on("SIGTERM", () => process.exit(Number(process.env.FAKE_DEV_CODE ?? 0)));
    setInterval(() => {}, 1000);
  } else process.exit(Number(process.env.FAKE_DEV_CODE ?? 0));
} else if (args[0] === "diagnose") {
  note({});
  if (process.env.FAKE_DIAGNOSE) process.stdout.write(process.env.FAKE_DIAGNOSE);
  if (process.env.FAKE_DIAGNOSE_ERR) process.stderr.write(process.env.FAKE_DIAGNOSE_ERR);
  process.exit(Number(process.env.FAKE_DIAGNOSE_CODE ?? 0));
} else {
  note({});
  process.exit(2);
}
`;

/** The fake `ssh`: notes its arguments; `journalctl` prints two lines; `FAKE_SSH_CODE` fails it. */
const FAKE_SSH = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: "ssh", args, env: {} }) + "\\n");
const host = args[args.indexOf("BatchMode=yes") + 1];
if (args.includes("journalctl")) { console.log("started " + host); console.log("serving " + host); }
process.exit(Number(process.env.FAKE_SSH_CODE ?? 0));
`;

/** Credential scope and signature present: what the fake bucket checks of SigV4 (bucket.test.ts checks the signer itself). */
function signed(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${KEY.id}/`) && /Signature=[0-9a-f]{64}$/.test(authorization) && request.headers.get("x-amz-date") !== null;
}

export function fakeFleet(): FakeFleet {
  const dir = mkdtempSync(join(tmpdir(), "pikit-celld-fleet-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, code] of [
    ["celld", FAKE_CELLD],
    ["ssh", FAKE_SSH],
  ] as const) {
    // --no-env-file: Bun would load the project's .env into the fake's environment, which celld never does.
    writeFileSync(join(bin, name), `#!${process.execPath} --no-env-file\n${code}`);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(dir, "calls.jsonl");
  let tag = 0;
  const objects = new Map<string, { body: string; etag: string }>();
  const requests: FakeFleet["requests"] = [];
  const put = (key: string, body: string) => objects.set(key, { body, etag: `"${++tag}"` });
  const serving = (): string | undefined => {
    const pointer = objects.get("deploy/current.json");
    if (pointer === undefined) return undefined;
    const manifest = objects.get(`${(JSON.parse(pointer.body) as { prefix: string }).prefix}/manifest.json`);
    return manifest === undefined ? undefined : (JSON.parse(manifest.body) as { raw_metadata: { vars: Record<string, string> } }).raw_metadata.vars.PIKIT_DEPLOYMENT;
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__put") {
        const { key, body } = (await request.json()) as { key: string; body: string };
        put(key, body);
        return new Response("ok");
      }
      if (url.pathname === "/health") {
        const version = fleet.frozen ?? serving();
        if (version === undefined) return new Response("no deployment", { status: 503 });
        const ok = !fleet.unhealthy || fleet.healthy.has(version);
        return Response.json(ok ? { ok, version } : { ok, version, error: "the object's App did not start" }, { status: ok ? 200 : 503 });
      }
      if (url.pathname.startsWith("/s3/fleet/")) {
        const key = decodeURIComponent(url.pathname.slice("/s3/fleet/".length));
        requests.push({ method: request.method, key, ifMatch: request.headers.get("if-match") });
        if (!signed(request)) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
        const found = objects.get(key);
        if (request.method === "GET") {
          return found === undefined ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }) : new Response(found.body, { headers: { etag: found.etag } });
        }
        if (request.method === "PUT") {
          const match = request.headers.get("if-match");
          if (match !== null && match !== found?.etag) return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
          put(key, await request.text());
          return new Response(null, { headers: { etag: objects.get(key)?.etag ?? "" } });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const fleet: FakeFleet = {
    dir,
    bin,
    url,
    objects,
    requests,
    unhealthy: false,
    healthy: new Set(),
    frozen: undefined,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call) : []),
    env: (extra = {}) => ({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      FAKE_LOG: log,
      FAKE_FLEET: url,
      CELLD_BUCKET: "s3://fleet",
      S3_ENDPOINT: `${url}/s3`,
      AWS_REGION: "auto",
      AWS_ACCESS_KEY_ID: KEY.id,
      AWS_SECRET_ACCESS_KEY: KEY.secret,
      PIKIT_CELLD_URL: url,
      ...extra,
    }),
    seed(worker, deployment, classes = ["Conversation"]) {
      const version = sha(`${worker}:${deployment}`).slice(0, 16);
      const prefix = `deploy/${worker}/${version}`;
      put(`${prefix}/manifest.json`, JSON.stringify({ version, script_name: worker, do_classes: classes, sqlite_classes: classes, raw_metadata: { vars: { PIKIT_DEPLOYMENT: deployment } } }));
      const pointer = JSON.stringify({ script_name: worker, version, prefix, rollout: { percent: 100 } }, null, 2);
      put(`deploy/${worker}/current.json`, pointer);
      put("deploy/current.json", pointer);
      fleet.healthy.add(deployment);
      return version;
    },
    serving,
    stop() {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return fleet;
}
