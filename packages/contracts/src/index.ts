// Public surface of @pikit/contracts (SPEC §3): the vocabulary components share. Types, identities,
// names of events and pipelines, capability interfaces, two protocol functions (`admitInbound` in,
// `startAnswerDelivery` out: the paths every channel must get right, written and tested once, with
// `answerContent`, delivery's rule of what a run's answer is, for a channel to read rather than copy), how a
// message's parts fold into its text for a transport (`foldParts`, `messagePieces`), the `question` part
// shared by who asks and who draws it (`questionPart`, `answerText`), the check of what the contracts take as a JSON object (`isJsonObject`), the grammar of `http.route`
// keys (`parseHttpRouteKey`, `matchesHttpRoute`), who a conversation is with as an operator reads it
// (the `conversation.describe` pipeline: `describeStage`, `describeConversation`, `cleanParty`), the conversation directory's protocol (its
// viewers, order, cursor, titles: `parseViewer`, `directoryCursor`, `cleanTitle`) with the `conversation.audience` pipeline that says who
// belongs to which space (`audienceStage`, `audienceGrants`), and the envelopes of an actor's call and stream
// (`answerCall`, `callResult`, `answerStream`, `streamResult`), who changed what in a store's log (`Author`, `Change`, `parseAuthor`:
// change.ts) and the projects' contracts (`projects`, `space.files`, `principals`, `document.convert`, the agents' federated search's
// `ProjectSearchHit`), so that no provider has its own. No policy: what a protocol waits, retries and says
// is its caller's, passed in. Each contract has a stability level (SPEC K8); the capabilities'
// levels are in the catalogue (`packages/cli/src/registry/capabilities.ts`). What only Cloudflare
// components use (`WORKERS_HOST`) is in `@pikit/contracts/cloudflare`, not here.

export { defineAgent, isAgentName, isThinkingLevel, originOf, SKILL_TOOL, skillsProblem, spaceOf, stewardProblem, THINKING_LEVELS } from "./agent.ts";
export type {
  Admission,
  AgentConversations,
  AgentDefinition,
  AgentImage,
  AgentMessage,
  AgentPayloads,
  AgentRequest,
  AgentResult,
  AgentRuntime,
  AgentTool,
  ConversationOrigin,
  ConversationRef,
  PrepareContext,
  Sender,
  ThinkingLevel,
  TurnConfig,
  Usage,
} from "./agent.ts";
export type { AgentSkill } from "./skill.ts";
export { defineSkill, isSkillName, parseFrontmatter, skillProblem } from "./skill.ts";
export type { RunRequest, RunRequests } from "./run-requests.ts";
export { RUN_REQUESTS } from "./run-requests.ts";

export type { AgentDirectory, DirectoryAgent } from "./agent-directory.ts";

export type { AgentCommand, CommandAudience, CommandInfo, CommandLookup, CommandOutcome, CommandsAllowed } from "./command.ts";
export { allowedCommands, audienceOf, COMMAND_NAME, commandIsFor, commandOf, commandProblem, isCommandName, listAgentCommands, runAgentCommand } from "./command.ts";
export type { CompletionRequest, ModelComplete } from "./model.ts";
export type { ConversationDescriber, ConversationParty, DescribedConversation, PartyId } from "./conversation-describe.ts";
export { channelKindOf, cleanParty, describeConversation, describeStage, PARTY_LIMITS } from "./conversation-describe.ts";
export type {
  ConversationDirectory,
  DirectoryEntry,
  DirectoryErrorCode,
  DirectoryListState,
  DirectoryPermissions,
  DirectoryPosition,
  DirectoryQuery,
  DirectoryRole,
  EntryRef,
  EntryState,
  TitleSource,
  Viewer,
  ViewerChange,
  ViewerState,
} from "./conversation-directory.ts";
export {
  AUDIENCE_MAX,
  afterCursor,
  cleanTitle,
  compareDirectoryOrder,
  DIRECTORY_COUNT_MAX,
  DIRECTORY_PAGE_DEFAULT,
  DIRECTORY_PAGE_MAX,
  DIRECTORY_SEARCH_MAX,
  DirectoryError,
  directoryCursor,
  isEntryState,
  likePattern,
  listStateOf,
  matchesSearch,
  NOT_PEOPLE_CHANNELS,
  operatorPrincipal,
  parseDirectoryCursor,
  parseDirectoryQuery,
  parseViewer,
  permissionsOf,
  stillHidden,
  TITLE_MAX,
  TITLE_SOURCES,
  titleApplies,
  UNREAD_MAX,
  VIEWER_PRINCIPALS_MAX,
  viewerAuthor,
  viewerKey,
  viewerOwns,
  viewerPrincipals,
} from "./conversation-directory.ts";
export type { Audience, AudienceGrant, AudienceProvider } from "./conversation-audience.ts";
export { audienceGrants, audienceStage } from "./conversation-audience.ts";

export { AgentUnavailableError, admitInbound, isAgentUnavailable } from "./inbound.ts";
export type { AdmitOptions, AdmitOutcome, InboundMessage, InboundOutcome, RouteDecision } from "./inbound.ts";

export type { AgentState } from "./agent-state.ts";
export { AGENT_STATE } from "./agent-state.ts";
export { CONVERSATION } from "./conversation-context.ts";
export type { ConversationPlace, ConversationRegistry, ConversationReset } from "./conversations.ts";
export type { HttpRoute, HttpRouteKey } from "./http.ts";
export { CLIENT_ADDRESS_HEADER, compareHttpRoutes, matchesHttpRoute, parseHttpRouteKey, withClientAddress } from "./http.ts";
export type { SecretStore } from "./secrets.ts";
export { redactSecrets, SECRET_NAME_PATTERN, secretLikePaths } from "./secrets.ts";
export type { AgentObserver, ObservedConversation, ObservedEvent, ObservedFailure, ObservedLive, ObservedTool, TranscriptEntry } from "./observe.ts";
export type { JsonOp, JsonPath } from "./json-ops.ts";
export { applyOps, diffOps } from "./json-ops.ts";
export type { Page, PageRequest } from "./page.ts";
export type { AdminAuth, AdminSessions, Operator } from "./admin.ts";
export { ADMIN_CLIENT_HEADER } from "./admin.ts";
export type { ComponentHealth, HealthRegistry, HealthReporter, HealthSnapshot, HealthStatus } from "./health.ts";
export type { Settings, SettingsErrorCode, SettingsSchema, SettingsValue } from "./settings.ts";
export { credentialSettingProblem, SettingsError, secretSettingProblem } from "./settings.ts";
export type { GitHubAccess } from "./github.ts";
export type { EmailErrorCode, EmailMessage, EmailReceipt, EmailSender } from "./email.ts";
export { EmailError, emailErrorDetail, emailMessageProblem, isEmailAddress, isEmailFrom } from "./email.ts";
export { GITHUB_REPOSITORY, GITHUB_TOKEN_MIN_LIFE_MS, GitHubNotConnectedError, isGitHubNotConnected } from "./github.ts";
export type {
  ActionRefusal,
  ApproveOutcome,
  ApproveRequest,
  DeployRecord,
  ProposalCheck,
  ProposalChecks,
  ProposalDeploy,
  ProposalDetail,
  ProposalFile,
  ProposalList,
  Proposals,
  ProposalsCheck,
  ProposalsErrorCode,
  ProposalsRemote,
  ProposalsStatus,
  ProposalState,
  ProposalSummary,
  RejectOutcome,
  RejectRequest,
} from "./proposals.ts";
export { ProposalsError } from "./proposals.ts";
export type { JsonValue } from "./json.ts";
export { isJsonObject } from "./json.ts";
export type { KeyValueStorage, KeyValueStore, SqlDatabase, SqlRow, SqlStatements, SqlValue } from "./storage.ts";
export type { BlobEntry, BlobHash, BlobPage, BlobStorage, BlobStore, BlobStored, BlobStream, BlobStreamPutOptions, BlobValue } from "./blob.ts";
export {
  BLOB_LIST_LIMIT,
  BLOB_MAX_KEY,
  BLOB_MIN_MAX_BYTES,
  BlobChecksumError,
  blobStreamChunks,
  checkBlobPutStream,
  createBlobHash,
  BlobKeyError,
  blobKeyProblem,
  blobListLimit,
  blobNamespaceProblem,
  BlobTooLargeError,
  checkBlobKey,
  checkBlobNamespace,
  checkBlobPut,
} from "./blob.ts";
export type { CheckedSnapshotArchive, SnapshotManifest } from "./workspace-snapshot.ts";
export {
  checkSnapshotArchive,
  commitSnapshotManifest,
  deleteSnapshotsBefore,
  deleteSupersededSnapshots,
  openSnapshotStore,
  parseSnapshotArchiveKey,
  parseSnapshotManifest,
  putSnapshotArchive,
  readSnapshotArchive,
  SNAPSHOT_CONTENT_TYPE,
  SNAPSHOT_MANIFEST,
  SNAPSHOT_NAMESPACE,
  SNAPSHOT_VERSION,
  SnapshotArchiveRefused,
  snapshotArchiveKey,
  snapshotId,
  snapshotLinkStaysInside,
  snapshotManifestJson,
  snapshotManifestKey,
  SnapshotTarCheck,
} from "./workspace-snapshot.ts";
export type { Feed, FeedItem, FeedPage } from "./feed.ts";
export type {
  ActorCallErrorCode,
  ActorCallHandler,
  ActorCallOutcome,
  ActorInbox,
  ActorInboxHandler,
  ActorMailbox,
  ActorScope,
  ActorStreamHandler,
  ActorStreamOutcome,
} from "./actor.ts";
export { ActorCallError, answerCall, answerStream, callResult, streamResult } from "./actor.ts";
export type { WakeupHandler, Wakeups } from "./wakeups.ts";
export type { AgentSubmissions, PendingConversation, RunSettlement, SubmissionStatus } from "./submissions.ts";
export type {
  ChannelTransport,
  DeliveryErrorKind,
  DeliveryReceipt,
  OutboundMessage,
  OutboundPiece,
  OutboundQueue,
  PendingPiece,
} from "./outbound.ts";
export { answerKey, DeliveryError } from "./outbound.ts";
export type { AppMessageParts, MessageContent, MessagePart } from "./parts.ts";
export { foldParts, messagePieces, partProblem } from "./parts.ts";
export type { Question, QuestionAnswer, QuestionField, QuestionOption, QuestionPart, QuestionValue } from "./question.ts";
export { answerProblem, answerText, QUESTION_FIELD_KINDS, QUESTION_FIELD_NAME, questionPart, questionProblem } from "./question.ts";
export type { Author, Change, ChangeAction, ChangeItem, ChangePage, ChangePageRequest, Principal } from "./change.ts";
export {
  AUTHOR_PART_MAX,
  CHANGE_PAGE_MAX,
  CHANGE_RETENTION_DAYS,
  CHANGE_TITLE_MAX,
  ChangeInputError,
  changeTitle,
  parseAuthor,
  parseChangePageRequest,
  parsePrincipal,
  pastRetention,
  PRINCIPAL_NAME_MAX,
  principalKey,
  samePrincipal,
} from "./change.ts";
export type { Principals } from "./principals.ts";
export type {
  Caller,
  DocumentInput,
  DocumentMode,
  DocumentRead,
  Instructions,
  ItemVersion,
  Link,
  Member,
  MemberSync,
  NewProject,
  Project,
  ProjectContext,
  ProjectDocument,
  ProjectErrorCode,
  ProjectItemKind,
  ProjectItemRef,
  ProjectListQuery,
  ProjectRole,
  ProjectSearchHit,
  ProjectStore,
  ProjectUpdate,
} from "./projects.ts";
export {
  addedToProject,
  authorOf,
  CONTEXT_MEMBERS,
  CORE_TOKENS_DEFAULT,
  DOCUMENT_MAX,
  DOCUMENT_TITLE_MAX,
  estimateTokens,
  formatItemRef,
  INSTRUCTIONS_MAX,
  isProjectId,
  LINK_NOTE_MAX,
  LINK_URL_MAX,
  linkUrlProblem,
  memberIsCurrent,
  mergeSearchHits,
  OWNER_RESTORES,
  parseCaller,
  parseItemRef,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_DOCUMENTS_MAX,
  PROJECT_ITEM_KINDS,
  PROJECT_LINKS_MAX,
  PROJECT_NAME_MAX,
  PROJECT_SPACE_PREFIX,
  PROJECT_TEXT_MAX,
  PROJECT_TEXT_WITH_VERSIONS_MAX,
  PROJECT_TOMBSTONE_DAYS,
  ProjectError,
  projectNameProblem,
  PROJECTS_OWNED_MAX,
  projectSpace,
  READ_PART,
  restoreNeedsOwner,
  roleOfMembers,
  SEARCH_MAX,
  SEARCH_PART,
  STALE_AFTER_MS_DEFAULT,
} from "./projects.ts";
export type { ListedSpaceFile, NewSpaceFile, SpaceFile, SpaceFileMatch, SpaceFiles, SpaceFilesErrorCode, SpaceFilesUsage, SpaceFileText } from "./space-files.ts";
export {
  mayTrash,
  SPACE_FILE_DESCRIPTION_MAX,
  SPACE_FILE_NAME_MAX,
  SPACE_FILE_TEXT_PART,
  SPACE_FILES_LIST_MAX,
  SPACE_FILES_TRASH_DAYS,
  SpaceFilesError,
  spaceFileDescriptionProblem,
  spaceFileNameProblem,
} from "./space-files.ts";
export type { ConvertErrorCode, ConvertInput, DocumentConverter } from "./document-convert.ts";
export { CONVERT_MIN_MAX_BYTES, CONVERT_TEXT_MAX, ConvertError, cutText, isTextType, mediaTypeOf, TEXT_TYPES, textOf } from "./document-convert.ts";
export type { AnswerDelivery, AnswerDeliveryOptions, DeliveryPolicy } from "./delivery.ts";
export { answerContent, answersOnlyTheDashboard, DASHBOARD_REQUEST_PREFIX, isDashboardRequest, startAnswerDelivery } from "./delivery.ts";
