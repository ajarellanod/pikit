/**
 * The shared attachments protocol (`attachments.ts`): safe paths, bounds, what goes where, and the
 * write that fails the message. Channels test their own part against their fake platform.
 */

import { expect, test } from "bun:test";
import { defineApp, silentLogger } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type AttachmentLimits, type AttachmentSource, AttachmentTooLarge, collectAttachments, readBounded, safeName, writeAttachments } from "./attachments.ts";

const ctx = (await defineApp({ components: [], logger: silentLogger }).create()).context();
const signal = new AbortController().signal;
const LIMITS: AttachmentLimits = { perMessage: 10, bytesEach: 100, bytesTotal: 150, imageBytes: 20, textChars: 10 };
const conversation: ConversationRef = { key: "test:1", agent: "a", conversationId: "c1", channel: "test" };

/** A file whose download serves `content` (bounded as a platform would), counting downloads. */
function file(name: string, content: string | Uint8Array, contentType = "application/pdf") {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const source: AttachmentSource & { downloads: number[] } = {
    name,
    contentType,
    downloads: [],
    async download(most) {
      source.downloads.push(most);
      if (bytes.byteLength > most) throw new AttachmentTooLarge();
      return { bytes, contentType };
    },
  };
  return source;
}

/** An `ExecutionEnv` that keeps files in memory (only what writeAttachments calls), or fails writing. */
function memoryEnv(options: { failWrites?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const env = {
    createDir: async () => ({ ok: true, value: undefined }),
    writeFile: async (path: string, content: string | Uint8Array) => {
      if (options.failWrites) return { ok: false, error: Object.assign(new Error("no space left on device"), { code: "unknown" }) };
      files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
      return { ok: true, value: undefined };
    },
  } as unknown as ExecutionEnv;
  return { env, files };
}

test("names are one safe path segment: no ../, no slash, no NUL, no leading dot; long ones cut, their extension kept", () => {
  expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
  expect(safeName("..")).toBe("file");
  expect(safeName("a\u0000b.pdf")).toBe("a_b.pdf");
  expect(safeName("dir\\x.pdf")).toBe("dir_x.pdf");
  expect(safeName(".env")).toBe("env");
  expect(safeName("informe final (v2).pdf")).toBe("informe final _v2_.pdf");
  expect(safeName(`${"a".repeat(200)}.pdf`)).toBe(`${"a".repeat(96)}.pdf`);
  expect(safeName(undefined, "message")).toBe("message");
});

test("other files go to attachments/<message id>/, two of one name numbered; the same message again gives the same paths", async () => {
  const sources = () => [file("../same.pdf", "a"), file("../same.pdf", "b"), file("", "c", "")];
  const options = { messageId: "../42", limits: LIMITS, canWrite: true, label: "test" };
  const first = await collectAttachments(sources(), options, ctx, signal);
  expect(first.files.map((each) => each.path)).toEqual(["attachments/_42/_same.pdf", "attachments/_42/_same-2.pdf", "attachments/_42/file 3"]);
  expect(first.text).toBe(
    [
      "Files attached to this message:",
      "- ../same.pdf (application/pdf, 1 bytes): saved in your workspace at attachments/_42/_same.pdf",
      "- ../same.pdf (application/pdf, 1 bytes): saved in your workspace at attachments/_42/_same-2.pdf",
      "- file 3 (a file, 1 bytes): saved in your workspace at attachments/_42/file 3",
    ].join("\n"),
  );
  const again = await collectAttachments(sources(), options, ctx, signal);
  expect(again.files.map((each) => each.path)).toEqual(first.files.map((each) => each.path));
});

test("bounds: files per message, bytes each, bytes in all, images and text in all; each download asked for no more than is left", async () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const big = file("big.pdf", "x".repeat(101));
  const ok = file("ok.pdf", "y".repeat(90));
  const more = file("more.pdf", "z".repeat(90));
  const image = file("a.png", PNG, "image/png");
  const image2 = file("b.png", PNG, "image/png");
  const text = file("notes.txt", "0123456789abc", "text/plain");
  const text2 = file("more.txt", "x", "text/plain");
  const read = await collectAttachments([big, ok, more, image, image2, text, text2, file("eight.pdf", "")], { messageId: "m", limits: { ...LIMITS, perMessage: 7 }, canWrite: true, label: "test" }, ctx, signal);
  expect(read.text.split("\n").slice(1, 8)).toEqual([
    "- big.pdf: not read (larger than the 100 bytes a file may be)",
    "- ok.pdf (application/pdf, 90 bytes): saved in your workspace at attachments/m/ok.pdf",
    "- more.pdf: not read (past what is left of the 150 bytes a message may bring)",
    "- a.png: an image, shown to you",
    "- b.png: not read (past the 20 bytes of images a message may bring)",
    "- notes.txt: its text is below, cut",
    "- more.txt: not read (past the 10 characters of text files a message may bring)",
  ]);
  expect(read.text).toContain("- eight.pdf: not read (only the first 7 files of a message are read)");
  expect(read.text).toContain("File notes.txt (its first 10 characters of 13):\n```\n0123456789\n```");
  expect([big.downloads, ok.downloads, more.downloads, image.downloads, image2.downloads]).toEqual([[100], [100], [60], [20], [8]]);
  expect(read.images).toHaveLength(1);
  expect(read.files.map((each) => each.path)).toEqual(["attachments/m/ok.pdf"]);
});

test("without imageBytes and textChars, images and text files are written like any other file", async () => {
  const read = await collectAttachments([file("a.png", "png", "image/png"), file("b.txt", "hi", "text/plain")], { messageId: "m", limits: { perMessage: 10, bytesEach: 100, bytesTotal: 150 }, canWrite: true, label: "test" }, ctx, signal);
  expect(read.images).toEqual([]);
  expect(read.files.map((each) => each.path)).toEqual(["attachments/m/a.png", "attachments/m/b.txt"]);
});

test("with no workspace a file is named as not read and never downloaded; a failed download is named, the message still goes", async () => {
  const pdf = file("a.pdf", "%PDF");
  const bare = await collectAttachments([pdf], { messageId: "m", limits: LIMITS, canWrite: false, label: "test" }, ctx, signal);
  expect(bare.text).toBe("Files attached to this message:\n- a.pdf: not read (no workspace is installed to keep files in)");
  expect(pdf.downloads).toEqual([]);

  const broken: AttachmentSource = { name: "gone.pdf", download: async () => Promise.reject(new Error("502")) };
  const said = await collectAttachments([broken, { name: "link", unreadable: "a link, not a file", download: () => Promise.reject(new Error("never")) }], { messageId: "m", limits: LIMITS, canWrite: true, problemOf: () => "the platform refused it", label: "test" }, ctx, signal);
  expect(said.text.split("\n").slice(1)).toEqual(["- gone.pdf: not read (the platform refused it)", "- link: not read (a link, not a file)"]);
});

test("writeAttachments: into the conversation's workspace when there is one, else execution; nowhere, or a failed write, rejects", async () => {
  const files = [{ path: "attachments/X/a.bin", bytes: new Uint8Array([1]), contentType: undefined }];
  const workspace = memoryEnv();
  const execution = memoryEnv();
  await writeAttachments(files, conversation, { workspace: { resolve: async () => ({ env: workspace.env }) }, execution: execution.env }, ctx, "test");
  expect([...workspace.files.keys()]).toEqual(["attachments/X/a.bin"]);
  expect(execution.files.size).toBe(0);
  await writeAttachments(files, conversation, { workspace: undefined, execution: execution.env }, ctx, "test");
  expect([...execution.files.keys()]).toEqual(["attachments/X/a.bin"]);
  await expect(writeAttachments(files, conversation, { workspace: undefined, execution: undefined }, ctx, "test")).rejects.toThrow(/nowhere to be written/);
  await expect(writeAttachments(files, conversation, { workspace: undefined, execution: memoryEnv({ failWrites: true }).env }, ctx, "test")).rejects.toThrow(/could not be written/);
  await writeAttachments([], conversation, { workspace: undefined, execution: undefined }, ctx, "test");
});

test("readBounded: a body past its bound, said or streamed, is AttachmentTooLarge", async () => {
  expect(await readBounded(new Response("abc"), 3)).toEqual(new TextEncoder().encode("abc"));
  await expect(readBounded(new Response("abcd", { headers: { "content-length": "4" } }), 3)).rejects.toBeInstanceOf(AttachmentTooLarge);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2));
      controller.enqueue(new Uint8Array(2));
      controller.close();
    },
  });
  await expect(readBounded(new Response(stream), 3)).rejects.toBeInstanceOf(AttachmentTooLarge);
});
