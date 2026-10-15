/**
 * The dashboard's shared UI pieces (`scripts/ui-shared.ts`) need no admin client, so a UI project
 * other than the dashboard (channel-web's chat page) can carry them; and `@pikit/lib-ui` and
 * `@pikit/admin-client` split `src/lib/` between them.
 */

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_NOTE as API_OPERATOR_NOTE } from "../registry/dashboard/files/src/lib/admin-api.ts";
import { OPERATOR_NOTE } from "../registry/dashboard/files/src/lib/messages.ts";
import { ADMIN_CLIENT, DASHBOARD, LIB_UI, SHADCN_UTILS, SHARED_UI_FILES, sharedUiViolations } from "./ui-shared.ts";

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of the template's `src/` (enough for the check), to break. */
function copy(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pikit-ui-shared-"));
  temps.push(root);
  cpSync(join(DASHBOARD, "src"), join(root, "src"), { recursive: true });
  return root;
}

test("no shared piece reaches the admin client, or any file of the dashboard that is not shared", () => {
  expect(SHARED_UI_FILES).toContain("src/components/pikit/message.tsx");
  expect(SHARED_UI_FILES).toContain("src/components/pikit/error-note.tsx");
  expect(SHARED_UI_FILES).toContain("src/components/bui/PromptBar.tsx");
  expect(SHARED_UI_FILES).toContain("src/lib/messages.ts");
  // The conversation's view, its live state, its Context panel and the tabs (features/completed/chat-parity.md).
  for (const file of ["src/components/pikit/conversation.tsx", "src/components/pikit/context-panel.tsx", "src/components/pikit/tab-bar.tsx", "src/lib/transcript.ts", "src/lib/sources.ts"]) {
    expect(SHARED_UI_FILES).toContain(file);
  }
  expect(sharedUiViolations()).toEqual([]);
});

test("a shared piece that reaches the admin client is caught, by @/ or by a relative path", () => {
  const root = copy();
  // Re-exports: the same import edges, without the phrase the boundary scanner reads as an import.
  appendFileSync(join(root, "src/components/pikit/error-note.tsx"), '\nexport { ApiFailure } from "@/lib/api";\n');
  appendFileSync(join(root, "src/components/bui/Button.tsx"), '\nexport { useChats } from "../../lib/chats.tsx";\n');
  appendFileSync(join(root, "src/lib/format.ts"), '\nexport type { ApiUsage } from "./admin-api.ts";\n');
  appendFileSync(join(root, "src/components/pikit/message.tsx"), '\nexport { Segmented } from "@/components/pikit/settings";\n');
  appendFileSync(join(root, "src/components/pikit/conversation.tsx"), '\nexport { adminSource } from "@/views/conversations/source";\n');

  expect(sharedUiViolations(root)).toEqual([
    { file: "src/components/bui/Button.tsx", specifier: "../../lib/chats.tsx" },
    { file: "src/components/pikit/conversation.tsx", specifier: "@/views/conversations/source" },
    { file: "src/components/pikit/error-note.tsx", specifier: "@/lib/api" },
    { file: "src/components/pikit/message.tsx", specifier: "@/components/pikit/settings" },
    { file: "src/lib/format.ts", specifier: "./admin-api.ts" },
  ]);
});

test("every file of src/lib/ is in exactly one of lib-ui and admin-client (shadcn's utils in neither)", () => {
  const files = readdirSync(join(DASHBOARD, "src/lib")).sort();
  const listed = [...LIB_UI, ...ADMIN_CLIENT, SHADCN_UTILS];

  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual(files);
});

test("the shared pieces' OPERATOR_NOTE is admin-api's (admin-api.ts imports nothing, so it cannot re-export it)", () => {
  expect(OPERATOR_NOTE).toBe(API_OPERATOR_NOTE);
  expect(readFileSync(join(DASHBOARD, "src/lib/admin-api.ts"), "utf8")).not.toMatch(/\bfrom\s+["']/);
});
