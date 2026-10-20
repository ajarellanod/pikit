/**
 * The Context panel (Beautiful UI's right-hand pane, as its harness shows retrieved chunks): what a
 * conversation's transcript holds besides its words, as far as it is read: the images sent in it and
 * its sources (`lib/sources.ts`), or an empty state; an image opens bigger (`ImageViewer`). And the button that opens it (`ContextButton`),
 * which a page puts in its header. By props only: the dashboard and channel-web's chat show it alike.
 */

import { MediaImage, SidebarExpand, Xmark } from "iconoir-react";
import { useState } from "react";
import ContextCards, { ContextHeader } from "@/components/bui/ContextCards";
import EmptyState from "@/components/bui/EmptyState";
import { ImageViewer, ViewableImage } from "@/components/pikit/image-viewer";
import type { SentImage, Source } from "@/lib/sources";

/** Opens or closes the Context panel (wide screens only, as the panel). */
export function ContextButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label="Context"
      aria-pressed={open}
      title="Context: the images sent here, and what its web searches and fetches found"
      onClick={onToggle}
      className={`hidden size-7 items-center justify-center rounded-[7px] transition-colors duration-100 lg:flex ${open ? "bg-hover-2 text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
    >
      <SidebarExpand width={16} height={16} strokeWidth={1.9} />
    </button>
  );
}

export function ContextPanel({ images, sources, onClose }: { images: SentImage[]; sources: Source[]; onClose: () => void }) {
  const [viewing, setViewing] = useState<number>();
  const viewed = images.map((image, i) => ({
    src: image.src,
    alt: `Image ${i + 1}`,
    caption: [image.mimeType, image.at === undefined ? undefined : `sent ${new Date(image.at).toLocaleString()}`].filter((part) => part !== undefined).join(", ") || undefined,
  }));
  return (
    <aside aria-label="Context" className="hidden w-[360px] shrink-0 flex-col overflow-hidden rounded-window border border-line bg-page lg:flex" style={{ animation: "fade-in 300ms ease both" }}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3 sm:pl-4">
        <span className="text-[13px] font-semibold text-ink">Context</span>
        <button type="button" aria-label="Close the context" onClick={onClose} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink">
          <Xmark width={15} height={15} strokeWidth={2} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {images.length === 0 && sources.length === 0 ? (
          <EmptyState icon={<MediaImage />} title="Nothing here yet" hint="The images sent in this conversation, and what its web searches and fetches found, show here." />
        ) : (
          <div className="flex flex-col gap-6">
            {images.length > 0 && (
              <section className="flex flex-col gap-2">
                <ContextHeader title="Attachments" count={images.length} />
                <div className="grid grid-cols-3 gap-2">
                  {images.map((image, i) => (
                    <ViewableImage
                      key={image.key}
                      image={viewed[i] ?? { src: image.src, alt: `Image ${i + 1}` }}
                      onOpen={() => setViewing(i)}
                      frameClassName="w-full rounded-card"
                      className="aspect-square w-full rounded-card bg-inset object-cover shadow-card"
                      style={{ animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 8) * 60}ms both` }}
                    />
                  ))}
                </div>
                <ImageViewer images={viewed} index={viewing} onIndex={setViewing} onClose={() => setViewing(undefined)} />
              </section>
            )}
            {sources.length > 0 && <ContextCards header="Sources" chunks={sources} />}
          </div>
        )}
      </div>
    </aside>
  );
}
