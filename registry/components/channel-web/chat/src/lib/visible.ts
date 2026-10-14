/**
 * When the tab comes back: the signed-out screens read `GET /chat/api/config` again then, so a sign-up
 * mode the operator changed meanwhile shows without a reload. Pure (the document is passed in):
 * scripts/chat.test.ts checks it.
 */

/** What of `document` it needs (no DOM types: the kit's tests type-check it too). */
export type VisibleDocument = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

/** Calls `run` each time `doc` turns visible again (never at once); returns what stops it. */
export function onVisibleAgain(doc: VisibleDocument, run: () => void): () => void {
  let hidden = doc.visibilityState !== "visible";
  const changed = () => {
    if (doc.visibilityState !== "visible") hidden = true;
    else if (hidden) {
      hidden = false;
      run();
    }
  };
  doc.addEventListener("visibilitychange", changed);
  return () => doc.removeEventListener("visibilitychange", changed);
}
