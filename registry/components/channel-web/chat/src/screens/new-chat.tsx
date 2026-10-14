/**
 * A new conversation: a greeting, the composer (text and images), and the last conversations to go
 * on with. The first message makes the conversation (`POST /chat/api/conversations`, with its own
 * request id), which opens with the message already in it.
 */

import { ChatBubble } from "iconoir-react";
import { type CSSProperties, useEffect, useState } from "react";
import PromptBar, { type ComposerMessage } from "@/components/bui/PromptBar";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatStartResponse } from "@/lib/chat-api";
import { post } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { imageLimits, messageProblem } from "@/lib/images";
import { chatPath, go } from "@/lib/location";
import { addSent, newRequestId } from "@/lib/outbox";
import { usePageTitle, useSession } from "@/lib/session";
import { titleOf } from "./layout";

/* the entrance (ms after mount): hello, question, composer, suggestions */
const REVEAL_TIMING = [170, 330, 400, 550];
const REVEAL = { offsetY: 23, blur: 17, duration: 800, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };
const SUGGESTED = 3;

function revealStyle(visible: boolean): CSSProperties {
  return {
    opacity: visible ? 1 : 0,
    transform: visible ? "translate3d(0, 0, 0)" : `translate3d(0, ${REVEAL.offsetY}px, 0)`,
    filter: visible ? "blur(0px)" : `blur(${REVEAL.blur}px)`,
    transition: ["opacity", "transform", "filter"].map((property) => `${property} ${REVEAL.duration}ms ${REVEAL.easing}`).join(", "),
  };
}

export function NewChatScreen() {
  const { config, me } = useSession();
  const conversations = useConversations();
  const [error, setError] = useState<Error>();
  const [stage, setStage] = useState(0);
  usePageTitle(config.name, "New chat");

  useEffect(() => {
    const timers = REVEAL_TIMING.map((at, i) => setTimeout(() => setStage(i + 1), at));
    return () => timers.forEach(clearTimeout);
  }, []);

  const start = async ({ text, images }: ComposerMessage) => {
    const chatImages = images.map(({ mimeType, data }) => ({ mimeType, data }));
    const problem = messageProblem(text, chatImages, config.target);
    if (problem !== undefined) {
      setError(new Error(problem));
      throw new Error(problem);
    }
    setError(undefined);
    const requestId = newRequestId();
    try {
      const started = await post<ChatStartResponse>("/conversations", { text, ...(chatImages.length > 0 && { images: chatImages }), requestId });
      addSent(started.id, { requestId: started.requestId, text, images: chatImages }, started.admission === "queued");
      conversations.reload();
      go(chatPath(started.id));
    } catch (thrown) {
      setError(asError(thrown));
      throw thrown;
    }
  };

  const first = me.user.name.trim().split(/\s+/)[0] ?? "";
  const recent = (conversations.items ?? []).slice(0, SUGGESTED);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-[720px] flex-col justify-center px-4 py-10 sm:px-8">
        <h1 className="text-[24px] font-normal tracking-[-0.02em] text-ink sm:text-[26px]">
          <span className="new-chat-reveal block text-ink-3" style={revealStyle(stage >= 1)}>
            Hello{first === "" ? "" : ` ${first}`}
          </span>
          <span className="new-chat-reveal block" style={revealStyle(stage >= 2)}>
            What can I help you with?
          </span>
        </h1>

        <div className="chat new-chat-reveal relative mt-7" style={revealStyle(stage >= 3)}>
          <PromptBar autoFocus placeholder={`Ask ${config.name} anything…`} images={imageLimits(config.target)} onSend={start} />
          {error !== undefined && (
            <div className="mt-3">
              <ErrorNote error={error} title="Not started" />
            </div>
          )}
        </div>

        <div className="new-chat-reveal mt-6 flex flex-col" style={revealStyle(stage >= 4)}>
          {recent.map((conversation) => (
            <a
              key={conversation.id}
              href={`#${chatPath(conversation.id)}`}
              className="-mx-2 flex items-center gap-3 rounded-control px-2 py-2.5 text-left text-[14px] text-ink transition-colors duration-150 hover:bg-hover"
            >
              <span className="flex w-[15px] shrink-0 justify-center text-ink-3">
                <ChatBubble width={15} height={15} strokeWidth={1.9} />
              </span>
              <span className="min-w-0 truncate">Continue “{titleOf(conversation)}”</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
