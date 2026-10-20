/**
 * Images that open bigger: `ImageViewer` is the modal (the browser's own `<dialog>`: focus moves into it
 * and stays, Escape or a click beside the image closes it, the page behind is inert), with the others
 * of the set by the arrows (its buttons, or the keys ← →). `ViewableImage` is a thumbnail that opens it.
 * By props only: the dashboard and channel-web's chat show it alike (a message's images, the Context
 * panel's).
 */

import { NavArrowLeft, NavArrowRight, Xmark } from "iconoir-react";
import { type CSSProperties, useEffect, useRef } from "react";

export interface ViewedImage {
  src: string;
  alt: string;
  /** A line under it: its type, when it was sent. */
  caption?: string;
}

const CONTROL = "flex size-9 items-center justify-center rounded-full bg-surface text-ink-2 shadow-btn transition-[color,transform] duration-100 hover:text-ink active:scale-[0.94]";

/** `images[index]`, over the page; `index` undefined: closed. */
export function ImageViewer({ images, index, onIndex, onClose }: { images: readonly ViewedImage[]; index: number | undefined; onIndex: (index: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const image = index === undefined ? undefined : images[index];
  const open = image !== undefined;
  const many = images.length > 1;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const step = (by: number) => index !== undefined && onIndex((index + by + images.length) % images.length);

  return (
    <dialog
      ref={ref}
      aria-label="Image"
      // React passes a dialog's close up its tree: only this one's closes it.
      onClose={(event) => event.target === event.currentTarget && onClose()}
      onClick={(event) => !(event.target as Element).closest("img, button") && onClose()}
      onKeyDown={(event) => {
        if (!many || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 outline-none backdrop:bg-black/70 backdrop:backdrop-blur-[2px]"
    >
      {image !== undefined && (
        <div className="relative flex size-full flex-col items-center justify-center gap-3 p-4 sm:p-14">
          <img
            key={index}
            src={image.src}
            alt={image.alt}
            className="max-h-full min-h-0 max-w-full rounded-xl object-contain shadow-overlay"
            style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}
          />
          {(many || image.caption !== undefined) && (
            <p className="shrink-0 text-center text-[12.5px] text-white/80">{[many ? `${(index ?? 0) + 1} / ${images.length}` : undefined, image.caption].filter(Boolean).join(" · ")}</p>
          )}
          <button type="button" aria-label="Close" onClick={onClose} className={`absolute top-3 right-3 ${CONTROL}`}>
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
          {many && (
            <>
              <button type="button" aria-label="Previous image" onClick={() => step(-1)} className={`absolute top-1/2 left-3 -translate-y-1/2 ${CONTROL}`}>
                <NavArrowLeft width={18} height={18} strokeWidth={2} />
              </button>
              <button type="button" aria-label="Next image" onClick={() => step(1)} className={`absolute top-1/2 right-3 -translate-y-1/2 ${CONTROL}`}>
                <NavArrowRight width={18} height={18} strokeWidth={2} />
              </button>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}

/** A thumbnail that opens `image` in the viewer (`onOpen`): `className` sizes the image, `frameClassName` its button (rounded as it). */
export function ViewableImage({
  image,
  onOpen,
  className,
  frameClassName = "rounded-xl",
  style,
}: {
  image: ViewedImage;
  onOpen: () => void;
  className?: string;
  frameClassName?: string;
  style?: CSSProperties;
}) {
  return (
    <button type="button" aria-label={`View ${image.alt}`} title={image.caption} onClick={onOpen} className={`block min-w-0 shrink-0 cursor-zoom-in transition-opacity duration-100 hover:opacity-90 ${frameClassName}`} style={style}>
      <img src={image.src} alt={image.alt} loading="lazy" className={className} />
    </button>
  );
}
