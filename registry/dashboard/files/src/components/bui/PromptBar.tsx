import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/* ---------------------------------------------------------
 * PROMPT BAR
 * Beautiful UI's hero composer: a multi-line input with its
 * controls on their own row. Here its picker chooses something
 * real (an agent) or names it, and while a run goes the send
 * button stops it. Enter sends, Shift+Enter breaks a line.
 * --------------------------------------------------------- */

function Icon({ children, size = 15, strokeWidth = 1.8 }: { children: ReactNode; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export type PickerOption = { key: string; name: string; tag?: string };

export type Picker = {
  /** what it chooses, for its label: "agent" */
  label: string;
  options: PickerOption[];
  value: string | undefined;
  /** absent: the value is shown, not chosen */
  onChange?: (key: string) => void;
};

export default function PromptBar({
  placeholder,
  picker,
  onSend,
  busy = false,
  onStop,
  disabled = false,
  autoFocus = false,
}: {
  placeholder?: string;
  picker?: Picker;
  /** sends the text; the draft is cleared once it resolves, kept when it throws */
  onSend: (text: string) => Promise<void> | void;
  /** a run is going: with an empty draft, the send button stops it */
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelBox, setModelBox] = useState<{ top: number; height: number } | null>(null);
  const [modelHovered, setModelHovered] = useState<number | null>(null);
  const [modelMenuLeft, setModelMenuLeft] = useState(0);
  const [modelMenuBottom, setModelMenuBottom] = useState(0);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modelRowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const options = picker?.options ?? [];
  const choosable = picker?.onChange !== undefined && options.length > 1;
  const chosen = options.find((option) => option.key === picker?.value);

  /* the gliding highlight floats to the hovered row, falling back to the chosen one */
  const modelIndex = options.findIndex((option) => option.key === picker?.value);
  useLayoutEffect(() => {
    if (!modelOpen) return;
    const target = modelRowRefs.current[modelHovered ?? modelIndex];
    if (target) setModelBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [modelOpen, modelHovered, modelIndex]);

  /* the menu sits outside the clipped composer: align it to the trigger by measurement */
  useLayoutEffect(() => {
    if (!modelOpen || !composerAnchorRef.current || !modelRef.current) return;
    const anchorRect = composerAnchorRef.current.getBoundingClientRect();
    const triggerRect = modelRef.current.getBoundingClientRect();
    setModelMenuLeft(Math.max(0, Math.min(triggerRect.left - anchorRect.left, anchorRect.width - 176)));
    setModelMenuBottom(anchorRect.bottom - triggerRect.top + 8);
  }, [modelOpen]);

  useEffect(() => {
    if (!modelOpen) setModelHovered(null);
  }, [modelOpen]);

  /* grow with the text, to a compact maximum */
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const maxHeight = 200;
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  /* clicking anywhere outside the composer closes the menu */
  useEffect(() => {
    if (!modelOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-promptbar]")) setModelOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen]);

  const canSend = draft.trim().length > 0 && !sending && !disabled;
  const stopping = busy && onStop !== undefined && draft.trim().length === 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setModelOpen(false);
    try {
      await onSend(draft.trim());
      setDraft("");
    } catch {
      // The caller says why; the draft stays.
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div data-promptbar className="w-full">
      <div ref={composerAnchorRef} className="relative">
        {/* -- picker menu -- */}
        {modelOpen && (
          <div
            onMouseLeave={() => setModelHovered(null)}
            className="absolute z-10 w-44 rounded-[10px] bg-surface p-1 shadow-raised"
            style={{ left: modelMenuLeft, bottom: modelMenuBottom, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
              style={{
                top: modelBox?.top ?? 0,
                height: modelBox?.height ?? 0,
                opacity: modelBox && modelHovered !== null ? 1 : 0,
                transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
              }}
            />
            {options.map((option, i) => (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={option.key === picker?.value}
                ref={(el) => {
                  modelRowRefs.current[i] = el;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setModelHovered(i)}
                onClick={() => {
                  picker?.onChange?.(option.key);
                  setModelOpen(false);
                  inputRef.current?.focus();
                }}
                className="relative z-10 flex h-7.5 w-full items-center gap-2 rounded-[6px] px-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{option.name}</span>
                {option.tag !== undefined && <span className="shrink-0 text-[11px] text-ink-3">{option.tag}</span>}
                <span className={`shrink-0 text-ink ${option.key === picker?.value ? "" : "invisible"}`}>
                  <Icon size={13} strokeWidth={2.5}>
                    <path d="M20 6L9 17l-5-5" />
                  </Icon>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* -- composer -- */}
        <div className="relative isolate flex flex-col gap-2.5 overflow-hidden rounded-[22px] border border-line bg-surface p-3.5 shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-line-strong">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_28px] items-end gap-x-1 gap-y-1.5">
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              autoFocus={autoFocus}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setModelOpen(false);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={placeholder ?? "Write a message…"}
              aria-label="Message"
              className="col-span-full col-start-1 row-start-1 min-h-[68px] w-full min-w-0 resize-none bg-transparent px-2 py-2 text-[14px] leading-5 text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 disabled:opacity-60"
            />

            {/* picker */}
            {picker !== undefined ? (
              <button
                ref={modelRef}
                type="button"
                aria-expanded={choosable ? modelOpen : undefined}
                aria-label={choosable ? `Choose the ${picker.label}` : `The ${picker.label}`}
                disabled={!choosable}
                onClick={() => setModelOpen((current) => !current)}
                className="col-start-1 row-start-2 flex h-7 shrink-0 items-center gap-1 justify-self-start rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 enabled:hover:bg-hover enabled:hover:text-ink"
              >
                {chosen?.name ?? picker.value ?? `No ${picker.label}`}
                {choosable && (
                  <span className="text-ink-3">
                    <Icon size={11} strokeWidth={2.4}>
                      <path d="M6 9l6 6 6-6" />
                    </Icon>
                  </span>
                )}
              </button>
            ) : (
              <span className="col-start-1 row-start-2" />
            )}

            {/* send, or stop while a run goes */}
            <button
              type="button"
              aria-label={stopping ? "Stop the run" : "Send"}
              title={stopping ? "Stop the run" : busy ? "Send: it runs after the run going" : "Send"}
              disabled={!stopping && !canSend}
              onClick={stopping ? onStop : () => void send()}
              className="col-start-3 row-start-2 flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]"
              style={{
                background: canSend || stopping ? "var(--ink)" : "var(--line-strong)",
                color: canSend || stopping ? "var(--surface)" : "var(--ink-2)",
              }}
            >
              {stopping ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect width="10" height="10" rx="2" fill="currentColor" />
                </svg>
              ) : sending ? (
                <span className="size-3 rounded-full border-[1.5px] border-current border-t-transparent" style={{ animation: "spin 700ms linear infinite" }} />
              ) : (
                <Icon size={16} strokeWidth={2.4}>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </Icon>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
