import { expect, test } from "bun:test";
import { cutText, isTextType, mediaTypeOf, textOf } from "./document-convert.ts";
import { mayTrash, spaceFileDescriptionProblem, spaceFileNameProblem } from "./space-files.ts";

test("a saved file's name: one line, not a path", () => {
  expect(spaceFileNameProblem("brief 2027.pdf")).toBeUndefined();
  for (const bad of ["", ".", "..", "a/b", "a\\b", " lead", "tab\there", "x".repeat(256)]) expect(spaceFileNameProblem(bad)).toBeDefined();
  expect(spaceFileDescriptionProblem("The brief")).toBeUndefined();
  expect(spaceFileDescriptionProblem(" ")).toBeDefined();
});

test("an agent trashes only what agents alone saved; people anything", () => {
  const agent = { kind: "agent" as const, agent: "trader", conversation: "k" };
  const person = { kind: "person" as const, principal: { channel: "web", id: "u1" } };
  expect(mayTrash(agent, [agent, agent])).toBe(true);
  expect(mayTrash(agent, [agent, person])).toBe(false);
  expect(mayTrash(person, [agent, person])).toBe(true);
  expect(mayTrash({ kind: "operator", id: "admin" }, [person])).toBe(true);
});

test("document.convert's helpers: media types, text, cutting", () => {
  expect(mediaTypeOf("Text/HTML; charset=utf-8")).toBe("text/html");
  expect(mediaTypeOf("not a type")).toBe("");
  for (const type of ["text/markdown", "text/csv", "application/json", "application/ld+json", "image/svg+xml"]) expect(isTextType(type)).toBe(true);
  for (const type of ["application/pdf", "image/png", ""]) expect(isTextType(type)).toBe(false);
  expect(textOf(new TextEncoder().encode("hola"))).toBe("hola");
  expect(textOf(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
  expect(textOf(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined();
  expect(cutText("short", 100)).toBe("short");
  const cut = cutText(`${"line of text\n".repeat(100)}`, 300);
  expect(cut.length).toBeLessThanOrEqual(300);
  expect(cut.endsWith("[cut: the document is longer]")).toBe(true);
});
