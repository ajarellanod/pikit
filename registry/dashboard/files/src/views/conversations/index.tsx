import { MessagesSquare } from "lucide-react";
import { defineView } from "@/lib/views";
import { ConversationPage } from "./conversation";
import { ConversationsPage } from "./list";

export default defineView({
  id: "conversations",
  title: "Conversations",
  icon: MessagesSquare,
  requires: ["agent.observe"],
  order: 10,
  pages: [
    { path: "/conversations", component: ConversationsPage },
    { path: "/conversations/:id", component: ConversationPage },
  ],
});
