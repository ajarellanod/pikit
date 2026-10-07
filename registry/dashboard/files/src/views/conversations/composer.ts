/**
 * What the home's and a conversation's composers share: the images it takes (admin-api's limits, the
 * smaller total on Cloudflare), whether the assistant can search the web, the attachments a message
 * sends, and the "/" commands, in order: `/new`, `/stop` (a run going), `/reset` (a conversation),
 * `/image`, `/search` (an assistant with the tool), `/assistant` (more than one), then one per view the
 * App shows, by its id.
 */

import type { Command, ComposerImage, ImageLimits } from "@/components/bui/PromptBar";
import { IMAGE_TYPES, MAX_DURABLE_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES, WEB_SEARCH_TOOL } from "@/lib/admin-api";
import type { ApiAgent, ApiApp, ApiAttachment } from "@/lib/api";
import { navigate } from "@/lib/router";
import type { View } from "@/lib/views";

export const imageLimits = (app: ApiApp): ImageLimits => ({
  types: IMAGE_TYPES,
  count: MAX_IMAGES,
  bytes: MAX_IMAGE_BYTES,
  ...(app.target === "durable" && { totalBytes: MAX_DURABLE_IMAGE_BYTES }),
});

/** Whether `agent` searches the web (it has `WEB_SEARCH_TOOL`), and why not. */
export function webSearchOf(agents: ApiAgent[] | undefined, agent: string | undefined): { available: boolean; unavailable: string } {
  const found = agents?.find((each) => each.name === agent);
  return {
    available: found?.tools.includes(WEB_SEARCH_TOOL) === true,
    unavailable: agents === undefined ? "The assistants are not read yet" : `${agent ?? "This assistant"} has no web search tool`,
  };
}

export const attachmentsOf = (images: ComposerImage[]): ApiAttachment[] => images.map(({ mimeType, data }) => ({ kind: "image", mimeType, data }));

export function composerCommands(options: {
  views: View[];
  newChat: () => void;
  /** Present while a run goes. */
  stop?: () => void;
  /** Present in a conversation that takes actions. */
  reset?: () => void;
  webSearch: boolean;
  /** More than one assistant to choose from. */
  assistants: boolean;
}): Command[] {
  const views = options.views
    .filter((view) => view.id !== "conversations")
    .map((view): Command => ({ name: view.id, description: `Open ${view.title}`, run: () => navigate(view.pages[0]?.path ?? `/${view.id}`) }));
  return [
    { name: "new", description: "Start a new chat", run: options.newChat },
    ...(options.stop === undefined ? [] : [{ name: "stop", description: "Stop the run going", run: options.stop }]),
    ...(options.reset === undefined ? [] : [{ name: "reset", description: "Reset this conversation", run: options.reset }]),
    { name: "image", description: "Add an image", control: "image" },
    ...(options.webSearch ? [{ name: "search", description: "Web search for the next message", control: "search" as const }] : []),
    ...(options.assistants ? [{ name: "assistant", description: "Choose the assistant", control: "assistant" as const }] : []),
    ...views,
  ];
}
