import { ChatBubble } from "iconoir-react";
import { defineView } from "@/lib/views";
import { ConversationPage } from "./conversation";
import { CONVERSATIONS_PATH, ConversationsPage } from "./list";
import { NewChatPage } from "./new-chat";

/**
 * The chat: New chat (`/conversations`: a new conversation of the dashboard's own), every
 * conversation (`/conversations/:id`), and the list of them all (`/conversations/all`, before `:id`:
 * the first page that matches is shown). The shell lists the latest in its sidebar and tabs, and links
 * the list ("Conversations", "View all"), not as a view.
 */
export default defineView({
  id: "conversations",
  title: "Chats",
  icon: ChatBubble,
  requires: ["agent.observe"],
  order: 10,
  pages: [
    { path: "/conversations", component: NewChatPage, fill: true },
    { path: CONVERSATIONS_PATH, component: ConversationsPage, fill: true },
    { path: "/conversations/:id", component: ConversationPage, fill: true },
  ],
});
