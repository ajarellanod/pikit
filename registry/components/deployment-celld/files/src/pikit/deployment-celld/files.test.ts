/**
 * The files this component ships, read as they are: `wrangler.jsonc` deploys this component's Worker,
 * the imports keep to their sides (C5), and the node templates hold what a fleet needs
 * (features/deployment-celld.md, "Nodes and autoscaling"). Nothing here runs them.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "./celld-config.mjs";

const here = import.meta.dir;
const read = (path: string) => readFileSync(join(here, path), "utf8");
const wrangler = parseJsonc(readFileSync(join(here, "..", "..", "..", "wrangler.jsonc"), "utf8")) as Record<string, unknown>;

test("wrangler.jsonc deploys this component's worker.ts: one SQLite-backed Conversation class, bound where the entrypoint reads it", () => {
  expect(wrangler.main).toBe("src/pikit/deployment-celld/worker.ts");
  expect(wrangler.durable_objects).toEqual({ bindings: [{ name: "CONVERSATION", class_name: "Conversation" }] });
  expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Conversation"] }]);
  expect(wrangler.compatibility_flags).toEqual(["nodejs_compat"]);
  // No name: the Worker is named after package.json's, so two projects never share one by accident.
  expect("name" in wrangler).toBe(false);
  // Nothing celld refuses but build, which pikit runs itself.
  expect(Object.keys(wrangler).filter((key) => ["observability", "version_metadata"].includes(key))).toEqual([]);
});

test("entrypoint.ts is the only file that imports cloudflare:*, and the Worker's files reach no node:* (C5)", () => {
  const shipped = readdirSync(here).filter((file) => /\.(ts|mjs)$/.test(file) && !/\.test(-support)?\.ts$/.test(file) && !file.endsWith(".d.mts"));
  const importing = (pattern: RegExp) => shipped.filter((file) => pattern.test(read(file)));
  expect(importing(/from "cloudflare:/)).toEqual(["entrypoint.ts"]);
  for (const file of ["worker.ts", "entrypoint.ts", "host.ts"]) expect([file, /from "node:/.test(read(file))]).toEqual([file, false]);
  // What runs where the deploy runs: the commands and the plain Node scripts.
  expect(importing(/from "node:/).sort()).toEqual(["bucket.mjs", "celld-config.mjs", "commands.ts", "deploy.mjs", "rollout.mjs"]);
});

test("the systemd unit: a fixed disk, restarted always, a stop longer than celld's handoff", () => {
  const unit = read("nodes/celld.service");
  expect(unit).toContain("Environment=CELLD_WATCH=/var/lib/celld/watch");
  expect(unit).toContain("Restart=always");
  const stop = Number(/TimeoutStopSec=(\d+)/.exec(unit)?.[1]);
  // celld's CELLD_SHUTDOWN_TOTAL_MS is 40 s by default.
  expect(stop).toBeGreaterThan(40);
  const env = read("nodes/celld.env");
  expect(env).toMatch(/^CELLD_NODE=\S+$/m);
  expect(env).toMatch(/^CELLD_IDLE_EVICT_S=\d+$/m);
  expect(env).toMatch(/^CELLD_TRUST_FORWARDED_HEADERS=1$/m);
});

test("Caddy checks celld's health path; the firewall keeps the internal listener on the private network, and replaces only its own table", () => {
  expect(read("nodes/Caddyfile")).toContain("health_uri /.well-known/celld/health");
  const nft = read("nodes/firewall.nft");
  expect(nft).toContain("ip saddr $PRIVATE tcp dport 8081 accept");
  expect(nft).toContain("ip saddr $CADDY tcp dport 8080 accept");
  expect(nft).toContain("policy drop");
  expect(nft).not.toMatch(/^flush ruleset/m);
});

test("ECS on EC2: the instance's volume, a stop longer than the handoff, the task's IP advertised and an identity kept on the volume", () => {
  const task = JSON.parse(read("nodes/ecs/task-definition.json")) as {
    requiresCompatibilities: string[];
    networkMode: string;
    containerDefinitions: { stopTimeout: number; mountPoints: { sourceVolume: string; containerPath: string }[] }[];
    volumes: { name: string; host?: { sourcePath: string } }[];
  };
  expect(task.requiresCompatibilities).toEqual(["EC2"]);
  expect(task.networkMode).toBe("awsvpc");
  expect(task.containerDefinitions[0]?.stopTimeout).toBeGreaterThan(40);
  expect(task.containerDefinitions[0]?.mountPoints).toEqual([{ sourceVolume: "celld-state", containerPath: "/var/lib/celld" }]);
  expect(task.volumes).toEqual([{ name: "celld-state", host: { sourcePath: "/var/lib/celld" } }]);
  const entrypoint = read("nodes/ecs/entrypoint.sh");
  expect(entrypoint).toContain('CELLD_ADVERTISE="$IP:8081"');
  expect(entrypoint).toContain('CELLD_NODE=$(cat "$STATE/node-id")');
  expect(read("nodes/ecs/Dockerfile")).toContain("ENTRYPOINT");
});

test("the CI workflow installs a pinned celld and deploys with deploy.mjs, one deploy at a time, then sets the webhook", () => {
  const workflow = read("ci/deploy.yml");
  expect(workflow).toContain("CELLD_VERSION: v0.6.2");
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).toContain("run: node src/pikit/deployment-celld/deploy.mjs src/pikit/channel-telegram-webhook/setup-webhook.mjs");
});
