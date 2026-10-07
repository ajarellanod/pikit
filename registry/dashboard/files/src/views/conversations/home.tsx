/**
 * The home: a new conversation of the dashboard's own. The operator picks one of the App's agents (in
 * the composer, where Beautiful UI picks a model) and writes the first message: `POST
 * /admin/api/conversations` makes `dashboard:<uuid>`, whose answers appear only here, and no other
 * channel can continue it. The suggestions below are real: the conversations last active, and the
 * views the App has.
 */

import { ChatBubble, Refresh } from "iconoir-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import PromptBar from "@/components/bui/PromptBar";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiStartResponse, post } from "@/lib/api";
import { agentsOf, channelOf, defaultAgentOf, useChats } from "@/lib/chats";
import { Link, navigate, pagePath } from "@/lib/router";
import { useShell } from "@/lib/shell";

/* -- the entrance (ms after mount): hello, question, composer, suggestions -- */
const HOME_REVEAL_TIMING = [170, 330, 400, 550];
const HOME_REVEAL = { offsetY: 23, blur: 17, duration: 800, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };

function homeRevealStyle(visible: boolean): CSSProperties {
  return {
    opacity: visible ? 1 : 0,
    transform: visible ? "translate3d(0, 0, 0)" : `translate3d(0, ${HOME_REVEAL.offsetY}px, 0)`,
    filter: visible ? "blur(0px)" : `blur(${HOME_REVEAL.blur}px)`,
    transition: ["opacity", "transform", "filter"].map((property) => `${property} ${HOME_REVEAL.duration}ms ${HOME_REVEAL.easing}`).join(", "),
  };
}

interface Suggestion {
  key: string;
  label: string;
  meta?: string;
  icon: ReactNode;
  to: string;
}

export function HomePage() {
  const { app, views, operator } = useShell();
  const chats = useChats();
  const agents = agentsOf(app);
  const [agent, setAgent] = useState<string>();
  const [error, setError] = useState<Error>();
  const [offset, setOffset] = useState(0);
  const [stage, setStage] = useState(0);
  const chosen = agent !== undefined && agents.includes(agent) ? agent : defaultAgentOf(app);
  const fallback = defaultAgentOf(app);

  useEffect(() => {
    const timers = HOME_REVEAL_TIMING.map((at, i) => setTimeout(() => setStage(i + 1), at));
    return () => timers.forEach(clearTimeout);
  }, []);

  const start = async (text: string) => {
    if (chosen === undefined) return;
    setError(undefined);
    try {
      const started = await post<ApiStartResponse>("/conversations", { agent: chosen, text });
      chats.setTitle(started.conversationId, text);
      chats.reload();
      navigate(pagePath("/conversations", started.conversationId));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      throw thrown;
    }
  };

  // The conversations last active and the App's views, taken in turn.
  const recent: Suggestion[] = (chats.items ?? [])
    .filter((conversation) => conversation.key !== undefined && conversation.current !== false)
    .slice(0, 6)
    .map((conversation) => ({
      key: `chat:${conversation.conversationId}`,
      label: `${conversation.busy ? "Follow" : "Continue"} ${chats.titleOf(conversation)}`,
      meta: channelOf(conversation.key),
      icon: <ChatBubble width={15} height={15} strokeWidth={1.9} />,
      to: pagePath("/conversations", conversation.conversationId),
    }));
  const pages: Suggestion[] = views
    .filter((view) => view.id !== "conversations")
    .map((view) => {
      const Icon = view.icon;
      return { key: `view:${view.id}`, label: `Open ${view.title}`, icon: Icon === undefined ? null : <Icon className="size-[15px]" />, to: view.pages[0]?.path ?? `/${view.id}` };
    });
  const pool: Suggestion[] = [];
  for (let i = 0; i < Math.max(recent.length, pages.length); i++) {
    if (recent[i] !== undefined) pool.push(recent[i] as Suggestion);
    if (pages[i] !== undefined) pool.push(pages[i] as Suggestion);
  }
  const shown = pool.length <= 3 ? pool : [0, 1, 2].map((i) => pool[(offset + i) % pool.length] as Suggestion);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-[720px] flex-col justify-center px-4 py-10 sm:px-8">
        <h1 className="text-[26px] font-normal tracking-[-0.02em] text-ink">
          <span className="home-reveal block text-ink-3" style={homeRevealStyle(stage >= 1)}>
            Hello{operator === undefined ? "" : ` ${operator}`}
          </span>
          <span className="home-reveal block" style={homeRevealStyle(stage >= 2)}>
            What can I help you with?
          </span>
        </h1>

        <div className="home-reveal relative mt-7" style={homeRevealStyle(stage >= 3)}>
          <PromptBar
            autoFocus
            placeholder={chosen === undefined ? "The App has no agent to talk to" : `Ask ${chosen} anything…`}
            disabled={chosen === undefined}
            picker={{
              label: "agent",
              options: agents.map((name) => ({ key: name, name, ...(name === fallback && agents.length > 1 && { tag: "default" }) })),
              value: chosen,
              onChange: setAgent,
            }}
            onSend={start}
          />
          {error !== undefined && (
            <div className="mt-3">
              <ErrorNote error={error} title="Not started" />
            </div>
          )}
        </div>

        <div className="home-reveal mt-6 flex flex-col" style={homeRevealStyle(stage >= 4)}>
          {shown.map((item) => (
            <Link key={item.key} to={item.to} className="-mx-2 flex items-center gap-3 rounded-control px-2 py-2.5 text-left text-[14px] text-ink transition-colors duration-150 hover:bg-hover">
              <span className="flex w-[15px] shrink-0 justify-center text-ink-3">{item.icon}</span>
              <span className="min-w-0 truncate">{item.label}</span>
              {item.meta !== undefined && <span className="shrink-0 text-[12.5px] text-ink-3">{item.meta}</span>}
            </Link>
          ))}
          <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 pl-0.5 text-[13px] text-ink-3">
            <span className="flex items-center gap-2 py-1">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="19" cy="12" r="1.7" />
              </svg>
              Only you see this conversation and its answers
            </span>
            {pool.length > 3 && (
              <button type="button" onClick={() => setOffset((current) => (current + 3) % pool.length)} className="flex items-center gap-2 py-1 transition-colors duration-150 hover:text-ink">
                <Refresh width={14} height={14} strokeWidth={2} />
                Shuffle suggestions
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
