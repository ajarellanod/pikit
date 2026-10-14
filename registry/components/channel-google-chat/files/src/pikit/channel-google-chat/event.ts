// Owner: skeleton (shared). The add-on event objects and the Chat REST types every module reads.
/**
 * What Google sends and what its Chat REST API takes and returns, as far as this channel reads them.
 *
 * - **Add-on event objects** (a Chat app built as a Google Workspace add-on, features/channel-google-
 *   chat.md "The app"): `commonEventObject`, `authorizationEventObject` and `chat`, whose one payload
 *   says what happened: `messagePayload` (a message to the app), `addedToSpacePayload`,
 *   `removedFromSpacePayload`, `buttonClickedPayload` (a card's button, a dialog's form). `chat.user`
 *   is who did it, `chat.space` where.
 * - **Chat REST types** (`https://chat.googleapis.com/v1`): `Message`, `Space`, `Thread`,
 *   `Attachment`, and `cardsV2` as far as this channel draws them.
 * - **Add-on responses**: what a route answers an event with (`{}`, a message to create or update, a
 *   dialog to open or close).
 *
 * Every field is optional where Google may leave it out, and unknown ones are kept: the parser
 * (`readEvent`) checks only what tells events apart, so a field Google adds breaks nothing.
 */

import type { JsonValue } from "@pikit/contracts";

// ---------------------------------------------------------------------------------------------------
// Chat REST resources

/** A user (`users/<id>`); `email` and `domainId` may be absent. */
export interface ChatUser {
  /** `users/<id>`: stable, the message's `actor.id`. */
  name: string;
  displayName?: string;
  email?: string;
  domainId?: string;
  /** `HUMAN` or `BOT`. */
  type?: "HUMAN" | "BOT" | (string & {});
  isAnonymous?: boolean;
}

/** `THREADED_MESSAGES`, `GROUPED_MESSAGES` (threads in a flat chat), or `UNTHREADED_MESSAGES` (no threads: a meeting's chat, an old group chat). */
export type SpaceThreadingState = "THREADED_MESSAGES" | "GROUPED_MESSAGES" | "UNTHREADED_MESSAGES" | "THREADING_STATE_UNSPECIFIED" | (string & {});

/** A space: a named space, a group chat or a DM (`spaceType`). */
export interface ChatSpace {
  /** `spaces/<id>`. */
  name: string;
  displayName?: string;
  /** `SPACE`, `GROUP_CHAT` or `DIRECT_MESSAGE`. */
  spaceType?: "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE" | (string & {});
  /** Deprecated by Google for `spaceType`, still sent: `ROOM` or `DM`. */
  type?: string;
  singleUserBotDm?: boolean;
  spaceThreadingState?: SpaceThreadingState;
}

/** A thread: `spaces/<id>/threads/<id>`. */
export interface ChatThread {
  name: string;
  threadKey?: string;
}

/** A mention, a slash command…: where in `text` (UTF-16 offsets). */
export interface ChatAnnotation {
  type?: "USER_MENTION" | "SLASH_COMMAND" | "RICH_LINK" | (string & {});
  startIndex?: number;
  length?: number;
  userMention?: { user?: ChatUser; type?: "ADD" | "MENTION" | (string & {}) };
}

/** A file on a message: uploaded to Chat (`attachmentDataRef`), or a Drive file (`driveDataRef`). */
export interface ChatAttachment {
  /** `spaces/<id>/messages/<id>/attachments/<id>`. */
  name?: string;
  contentName?: string;
  contentType?: string;
  /** What `media.download` takes (`resourceName`); absent for a Drive file. */
  attachmentDataRef?: { resourceName?: string; attachmentUploadToken?: string };
  driveDataRef?: { driveFileId?: string };
  thumbnailUri?: string;
  downloadUri?: string;
  source?: "DRIVE_FILE" | "UPLOADED_CONTENT" | (string & {});
}

/** A message's card (`cardsV2`): an id and a card. */
export interface CardWithId {
  cardId: string;
  card: Card;
}

/** A card (Google's `GoogleAppsCardV1Card`): a header and sections of widgets; a dialog's body too. */
export interface Card {
  header?: { title: string; subtitle?: string; imageUrl?: string; imageType?: "SQUARE" | "CIRCLE" };
  sections?: CardSection[];
  fixedFooter?: { primaryButton?: CardButton; secondaryButton?: CardButton };
  name?: string;
}

export interface CardSection {
  header?: string;
  collapsible?: boolean;
  uncollapsibleWidgetsCount?: number;
  widgets: CardWidget[];
}

/** What a button does: call the app back (`function`: the endpoint URL, with `parameters`), maybe as a dialog. */
export interface CardAction {
  function: string;
  parameters?: { key: string; value: string }[];
  /** `OPEN_DIALOG`: the click opens a dialog (the response's `pushCard`). */
  interaction?: "OPEN_DIALOG" | (string & {});
  loadIndicator?: "SPINNER" | "NONE";
}

export interface CardButton {
  text: string;
  onClick: { action?: CardAction; openLink?: { url: string } };
  disabled?: boolean;
  type?: "OUTLINED" | "FILLED" | "FILLED_TONAL" | "BORDERLESS" | (string & {});
}

/**
 * One widget. Each is an object with one key, its kind; only the kinds this channel draws are typed
 * (text, image, buttons, inputs, a divider), with the fields it sets.
 */
export interface CardWidget {
  textParagraph?: { text: string; maxLines?: number };
  decoratedText?: { text: string; topLabel?: string; bottomLabel?: string; wrapText?: boolean };
  image?: { imageUrl: string; altText?: string };
  buttonList?: { buttons: CardButton[] };
  divider?: Record<string, never>;
  textInput?: { name: string; label: string; type?: "SINGLE_LINE" | "MULTIPLE_LINE"; value?: string; hintText?: string };
  selectionInput?: {
    name: string;
    label: string;
    type: "CHECK_BOX" | "RADIO_BUTTON" | "SWITCH" | "DROPDOWN" | "MULTI_SELECT";
    items: { text: string; value: string; selected?: boolean }[];
  };
  dateTimePicker?: { name: string; label: string; type: "DATE_ONLY" | "DATE_AND_TIME" | "TIME_ONLY"; valueMsEpoch?: string };
  /** A table or code is drawn with `columns` or monospace text; anything else Google takes, untyped. */
  [kind: string]: JsonValue | undefined | object;
}

/** A message, as the API returns it and as `messages.create` / `patch` take it (`text`, `cardsV2`, `thread`). */
export interface ChatMessage {
  /** `spaces/<id>/messages/<id>`: `InboundMessage.id`. With a client id: `spaces/<id>/messages/client-…`. */
  name?: string;
  sender?: ChatUser;
  createTime?: string;
  lastUpdateTime?: string;
  text?: string;
  formattedText?: string;
  /** The text without the app's mention (and a slash command's name). */
  argumentText?: string;
  cardsV2?: CardWithId[];
  annotations?: ChatAnnotation[];
  thread?: ChatThread;
  space?: ChatSpace;
  attachment?: ChatAttachment[];
  /** A message this one quotes (a reply to it): read with `spaces.messages.get`. */
  quotedMessageMetadata?: { name?: string; lastUpdateTime?: string };
  /** Whether it is a reply in a thread (not the thread's first message). */
  threadReply?: boolean;
  clientAssignedMessageId?: string;
  slashCommand?: { commandId?: string };
}

// ---------------------------------------------------------------------------------------------------
// Add-on event objects

/** A form's input, as `commonEventObject.formInputs` carries it. */
export interface FormInput {
  stringInputs?: { value?: string[] };
  dateInput?: { msSinceEpoch?: string };
  dateTimeInput?: { msSinceEpoch?: string; hasDate?: boolean; hasTime?: boolean };
  timeInput?: { hours?: number; minutes?: number };
}

/** What every add-on event has, whatever its host app. */
export interface CommonEventObject {
  hostApp?: "CHAT" | (string & {});
  platform?: string;
  userLocale?: string;
  timeZone?: { id?: string; offset?: number };
  /** A button's `action.parameters`, by key. */
  parameters?: Record<string, string>;
  /** A form's inputs, by widget name. */
  formInputs?: Record<string, FormInput>;
  /** The `function` of the action clicked. */
  invokedFunction?: string;
}

export interface MessagePayload {
  message: ChatMessage;
  space?: ChatSpace;
  configCompleteRedirectUri?: string;
}

export interface AddedToSpacePayload {
  space: ChatSpace;
  /** Added by a mention or a message (`true`), not from the menu. */
  interactionAdd?: boolean;
  configCompleteRedirectUri?: string;
}

export interface RemovedFromSpacePayload {
  space: ChatSpace;
}

export interface ButtonClickedPayload {
  /** The message whose card was clicked; absent for a click in a dialog's own card. */
  message?: ChatMessage;
  space?: ChatSpace;
  isDialogEvent?: boolean;
  dialogEventType?: "REQUEST_DIALOG" | "SUBMIT_DIALOG" | "CANCEL_DIALOG" | (string & {});
}

/** The `chat` part of an add-on event: who, where, and the one payload that says what happened. */
export interface ChatEventObject {
  user?: ChatUser;
  space?: ChatSpace;
  eventTime?: string;
  messagePayload?: MessagePayload;
  addedToSpacePayload?: AddedToSpacePayload;
  removedFromSpacePayload?: RemovedFromSpacePayload;
  buttonClickedPayload?: ButtonClickedPayload;
}

/** An add-on event object, as Google posts it to the endpoint. */
export interface AddOnEvent {
  commonEventObject?: CommonEventObject;
  /** `systemIdToken` repeats the bearer token; `userOAuthToken` is never asked for. */
  authorizationEventObject?: { systemIdToken?: string; userOAuthToken?: string; userIdToken?: string };
  chat: ChatEventObject;
}

/** What an event is, by its payload. `other`: a payload this channel does not handle (a widget update, a command), acknowledged and dropped. */
export type EventKind = "message" | "added" | "removed" | "click" | "other";

/** `event`'s kind, by the payload it carries (a click first: a click carries its card's message too). */
export function eventKind(event: AddOnEvent): EventKind {
  const chat = event.chat;
  if (chat.buttonClickedPayload !== undefined) return "click";
  if (chat.messagePayload !== undefined) return "message";
  if (chat.addedToSpacePayload !== undefined) return "added";
  if (chat.removedFromSpacePayload !== undefined) return "removed";
  return "other";
}

/** The space an event happened in: its payload's, else `chat.space`, else its message's. */
export function spaceOf(event: AddOnEvent): ChatSpace | undefined {
  const chat = event.chat;
  return (
    chat.messagePayload?.space ??
    chat.addedToSpacePayload?.space ??
    chat.removedFromSpacePayload?.space ??
    chat.buttonClickedPayload?.space ??
    chat.space ??
    chat.messagePayload?.message.space ??
    chat.buttonClickedPayload?.message?.space
  );
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasName = (value: unknown, prefix: string): boolean => isObject(value) && typeof value.name === "string" && value.name.startsWith(prefix);

/**
 * `body` as an add-on event of Chat, or `undefined` when it is not one: an object with a `chat` object
 * whose payloads, where present, are objects (a message payload's `message` too) and whose spaces and
 * users, where present, are named (`spaces/…`, `users/…`). Tolerant: nothing else is checked, unknown
 * fields are kept, and an event of an unknown payload is `other`. The mailbox carries it as JSON, and
 * the object reads it back with this.
 */
export function readEvent(body: unknown): AddOnEvent | undefined {
  if (!isObject(body) || !isObject(body.chat)) return undefined;
  const chat = body.chat;
  if (body.commonEventObject !== undefined && !isObject(body.commonEventObject)) return undefined;
  if (chat.user !== undefined && !hasName(chat.user, "users/")) return undefined;
  if (chat.space !== undefined && !hasName(chat.space, "spaces/")) return undefined;
  for (const key of ["messagePayload", "addedToSpacePayload", "removedFromSpacePayload", "buttonClickedPayload"] as const) {
    const payload = chat[key];
    if (payload === undefined) continue;
    if (!isObject(payload)) return undefined;
    if (payload.space !== undefined && !hasName(payload.space, "spaces/")) return undefined;
  }
  if (chat.messagePayload !== undefined && !isObject((chat.messagePayload as Record<string, unknown>).message)) return undefined;
  for (const key of ["addedToSpacePayload", "removedFromSpacePayload"] as const) {
    if (chat[key] !== undefined && !hasName((chat[key] as Record<string, unknown>).space, "spaces/")) return undefined;
  }
  const clicked = chat.buttonClickedPayload as Record<string, unknown> | undefined;
  if (clicked?.message !== undefined && !isObject(clicked.message)) return undefined;
  return body as unknown as AddOnEvent;
}

// ---------------------------------------------------------------------------------------------------
// Add-on responses

/** What a route answers an event with. `{}` acknowledges and does nothing. */
export interface AddOnResponse {
  /** A message to create where the event happened, or the clicked message updated (the card answered). */
  hostAppDataAction?: {
    chatDataAction: {
      createMessageAction?: { message: ChatMessage };
      updateMessageAction?: { message: ChatMessage };
    };
  };
  /** A dialog: open one (`pushCard`), or close the one open (`endNavigation`), with a notice. */
  action?: {
    navigations?: ({ pushCard: Card } | { updateCard: Card } | { endNavigation: { action: "CLOSE_DIALOG" | "CLOSE_DIALOG_AND_EXECUTE" } })[];
    notification?: { text: string };
  };
}

/** The empty response: acknowledged, nothing to show. */
export const ACKNOWLEDGED: AddOnResponse = {};
