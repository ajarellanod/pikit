/**
 * One message of a transcript, in pi-ai's JSON (the runtime's own words, SPEC §5): a person's
 * message, the agent's answer (text, thinking, tool calls), a tool's result. System messages
 * (instructions, tools) are folded away.
 */

import { Brain, ChevronRight, CircleAlert, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Text = { type: "text"; text: string };
type Thinking = { type: "thinking"; thinking: string; redacted?: boolean };
type Image = { type: "image"; mimeType: string; data: string };
type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type Message =
  | { role: "system"; content?: unknown; timestamp?: number }
  | { role: "user"; content: string | (Text | Image)[]; timestamp?: number }
  | { role: "assistant"; content: (Text | Thinking | ToolCall)[]; stopReason?: string; errorMessage?: string; timestamp?: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: (Text | Image)[]; isError?: boolean; timestamp?: number };

const time = (at: number | undefined) => (at === undefined ? undefined : new Date(at).toLocaleTimeString());

function Folded({ summary, icon, children, open }: { summary: string; icon?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-md border bg-muted/30 text-sm" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-muted-foreground select-none">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        {icon}
        <span className="truncate">{summary}</span>
      </summary>
      <div className="border-t px-3 py-2">{children}</div>
    </details>
  );
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cn("max-h-80 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words", className)}>{children}</pre>;
}

function parts(content: string | (Text | Image)[]) {
  if (typeof content === "string") return <p className="whitespace-pre-wrap break-words">{content}</p>;
  return content.map((part, i) =>
    part.type === "text" ? (
      <p key={i} className="whitespace-pre-wrap break-words">
        {part.text}
      </p>
    ) : (
      <img key={i} className="max-h-64 rounded-md border" alt="" src={`data:${part.mimeType};base64,${part.data}`} />
    ),
  );
}

export function MessageView({ message, streaming = false }: { message: Message; streaming?: boolean }) {
  switch (message.role) {
    case "system":
      return null;
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-primary-foreground">
            {parts(message.content)}
            {message.timestamp !== undefined && <div className="text-right text-[11px] opacity-60">{time(message.timestamp)}</div>}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[92%] space-y-2">
          {message.content.map((part, i) => {
            if (part.type === "text") {
              return (
                <p key={i} className="whitespace-pre-wrap break-words">
                  {part.text}
                  {streaming && i === message.content.length - 1 && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-middle" />}
                </p>
              );
            }
            if (part.type === "thinking") {
              return (
                <Folded key={i} summary={part.redacted === true ? "Thinking (redacted)" : "Thinking"} icon={<Brain className="size-3.5" />} open={streaming}>
                  <Pre className="text-muted-foreground">{part.thinking}</Pre>
                </Folded>
              );
            }
            return (
              <Folded key={i} summary={part.name} icon={<Wrench className="size-3.5" />}>
                <Pre>{JSON.stringify(part.arguments, null, 2)}</Pre>
              </Folded>
            );
          })}
          {message.errorMessage !== undefined && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <CircleAlert className="size-4" />
              {message.errorMessage}
            </div>
          )}
          {message.stopReason === "aborted" && <Badge variant="outline">aborted</Badge>}
          {message.timestamp !== undefined && !streaming && <div className="text-[11px] text-muted-foreground">{time(message.timestamp)}</div>}
        </div>
      );
    case "toolResult":
      return (
        <Folded
          summary={`${message.toolName} ${message.isError === true ? "failed" : "returned"}`}
          icon={message.isError === true ? <CircleAlert className="size-3.5 text-destructive" /> : <Wrench className="size-3.5" />}
        >
          <Pre>
            {message.content
              .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
              .join("\n")}
          </Pre>
        </Folded>
      );
  }
}
