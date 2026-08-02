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

export type FocusMode = "off" | "paragraph" | "sentence";
export type ManuscriptFitMode = "page" | "width";
export type SidePanel = "repository" | "outline" | "search" | "versions" | null;
export type AssistantPanel =
  | "proofreading"
  | "ai"
  | "sources"
  | "settings"
  | null;
export type DocumentViewMode = "manuscript" | "source" | "preview";
