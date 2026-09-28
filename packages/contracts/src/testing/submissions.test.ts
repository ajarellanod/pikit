import { test } from "bun:test";
import { createMemorySubmissions, createSubmissionsConformance } from "./submissions.ts";

// The in-memory double passes the suite it stands in for; restarting it would lose everything.
for (const c of createSubmissionsConformance(
  () => {
    const memory = createMemorySubmissions();
    return { submissions: () => memory.submissions, prune: async () => memory.prune() };
  },
  { prunes: true },
)) {
  test(`memory ${c.group}: ${c.name}`, () => c.run());
}
