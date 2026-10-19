/**
 * `rollout.mjs`'s parts on their own: what `celld deploy --json` prints, deployment ids, and what a
 * rollback does when the bucket changed under it (another deploy, a missing manifest, another
 * Worker's deployment before), against the fake bucket.
 */

import { afterAll, expect, test } from "bun:test";
import { bucketStore } from "./bucket.mjs";
import { fakeFleet } from "./fake-fleet.test-support.ts";
import { type Deployed, deploymentId, FLEET_POINTER, readDeployOutput, readPrevious, rollBack, rollbackLine } from "./rollout.mjs";

const fleet = fakeFleet();
afterAll(() => fleet.stop());

test("celld deploy --json: its last JSON line is the deployment; anything else is refused", () => {
  const out = 'noise\n{"worker":"my-bot","version":"0123456789abcdef","location":"s3://fleet/deploy/my-bot/0123456789abcdef","dry_run":false}\n';
  expect(readDeployOutput(out)).toEqual({ worker: "my-bot", celldVersion: "0123456789abcdef", location: "s3://fleet/deploy/my-bot/0123456789abcdef" });
  expect(() => readDeployOutput("Current Version ID: 0123\n")).toThrow(/printed no deployment/);
  expect(() => readDeployOutput("{ broken\n")).toThrow(/printed no deployment/);
});

test("a deployment id: when, and 6 random hex digits; two are never the same", () => {
  expect(deploymentId(new Date("2026-10-19T12:34:56.789Z"))).toMatch(/^20261019T123456Z-[0-9a-f]{6}$/);
  expect(deploymentId()).not.toBe(deploymentId());
});

function store() {
  const made = bucketStore(fleet.env());
  if (made.unsupported !== undefined) throw new Error(made.unsupported);
  return made;
}

const deployedAs = (worker: string, celldVersion: string): Deployed => ({ version: "d-new", celldVersion, worker, location: "", url: "http://fleet" });

test("a rollback never writes over a deploy that landed after the failing one", async () => {
  fleet.objects.clear();
  fleet.seed("my-bot", "old");
  const previous = await readPrevious(store());
  const failing = fleet.seed("my-bot", "failing");
  const later = fleet.seed("my-bot", "later");
  const result = await rollBack({ store: store(), previous, deployed: deployedAs("my-bot", failing) });
  expect(result).toEqual({ kind: "superseded", to: expect.any(String), by: later });
  expect(fleet.serving()).toBe("later");
  expect(rollbackLine(deployedAs("my-bot", failing), result)).toContain(`was not rolled back: the bucket now serves ${later}, another deploy that landed since`);
});

test("a previous deployment of another Worker gets only the fleet's pointer back; a missing manifest is said", async () => {
  fleet.objects.clear();
  fleet.seed("old-name", "old");
  const previous = await readPrevious(store());
  const failing = fleet.seed("new-name", "failing");
  expect(await rollBack({ store: store(), previous, deployed: deployedAs("new-name", failing) })).toEqual({ kind: "rolled-back", to: expect.any(String) });
  expect(fleet.serving()).toBe("old");
  expect(JSON.parse(fleet.objects.get("deploy/new-name/current.json")?.body ?? "{}").version).toBe(failing);

  fleet.objects.clear();
  fleet.seed("my-bot", "old");
  const gone = await readPrevious(store());
  for (const key of [...fleet.objects.keys()]) if (key.endsWith("manifest.json")) fleet.objects.delete(key);
  const failed = fleet.seed("my-bot", "failing");
  const result = await rollBack({ store: store(), previous: gone, deployed: deployedAs("my-bot", failed) });
  expect(result).toMatchObject({ kind: "failed", detail: expect.stringContaining("manifest.json) is gone") });
  expect(rollbackLine(deployedAs("my-bot", failed), result)).toContain("and rolling it back to celld version");
});

test("what was read before the deploy says why there is nothing to roll back to", async () => {
  fleet.objects.clear();
  expect(await readPrevious(store())).toEqual({ none: true });
  fleet.objects.set(FLEET_POINTER, { body: "[]", etag: '"x"' });
  expect(await readPrevious(store())).toEqual({ error: "deploy/current.json is not a deployment pointer" });
  expect(await readPrevious({ unsupported: "no keys" })).toEqual({ error: "no keys" });
  const unreachable = bucketStore({ ...fleet.env(), S3_ENDPOINT: "http://127.0.0.1:9/s3" });
  expect(await readPrevious(unreachable)).toMatchObject({ error: expect.stringContaining("could not read deploy/current.json") });
});
