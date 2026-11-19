/**
 * What the operator does to a conversation from its menu (`ActionsMenu`), wherever it shows: the
 * sidebar's rows and the conversation's header (the tab bar's right end), as the conversation
 * directory says it is (`state`, `hidden`). Rename (a dialog: the title everyone sees); "Hide for me"
 * or "Show again" (this operator's list only); "Archive for everyone" or "Restore"; "Delete for
 * everyone" (confirmed first) or, once deleted, "Restore" (`useChats().act`, `rename`). Every view of
 * the directory honours what is done for everyone. The dashboard's own: it uses the admin client.
 */

import { Archive, EditPencil, Eye, EyeClosed, Trash, Undo } from "iconoir-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { ActionsMenuItem } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import { Field } from "@/components/bui/Field";
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
import { type ChatAction, NEW_CHAT, useChats } from "@/lib/chats";

export interface ChatActions {
  /** The menu's items for `conversation`, as it is now (its `state` and `hidden`). */
  actionsOf(conversation: ApiConversation): ActionsMenuItem[];
  /** What the last action that failed said. */
  error: Error | undefined;
  /** The rename and delete dialogs: rendered once, where the shell puts them. */
  dialogs: ReactNode;
}

/**
 * The actions, and their dialogs. `shown` is the conversation the page shows: hidden, archived or
 * deleted, it leaves (`onLeft`, the shell opens a fresh New chat).
 */
export function useChatActions({ shown, onLeft }: { shown: string | undefined; onLeft: () => void }): ChatActions {
  const chats = useChats();
  /** The conversation the operator asked to delete: confirmed first. */
  const [deleting, setDeleting] = useState<{ id: string; title: string }>();
  /** The conversation the operator is renaming, with the title the field starts with. */
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const [error, setError] = useState<Error>();

  const put = (id: string, action: ChatAction) => {
    setError(undefined);
    const leaving = action !== "unhide" && action !== "restore" && shown === id;
    chats.act(id, action).then(
      () => leaving && onLeft(),
      (thrown: unknown) => setError(thrown instanceof Error ? thrown : new Error(String(thrown))),
    );
  };

  const actionsOf = (conversation: ApiConversation): ActionsMenuItem[] => {
    const id = conversation.conversationId;
    const title = chats.titleOf(conversation);
    const rename: ActionsMenuItem = { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenaming({ id, title: title === NEW_CHAT ? "" : title }) };
    const restore: ActionsMenuItem = { key: "restore", label: "Restore", icon: <Undo />, onSelect: () => put(id, "restore") };
    if (conversation.state === "deleted") return [rename, restore];
    return [
      rename,
      conversation.hidden === true
        ? { key: "unhide", label: "Show again", icon: <Eye />, onSelect: () => put(id, "unhide") }
        : { key: "hide", label: "Hide for me", icon: <EyeClosed />, onSelect: () => put(id, "hide") },
      conversation.state === "archived" ? restore : { key: "archive", label: "Archive for everyone", icon: <Archive />, onSelect: () => put(id, "archive") },
      { key: "delete", label: "Delete for everyone", icon: <Trash />, danger: true, onSelect: () => setDeleting({ id, title }) },
    ];
  };

  const dialogs = (
    <>
      <AlertDialog open={deleting !== undefined} onOpenChange={(open) => !open && setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat for everyone?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.title}” is no longer listed anywhere, for you, other operators or its person, even if they write again: their next message starts a new chat. Nothing is erased; you can restore it from Deleted.
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
              Delete for everyone
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
            <AlertDialogDescription>The title everyone sees: here, in its tab, and in its chat.</AlertDialogDescription>
          </AlertDialogHeader>
          <Field label="Title" required>
            {(control) => (
              <input
                {...control}
                type="text"
                autoFocus
                maxLength={TITLE_MAX}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                placeholder="Deploy checklist"
                className="control w-full"
              />
            )}
          </Field>
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
