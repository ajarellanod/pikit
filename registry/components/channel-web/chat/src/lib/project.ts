/**
 * A project's page, apart from React: its API paths, and how it says who changed what (`ChatAuthor`,
 * `ChatChange`), people's initials (the avatars), sizes and the token meter. Pure: no `window`
 * (scripts/chat.test.ts checks it).
 */

import type { ChatAuthor, ChatChange, ChatPrincipal } from "./chat-api.ts";

/** The API path of project `id`, and of `rest` under it. */
export const projectApi = (id: string, rest = ""): string => `/projects/${encodeURIComponent(id)}${rest}`;

/** A principal's shown name: the name the channel gave, else its id. */
export const principalName = (principal: ChatPrincipal): string => principal.name?.trim() || principal.id;

/** Up to two initials of a name (`Ana García` → `AG`, `ana` → `A`); `?` for none. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._@-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words.slice(0, 2).map((word) => [...word][0]?.toLocaleUpperCase() ?? "");
  return letters.join("") || "?";
}

/** The chat a conversation key names (`web:<user>:<chat id>`), when it is one of this chat's. */
export function chatOfKey(key: string | undefined): { userId: string; chatId: string } | undefined {
  if (key === undefined || !key.startsWith("web:")) return undefined;
  const at = key.lastIndexOf(":");
  const chatId = key.slice(at + 1);
  const userId = key.slice(4, at);
  return at > 4 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(chatId) ? { userId, chatId } : undefined;
}

/** Who made a change, said in a few words: a person's name (`you` for `me`), an agent's, an operator, the App. */
export function authorName(author: ChatAuthor | undefined, me?: string): string {
  if (author === undefined) return "someone";
  switch (author.kind) {
    case "person":
      return author.principal.channel === "web" && author.principal.id === me ? "you" : principalName(author.principal);
    case "agent":
      return author.agent;
    case "operator":
      return "an operator";
    case "component":
      return author.name;
  }
}

/** Where a change came from, beyond who: an agent's chat and the person it answered; a person's command in a chat. `undefined`: a page. */
export function authorSource(author: ChatAuthor | undefined, me?: string): string | undefined {
  if (author === undefined) return undefined;
  if (author.kind === "agent") {
    const where = chatOfKey(author.conversation) !== undefined ? "in a chat" : "in a conversation elsewhere";
    return author.for === undefined ? where : `${where}, answering ${author.for.channel === "web" && author.for.id === me ? "you" : principalName(author.for)}`;
  }
  if (author.kind === "person" && author.conversation !== undefined) return chatOfKey(author.conversation) !== undefined ? "in a chat" : "in a conversation elsewhere";
  return undefined;
}

/** What each kind of item is called in a sentence. */
const KINDS: Record<string, string> = {
  project: "the project",
  member: "a member",
  instructions: "the instructions",
  document: "the document",
  link: "the link",
  rule: "the rule",
  note: "the note",
  summary: "the summary",
  preference: "the preference",
  file: "the file",
};

/** A change as one line: `ana added the rule “Target CPA 18 EUR”`, `you restored the file “brief.pdf”`. */
export function changeSentence(change: ChatChange, me?: string): string {
  const what = KINDS[change.item.kind] ?? `the ${change.item.kind}`;
  const title = change.redacted !== undefined ? "(redacted)" : change.item.title;
  const named = change.item.kind === "project" || change.item.kind === "instructions" || title === "" ? what : `${what} “${title}”`;
  return `${authorName(change.by, me)} ${change.action} ${named}`;
}

/** Bytes, short: `512 B`, `12.3 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The core documents' share of their budget, 0 to 1, and whether `extra` more tokens fit. */
export function budgetOf(used: number, budget: number, extra = 0): { share: number; fits: boolean; left: number } {
  const left = budget - used;
  return { share: budget <= 0 ? 1 : Math.min(1, used / budget), fits: extra <= left, left: Math.max(0, left) };
}

/** Estimated tokens of a text, as the store counts them (`ceil(chars / 4)`). */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);
