/**
 * What the dashboard reads of health, on Cloudflare (SPEC §5, features/health.md): health-registry
 * passes the `health` suite in workerd, where each object's App has its own.
 */

import { createHealthConformance } from "@pikit/contracts/testing";
import { it } from "vitest";
import healthRegistry from "../../../registry/components/health-registry/files/src/pikit/health-registry/index.ts";

for (const c of createHealthConformance((policy) => ({
  components: [healthRegistry],
  config: { "health-registry": { essential: policy.essential, graceMs: policy.graceMs } },
}))) {
  it(`health-registry ${c.group}: ${c.name}`, () => c.run());
}
