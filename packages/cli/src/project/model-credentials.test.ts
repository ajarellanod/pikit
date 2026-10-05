import { expect, test } from "bun:test";
import { usedOnly } from "./model-credentials.ts";

test("only the providers an agent names need credentials; when that is not known, all do", () => {
  const checked = { ok: true as const, providers: { anthropic: false, faux: true }, store: "credentials-file" };

  expect(usedOnly(checked, new Set(["faux"]))).toEqual({ ok: true, providers: { faux: true }, store: "credentials-file", unused: ["anthropic"] });
  expect(usedOnly(checked, new Set())).toEqual({ ok: true, providers: {}, store: "credentials-file", unused: ["anthropic", "faux"] });
  expect(usedOnly(checked, undefined)).toEqual({ ...checked, unused: [] });
});
