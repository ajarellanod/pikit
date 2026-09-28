// Public surface of @pikit/core/testing (SPEC §14): what the kernel itself runs. The lifecycle
// suite every component that owns resources passes, and a clock tests move by hand. The contracts'
// suites are in @pikit/contracts/testing.

export type { ConformanceCase, LifecycleConformanceOptions, LifecycleFixture } from "./lifecycle.ts";
export { createLifecycleConformance } from "./lifecycle.ts";

export type { ManualClock } from "./manual-clock.ts";
export { createManualClock } from "./manual-clock.ts";
