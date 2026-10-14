// Owner: admission. channel-google-chat's section of the Settings dialog: each Chat app's `conversations` setting.
/**
 * What it edits (instance.ts `settingsSchemaOf`): per instance (`googlechat`, `googlechat:ops`), its
 * `conversations`: `default` (each thread a conversation, or the whole chat one) and `chats`, the spaces
 * that differ (`spaces/AAA` → `"thread"` or `"chat"`). Its defaults are the config's `conversations`. A
 * change applies to the next message: a conversation already going keeps its key.
 *
 * For now the schema's generic form (`SchemaSettings`), which shows no nested object, so nothing yet:
 * the admission work replaces it with a default per app and a list of chats to add and remove.
 */

import { ChatBubble } from "iconoir-react";
import { SchemaSettings } from "@/components/pikit/settings";
import { defineSettings } from "@/lib/settings";

function GoogleChatSettings() {
  return <SchemaSettings component="channel-google-chat" title="Conversations" />;
}

export default defineSettings({
  id: "channel-google-chat",
  title: "Google Chat",
  icon: ChatBubble,
  order: 20,
  requires: ["settings"],
  keywords: ["google chat", "threads", "conversations", "spaces", "chat"],
  component: GoogleChatSettings,
});
