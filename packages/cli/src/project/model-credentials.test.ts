import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyHint, apiKeyVariable, usedOnly } from "./model-credentials.ts";
import { emptyManifest, type InstalledComponent, writeProjectManifest } from "./pikit-json.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("only the providers an agent names need credentials; when that is not known, all do", () => {
  const checked = { ok: true as const, providers: { anthropic: false, faux: true }, store: "credentials-file", owners: {}, oauth: ["anthropic"] };
  const rest = { owners: {}, oauth: ["anthropic"] };

  expect(usedOnly(checked, new Set(["faux"]))).toEqual({ ok: true, providers: { faux: true }, store: "credentials-file", ...rest, unused: ["anthropic"] });
  expect(usedOnly(checked, new Set())).toEqual({ ok: true, providers: {}, store: "credentials-file", ...rest, unused: ["anthropic", "faux"] });
  expect(usedOnly(checked, undefined)).toEqual({ ...checked, unused: [] });
});

test("a provider's key variable is its component's first secret one, as pikit.json recorded the manifest; never a guess", () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-model-credentials-"));
  dirs.push(dir);
  const installed = (environment: InstalledComponent["environment"]): InstalledComponent => ({
    registry: "default",
    version: "0.0.0",
    requires: { pikit: "0.0.0" },
    addedDependencies: [],
    files: {},
    dependencies: {},
    environment,
  });
  const manifest = emptyManifest(undefined, undefined, ["server"]);
  manifest.components["provider-anthropic"] = installed([
    { name: "ANTHROPIC_API_KEY", secret: true, required: false },
    { name: "ANTHROPIC_OAUTH_TOKEN", secret: true, required: false },
  ]);
  manifest.components["provider-openai-compatible"] = installed([]);
  manifest.components["provider-two"] = installed([{ name: "ONE_API_KEY", secret: true, required: false }]);
  writeProjectManifest(dir, manifest);
  const checked = { owners: { anthropic: "provider-anthropic", ollama: "provider-openai-compatible", one: "provider-two", two: "provider-two" } };

  expect(apiKeyVariable(dir, checked, "anthropic")).toBe("ANTHROPIC_API_KEY");
  expect(apiKeyHint(dir, checked, "anthropic")).toBe("set ANTHROPIC_API_KEY in .env");
  // Its key's variable is config: the manifest cannot name it.
  expect(apiKeyVariable(dir, checked, "ollama")).toBeUndefined();
  expect(apiKeyHint(dir, checked, "ollama")).toBe("set its API key as provider-openai-compatible's README says");
  // One component, two providers: one list of variables cannot tell whose is whose.
  expect(apiKeyVariable(dir, checked, "one")).toBeUndefined();
  expect(apiKeyVariable(dir, checked, "unknown")).toBeUndefined();
});
