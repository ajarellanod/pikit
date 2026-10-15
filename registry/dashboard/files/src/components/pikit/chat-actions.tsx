/**
 * What the operator does to a conversation from its menu (`ActionsMenu`), wherever it shows: the
 * sidebar's rows and the conversation's header (the tab bar's right end). Rename (a dialog), Archive or
 * Restore, Delete (confirmed first): the list only (`useChats().hide`, `rename`). The dashboard's own:
 * it uses the admin client.
 */

import { Archive, EditPencil, Trash, Undo } from "iconoir-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { ActionsMenuItem } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import { ErrorNote } from "@/components/pikit/error-note";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TITLE_MAX } from "@/lib/admin-api";
import type { ApiConversation } from "@/lib/api";
import { NEW_CHAT, useChats } from "@/lib/chats";

export interface ChatActions {
  /** The menu's items for `conversation`: Restore in place of Archive when it is `archived`. */
  actionsOf(conversation: ApiConversation, archived: boolean): ActionsMenuItem[];
  /** What the last action that failed said. */
  error: Error | undefined;
  /** The rename and delete dialogs: rendered once, where the shell puts them. */
  dialogs: ReactNode;
}

/**
 * The actions, and their dialogs. `shown` is the conversation the page shows: archived or deleted, it
 * leaves (`onLeft`, the shell opens a fresh New chat).
 */
export function useChatActions({ shown, onLeft }: { shown: string | undefined; onLeft: () => void }): ChatActions {
  const chats = useChats();
  /** The conversation the operator asked to delete: confirmed first. */
  const [deleting, setDeleting] = useState<{ id: string; title: string }>();
  /** The conversation the operator is renaming, with the title the field starts with. */
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const [error, setError] = useState<Error>();

  const put = (id: string, action: "archive" | "unarchive" | "delete") => {
    setError(undefined);
    const leaving = action !== "unarchive" && shown === id;
    chats.hide(id, action).then(
      () => leaving && onLeft(),
      (thrown: unknown) => setError(thrown instanceof Error ? thrown : new Error(String(thrown))),
    );
  };

  const actionsOf = (conversation: ApiConversation, archived: boolean): ActionsMenuItem[] => {
    const id = conversation.conversationId;
    const title = chats.titleOf(conversation);
    return [
      { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenaming({ id, title: title === NEW_CHAT ? "" : title }) },
      archived
        ? { key: "unarchive", label: "Restore", icon: <Undo />, onSelect: () => put(id, "unarchive") }
        : { key: "archive", label: "Archive", icon: <Archive />, onSelect: () => put(id, "archive") },
      { key: "delete", label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDeleting({ id, title }) },
    ];
  };

  const dialogs = (
    <>
      <AlertDialog open={deleting !== undefined} onOpenChange={(open) => !open && setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.title}” leaves the list for good. If its person writes again, it comes back with the new message.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting !== undefined) put(deleting.id, "delete");
                setDeleting(undefined);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameDialog chat={renaming} onClose={() => setRenaming(undefined)} rename={chats.rename} />
    </>
  );

  return { actionsOf, error, dialogs };
}

/** A chat's new title, the operator's: the field starts with its title, Enter saves (the API cleans it, as `/name` does). */
function RenameDialog({ chat, onClose, rename }: { chat: { id: string; title: string } | undefined; onClose: () => void; rename: (id: string, title: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<Error>();
  useEffect(() => {
    if (chat === undefined) return;
    setValue(chat.title);
    setSaving(false);
    setFailed(undefined);
  }, [chat]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (chat === undefined || value.trim() === "") return;
    setSaving(true);
    setFailed(undefined);
    try {
      await rename(chat.id, value.trim());
      onClose();
    } catch (thrown) {
      setFailed(thrown instanceof Error ? thrown : new Error(String(thrown)));
      setSaving(false);
    }
  };
  return (
    <AlertDialog open={chat !== undefined} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-[420px]">
        <form onSubmit={(event) => void submit(event)} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>Rename this chat</AlertDialogTitle>
            <AlertDialogDescription>The title the sidebar and its tab show.</AlertDialogDescription>
          </AlertDialogHeader>
          <input
            type="text"
            required
            autoFocus
            maxLength={TITLE_MAX}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="A title"
            aria-label="The chat's title"
            className="control w-full"
          />
          {failed !== undefined && <ErrorNote error={failed} title="Not renamed" />}
          <AlertDialogFooter>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={saving || value.trim() === ""}>
              {saving ? "Saving" : "Save"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
