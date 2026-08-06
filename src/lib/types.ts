export interface DocumentPayload {
  path: string;
  content: string;
  hash: string;
  lineEnding: "LF" | "CRLF";
  bom: boolean;
  readOnly: boolean;
  detectedEncoding: string;
  modifiedAtMs: number;
}

export interface SaveDocumentResult {
  status: "saved" | "conflict";
  hash: string;
  modifiedAtMs: number;
  diskDocument: DocumentPayload | null;
}

export interface VersionSummary {
  id: string;
  createdAt: string;
  kind: "auto" | "ai" | "merge" | "restore" | "named" | "conversion";
  name: string | null;
  contentHash: string;
  sizeBytes: number;
}

export interface StoredVersion extends VersionSummary {
  documentPath: string;
  content: string;
}

export interface RecentDocument {
  path: string;
  title: string;
  openedAt: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  line: number;
}

export interface OutlineItem {
  level: number;
  title: string;
  line: number;
  offset: number;
}

export interface EditorChangeContext {
  composing: boolean;
}

export interface FontRecord {
  family: string;
  monospaced: boolean;
  bundled: boolean;
  dataUrl?: string | null;
}

export type WritingExperience = "typewriter" | "literary" | "flow";

export type WritingInputKind =
  | "character"
  | "space"
  | "backspace"
  | "delete"
  | "enter"
  | "paste"
  | "other";

export type WritingInputOrigin =
  | "keyboard"
  | "paste"
  | "autocomplete"
  | "programmatic";

export interface WritingActivity {
  source: "paper" | "source";
  kind: WritingInputKind;
  origin: WritingInputOrigin;
  insertedText: string;
  removedText: string;
  wordDelta: number;
  sentenceDelta: number;
  paragraphDelta: number;
}

export interface SyncthingStatus {
  available: boolean;
  folderId: string | null;
  folderPath: string | null;
  state: string;
  connectedDevices: number;
  needBytes: number;
  conflictFiles: string[];
  message: string;
}

export interface RepositoryStatus {
  active: boolean;
  available: boolean;
  writable: boolean;
  path: string | null;
  lastDocumentPath: string | null;
  message: string;
}

export interface RepositoryDocument {
  path: string;
  name: string;
  modifiedAtMs: number;
  sizeBytes: number;
  readOnly: boolean;
}

export interface AiAccountStatus {
  codexInstalled: boolean;
  codexVersion: string | null;
  authenticated: boolean;
  accountType: string | null;
  email: string | null;
  planType: string | null;
  message: string;
}

export interface AiLoginStart {
  loginId: string;
  loginType: string;
  url: string;
  userCode: string | null;
}

export interface AiSourceContext {
  id: string;
  title: string;
  content: string;
}

export interface AiWritingResponse {
  replacement: string;
  rationale: string;
  citations: string[];
  warnings: string[];
  originalHash: string;
  model: string;
}

export type AiChatTargetKind = "selection" | "document";
export type AiChatResponseKind = "answer" | "edit";
export type AiEditHunkStatus = "pending" | "applied" | "rejected" | "stale";

export interface AiChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatResponse {
  kind: AiChatResponseKind;
  reply: string;
  revisedText: string;
  citations: string[];
  warnings: string[];
  originalHash: string;
  model: string;
  processedChunks: number;
  totalChunks: number;
}

export interface AiEditHunk {
  id: string;
  from: number;
  to: number;
  original: string;
  replacement: string;
  status: AiEditHunkStatus;
}

export interface AiEditProposal {
  baseHash: string;
  baseText: string;
  targetKind: AiChatTargetKind;
  targetFrom: number;
  targetTo: number;
  revisedText: string;
  hunks: AiEditHunk[];
}

export interface AiChatMessageMetadata {
  citations?: string[];
  warnings?: string[];
  model?: string;
  proposal?: AiEditProposal;
  failed?: boolean;
}

export interface AiChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  responseKind: AiChatResponseKind | null;
  metadata: AiChatMessageMetadata;
  createdAt: string;
}

export interface AiConversationSummary {
  id: string;
  documentPath: string;
  title: string;
  targetKind: AiChatTargetKind;
  targetFrom: number | null;
  targetTo: number | null;
  targetText: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversation extends AiConversationSummary {
  messages: AiChatMessage[];
}

export interface AiGrammarResponse {
  correctedText: string;
  rationale: string;
  warnings: string[];
  originalHash: string;
  model: string;
}

export interface ImportedAsset {
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ManuscriptAssetData extends ImportedAsset {
  dataUrl: string;
}

export interface ZoteroStatus {
  available: boolean;
  message: string;
}

export interface ZoteroItem {
  key: string;
  itemType: string;
  title: string;
  authors: string[];
  year: string;
  publication: string;
  publisher: string;
  doi: string;
  url: string;
  date: string;
}

export interface ResearchConnectionStatus {
  configured: boolean;
  reachable: boolean;
  endpoint: string | null;
  authenticated: boolean;
  message: string;
}

export interface ResearchWorkspaceStatus {
  available: boolean;
  path: string | null;
  message: string;
}

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  checkedAt: string;
  classification: string;
  citationMarkdown: string;
  summary: string;
}

export interface ResearchFolder {
  slug: string;
  title: string;
  stage: string;
  human_message?: string;
  humanMessage?: string;
  source_count?: number;
  sourceCount?: number;
}

export interface EditorSelection {
  from: number;
  to: number;
  text: string;
  line: number;
  page?: number;
  row?: number;
  column?: number;
}

/**
 * Common contract shared by the visual paper editor and the raw Markdown
 * companion. Offsets are always offsets in the canonical Markdown string,
 * never ProseMirror/DOM positions.
 */
export interface EditorApi {
  focus: () => void;
  getContent: () => string;
  getSelection: () => EditorSelection;
  replaceRange: (from: number, to: number, text: string) => void;
  replaceRanges: (edits: TextEdit[]) => void;
  insertAtCursor: (text: string) => void;
  setSelection: (from: number, to: number) => void;
  scrollToOffset: (offset: number) => void;
  scrollToLine: (line: number) => void;
  getScrollAnchor: () => ScrollAnchor;
  scrollToAnchor: (anchor: ScrollAnchor) => void;
  setGhostText: (text: string) => void;
  clearGhostText: () => void;
  getPageCount?: () => number;
  awaitLayout?: () => Promise<void>;
}

export interface TextEdit {
  from: number;
  to: number;
  text: string;
}

export interface ScrollAnchor {
  offset: number;
  source: "paper" | "source";
}

export type FocusMode = "off" | "paragraph" | "sentence";
export type SidePanel = "repository" | "outline" | "search" | "versions" | null;
export type AssistantPanel =
  | "proofreading"
  | "sources"
  | "settings"
  | null;
export type CompanionView = "source" | null;
