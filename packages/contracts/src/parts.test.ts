/**
 * `foldParts` and `messagePieces`: the one place a message's parts become what its transport sends.
 * The tests make their kinds by hand (a kind a component would declare on `AppMessageParts`), not
 * the contracts' own `question` (`question.test.ts`).
 */

import { expect, test } from "bun:test";
import type { ChannelTransport } from "./outbound.ts";
import { foldParts, type MessagePart, messagePieces } from "./parts.ts";

/** A part of a kind only the tests know. */
const part = (type: string, fallback: string, fields: Record<string, unknown> = {}): MessagePart => ({ type, fallback, ...fields }) as unknown as MessagePart;

/** A transport whose pieces are separated by `|`, drawing `draws`. */
const transport = (draws?: readonly string[]): Pick<ChannelTransport, "split" | "draws"> => ({ split: (text) => text.split("|"), ...(draws !== undefined && { draws }) });

test("foldParts: the parts a transport does not draw follow the text as their fallbacks, in order, a paragraph each; the drawn ones stay", () => {
  const card = part("card", "A card", { title: "t" });
  const question = part("question", "Pick one: yes, no");
  const note = part("note", "A note");
  expect(foldParts({ text: "The answer.", parts: [card, question, note] }, ["question"])).toEqual({ text: "The answer.\n\nA card\n\nA note", parts: [question] });
  expect(foldParts({ text: "The answer.", parts: [card, question] })).toEqual({ text: "The answer.\n\nA card\n\nPick one: yes, no", parts: [] });
  // No text, and an empty fallback, add no empty paragraph.
  expect(foldParts({ text: "  ", parts: [part("blank", ""), note] })).toEqual({ text: "A note", parts: [] });
  expect(foldParts({ text: "Only text." })).toEqual({ text: "Only text.", parts: [] });
});

test("messagePieces: folded before the split, so a fallback is cut like the text; the drawn parts go with the last piece only", () => {
  const question = part("question", "Pick one");
  expect(messagePieces(transport(), { text: "one|two", parts: [part("note", "three|four"), question] })).toEqual([
    { text: "one" },
    { text: "two\n\nthree" },
    { text: "four\n\nPick one" },
  ]);
  expect(messagePieces(transport(["question"]), { text: "one|two", parts: [question] })).toEqual([{ text: "one" }, { text: "two", parts: [question] }]);
});

test("messagePieces: drawn parts and no text are one piece of empty text; nothing to say is no piece", () => {
  const question = part("question", "Pick one");
  expect(messagePieces(transport(["question"]), { text: "", parts: [question] })).toEqual([{ text: "", parts: [question] }]);
  // Not drawn, the fallback is the message.
  expect(messagePieces(transport(), { text: "", parts: [question] })).toEqual([{ text: "Pick one" }]);
  expect(messagePieces(transport(), { text: "" })).toEqual([]);
  expect(messagePieces(transport(), { text: "", parts: [part("blank", "")] })).toEqual([]);
});
