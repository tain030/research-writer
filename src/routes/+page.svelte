<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { diffChars, diffWords } from "diff";
  import Editor, { type EditorApi } from "$lib/Editor.svelte";
  import MarkdownSourceEditor from "$lib/MarkdownSourceEditor.svelte";
  import {
    applyQuickFixes,
    parseManuscript,
    updateManuscriptMetadata,
    type ManuscriptMetadata,
    type ParsedManuscript,
    type QuickFix,
    type WritingDiagnostic,
  } from "$lib/manuscript-document";
  import type { ManuscriptBlockPlacement } from "$lib/manuscript-layout";
  import {
    basename,
    countWords,
    currentSection,
    displayDate,
    extractOutline,
    findFootnoteByIdentity,
    nextFootnoteId,
  } from "$lib/markdown";
  import {
    applyBlockStyle,
    currentBlockStyle,
    insertMarkdownLink,
    toggleInlineStyle,
    type MarkdownBlockStyle,
    type MarkdownEdit,
    type MarkdownInlineStyle,
  } from "$lib/markdown-formatting";
  import {
    defaultPreferences,
    parsePreferences,
    type Preferences,
  } from "$lib/preferences";
  import { SingleFlight } from "$lib/single-flight";
  import { DeferredLatest } from "$lib/deferred-latest";
  import { externalSyncProvider } from "$lib/storage";
  import {
    compareVersionContent,
    type VersionComparison,
  } from "$lib/version-comparison";
  import type {
    AiAccountStatus,
    AiGrammarResponse,
    AiLoginStart,
    AiSourceContext,
    AiWritingResponse,
    AssistantPanel,
    DocumentPayload,
    DocumentViewMode,
    EditorChangeContext,
    EditorSelection,
    FontRecord,
    ImportedAsset,
    RecentDocument,
    RepositoryDocument,
    RepositoryStatus,
    ResearchConnectionStatus,
    ResearchFolder,
    ResearchSource,
    ResearchWorkspaceStatus,
    SaveDocumentResult,
    SearchResult,
    SidePanel,
    StoredVersion,
    SyncthingStatus,
    VersionSummary,
    ZoteroItem,
    ZoteroStatus,
  } from "$lib/types";

  type SaveState = "saved" | "dirty" | "saving" | "error";
  type ContextMode = "selection" | "section" | "document";
  type GrammarScope = "selection" | "paragraph" | "document";
  type PreviewComponent = typeof import("$lib/DocumentPreview.svelte").default;
  type ToolbarMenu = "insert" | "view" | "link" | null;
  type DocumentDialog =
    | "metadata"
    | "figure"
    | "table"
    | "math"
    | "footnote"
    | "block"
    | null;

  interface ConflictState {
    remote: DocumentPayload;
    local: string;
    base: string;
  }

  interface Suggestion {
    response: AiWritingResponse;
    action: string;
    from: number;
    to: number;
    original: string;
  }

  interface ExitPrompt {
    message: string;
    conflict: boolean;
  }

  interface GrammarSuggestion {
    response: AiGrammarResponse;
    from: number;
    to: number;
    original: string;
  }

  interface GrammarEdit {
    from: number;
    to: number;
    expected: string;
    replacement: string;
  }

  let desktop = $state(false);
  let currentDocument = $state<DocumentPayload | null>(null);
  let editorValue = $state("");
  let analyzedValue = $state("");
  let analysisPending = $state(false);
  let baseContent = $state("");
  let editorApi = $state<EditorApi | null>(null);
  let Preview = $state<PreviewComponent | null>(null);
  let viewMode = $state<DocumentViewMode>("manuscript");
  let selection = $state<EditorSelection>({
    from: 0,
    to: 0,
    text: "",
    line: 1,
  });
  let leftPanel = $state<SidePanel>(null);
  let rightPanel = $state<AssistantPanel>(null);
  let lastLeftPanel = $state<Exclude<SidePanel, null>>("repository");
  let lastRightPanel = $state<Exclude<AssistantPanel, null>>("proofreading");
  let toolbarMenu = $state<ToolbarMenu>(null);
  let toolbarMenuTrigger: HTMLButtonElement | null = null;
  let linkUrl = $state("https://");
  let linkInput = $state<HTMLInputElement>();
  let linkMenuButton = $state<HTMLButtonElement>();
  let advancedSettingsOpen = $state(false);
  let chromeSuppressed = $state(false);
  let saveState = $state<SaveState>("saved");
  let saveError = $state("");
  let conflict = $state<ConflictState | null>(null);
  let recents = $state<RecentDocument[]>([]);
  let fonts = $state<FontRecord[]>([
    { family: "Pretendard", monospaced: false, bundled: true },
    { family: "MaruBuri", monospaced: false, bundled: true },
    { family: "NanumGothicCoding", monospaced: true, bundled: true },
  ]);
  let preferences = $state<Preferences>({ ...defaultPreferences });
  let toast = $state("");
  let toastKind = $state<"info" | "error" | "success">("info");
  let sync = $state<SyncthingStatus | null>(null);
  let repository = $state<RepositoryStatus | null>(null);
  let repositoryDocuments = $state<RepositoryDocument[]>([]);
  let creatingDocument = $state(false);
  let repositoryBusy = $state(false);
  let renamingPath = $state("");
  let renameValue = $state("");
  let watchedRepositoryPath = "";
  let versions = $state<VersionSummary[]>([]);
  let namedVersion = $state("");
  let versionPreview = $state<{
    version: VersionSummary;
    documentPath: string;
    currentContent: string;
    content: string;
    comparison: VersionComparison;
  } | null>(null);
  let versionRestoreBusy = $state(false);
  let versionDialog = $state<HTMLElement>();
  let versionCloseButton = $state<HTMLButtonElement>();
  let workspaceRoot = $state("");
  let searchQuery = $state("");
  let searchResults = $state<SearchResult[]>([]);
  let searchBusy = $state(false);
  let searchIndexed = $state(false);

  let aiAccount = $state<AiAccountStatus | null>(null);
  let aiBusy = $state(false);
  let aiAction = $state("");
  let aiInstructions = $state("");
  let contextMode = $state<ContextMode>("section");
  let suggestion = $state<Suggestion | null>(null);
  let grammarSuggestion = $state<GrammarSuggestion | null>(null);
  let grammarBusy = $state(false);
  let grammarScope = $state<GrammarScope>("paragraph");
  let exitPrompt = $state<ExitPrompt | null>(null);
  let login = $state<AiLoginStart | null>(null);
  let styleReference = $state("");
  let styleReferenceName = $state("");
  let selectedSourceIds = $state<string[]>([]);

  let documentDialog = $state<DocumentDialog>(null);
  let metadataDraft = $state<ManuscriptMetadata>({
    title: "",
    subtitle: "",
    author: "",
    affiliation: "",
    genre: "",
    schema: 1,
    layout: "traditional-ko",
  });
  let figureSourcePath = $state("");
  let figureAlt = $state("");
  let figureCaption = $state("");
  let tableRows = $state(3);
  let tableColumns = $state(3);
  let tableCells = $state<string[][]>([]);
  let mathDisplay = $state(true);
  let mathValue = $state("");
  let footnoteValue = $state("");
  let activeBlock = $state<ManuscriptBlockPlacement | null>(null);
  let blockSource = $state("");
  let blockOriginal = $state("");

  let zotero = $state<ZoteroStatus | null>(null);
  let zoteroQuery = $state("");
  let zoteroItems = $state<ZoteroItem[]>([]);
  let zoteroBusy = $state(false);
  let citationStyle = $state("research");
  let citationLocator = $state("");
  let manualCitation = $state("");

  let researchConnection = $state<ResearchConnectionStatus | null>(null);
  let researchWorkspace = $state<ResearchWorkspaceStatus | null>(null);
  let researchFolders = $state<ResearchFolder[]>([]);
  let researchSources = $state<ResearchSource[]>([]);
  let researchSlug = $state("");
  let researchEndpoint = $state("");
  let researchToken = $state("");
  let researchTopic = $state("");
  let researchBusy = $state(false);

  let activeBlockStyle = $derived(
    currentBlockStyle(editorValue, selection.from),
  );
  let formattingDisabled = $derived(
    !currentDocument || currentDocument.readOnly || viewMode === "preview",
  );

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let completionTimer: ReturnType<typeof setTimeout> | null = null;
  let chromeStreakTimer: ReturnType<typeof setTimeout> | null = null;
  let chromePauseTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let externalTimer: ReturnType<typeof setTimeout> | null = null;
  let repositoryTimer: ReturnType<typeof setTimeout> | null = null;
  let versionPreviewRequest = 0;
  let versionReturnFocus: HTMLElement | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let unlisteners: UnlistenFn[] = [];
  let lastSnapshotAt = 0;
  let closing = false;
  const saveFlight = new SingleFlight<boolean>();
  const exitFlight = new SingleFlight<void>();
  const documentAnalysis = new DeferredLatest();

  let outline = $derived(extractOutline(analyzedValue));
  let words = $derived(countWords(analyzedValue));
  let minutes = $derived(Math.max(1, Math.ceil(words / 350)));
  let documentTitle = $derived(
    currentDocument ? basename(currentDocument.path) : "Research Writer",
  );
  let manuscriptFallbackTitle = $derived(
    currentDocument
      ? basename(currentDocument.path).replace(/\.(?:md|markdown)$/i, "")
      : "제목 없는 원고",
  );
  let parsedManuscript = $state<ParsedManuscript>(
    parseManuscript("", "제목 없는 원고"),
  );
  let diagnostics = $derived(
    preferences.manuscriptGuidance && !analysisPending
      ? parsedManuscript.diagnostics
      : [],
  );
  let safeDiagnosticCount = $derived(
    diagnostics.filter((item) => item.fix?.safe).length,
  );
  let grammarEdits = $derived(
    grammarSuggestion
      ? grammarDiffEdits(
          grammarSuggestion.original,
          grammarSuggestion.response.correctedText,
        )
      : [],
  );
  let currentSyncProvider = $derived(
    externalSyncProvider(currentDocument?.path ?? ""),
  );
  let repositorySyncProvider = $derived(
    externalSyncProvider(repository?.path ?? ""),
  );
  let currentDocumentInRepository = $derived(
    currentDocument !== null &&
      repositoryDocuments.some((document) => document.path === currentDocument?.path),
  );
  let currentDocumentIsStandalone = $derived(
    currentDocument !== null &&
      repository?.available === true &&
      !currentDocumentInRepository,
  );
  let sourceContexts = $derived(
    researchSources
      .filter((source) => selectedSourceIds.includes(source.id))
      .map(
        (source): AiSourceContext => ({
          id: source.id,
          title: source.title,
          content: [
            source.summary,
            source.citationMarkdown,
            source.publisher ? `발행자: ${source.publisher}` : "",
            source.checkedAt ? `확인일: ${source.checkedAt}` : "",
            source.classification
              ? `분류: ${source.classification}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      ),
  );

  function isDesktopRuntime(): boolean {
    return (
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
    );
  }

  function notify(
    message: string,
    kind: "info" | "error" | "success" = "info",
  ): void {
    toast = message;
    toastKind = kind;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = "";
    }, kind === "error" ? 6500 : 3200);
  }

  function errorMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    return "알 수 없는 오류가 발생했습니다.";
  }

  async function openExternalUrl(value: string): Promise<boolean> {
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol)) {
        throw new Error("HTTP 또는 HTTPS 주소만 열 수 있습니다.");
      }
      await openUrl(url.toString());
      return true;
    } catch (error) {
      notify(errorMessage(error), "error");
      return false;
    }
  }

  function documentIsSaved(): boolean {
    return saveState === "saved";
  }

  function loadPreferences(): void {
    preferences = parsePreferences(
      localStorage.getItem("research-writer.preferences"),
    );
    document.documentElement.dataset.theme = preferences.theme;
  }

  function savePreferences(): void {
    localStorage.setItem(
      "research-writer.preferences",
      JSON.stringify(preferences),
    );
    document.documentElement.dataset.theme = preferences.theme;
  }

  function setManuscriptFitMode(
    mode: Preferences["manuscriptFitMode"],
  ): void {
    preferences.manuscriptFitMode = mode;
    savePreferences();
  }

  function cancelDocumentAnalysis(): void {
    documentAnalysis.cancel();
  }

  function analyzeDocumentNow(value = editorValue): ParsedManuscript {
    cancelDocumentAnalysis();
    const parsed = parseManuscript(value, manuscriptFallbackTitle);
    if (value === editorValue) {
      analyzedValue = value;
      parsedManuscript = parsed;
      analysisPending = false;
    }
    return parsed;
  }

  function scheduleDocumentAnalysis(value = editorValue): void {
    cancelDocumentAnalysis();
    if (value === analyzedValue) {
      analysisPending = false;
      return;
    }
    analysisPending = true;
    documentAnalysis.schedule(
      250,
      () => parseManuscript(value, manuscriptFallbackTitle),
      (parsed) => {
        if (value !== editorValue) return;
        analyzedValue = value;
        parsedManuscript = parsed;
        analysisPending = false;
      },
    );
  }

  function handleEditorSelection(value: EditorSelection): void {
    selection = value;
    editorApi?.clearGhostText();
    if (completionTimer) {
      clearTimeout(completionTimer);
      completionTimer = null;
    }
  }

  async function switchDocumentView(mode: DocumentViewMode): Promise<void> {
    if (mode === "preview" && !Preview) {
      try {
        Preview = (await import("$lib/DocumentPreview.svelte")).default;
      } catch (error) {
        notify(`완성본 보기를 불러오지 못했습니다: ${errorMessage(error)}`, "error");
        return;
      }
    }
    viewMode = mode;
    await tick();
    if (mode !== "preview") editorApi?.focus();
  }

  async function editableApi(): Promise<EditorApi | null> {
    if (!currentDocument || currentDocument.readOnly) return null;
    if (viewMode === "preview") {
      viewMode = "manuscript";
      await tick();
    }
    return editorApi;
  }

  async function applyEditorMarkdownEdit(edit: MarkdownEdit): Promise<void> {
    const api = await editableApi();
    if (!api) return;
    api.replaceRange(edit.replaceFrom, edit.replaceTo, edit.replacement);
    api.setSelection(edit.from, edit.to);
    toolbarMenu = null;
    toolbarMenuTrigger = null;
  }

  async function formatBlock(style: MarkdownBlockStyle): Promise<void> {
    const api = await editableApi();
    if (!api) return;
    const content = api.getContent();
    const selected = api.getSelection();
    await applyEditorMarkdownEdit(applyBlockStyle(content, selected, style));
  }

  async function formatInline(style: MarkdownInlineStyle): Promise<void> {
    const api = await editableApi();
    if (!api) return;
    const content = api.getContent();
    const selected = api.getSelection();
    await applyEditorMarkdownEdit(toggleInlineStyle(content, selected, style));
  }

  async function openLinkMenu(): Promise<void> {
    if (formattingDisabled) return;
    if (toolbarMenu === "link") {
      closeToolbarMenu(false);
      return;
    }
    toolbarMenuTrigger = linkMenuButton ?? null;
    toolbarMenu = "link";
    linkUrl = "https://";
    await tick();
    linkInput?.focus();
    linkInput?.select();
  }

  const focusableSelector =
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  function focusableWithin(node: HTMLElement): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>(focusableSelector));
  }

  async function toggleToolbarMenu(
    menu: Exclude<ToolbarMenu, "link" | null>,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    if (toolbarMenu === menu) {
      toolbarMenu = null;
      toolbarMenuTrigger = null;
      return;
    }
    toolbarMenuTrigger = trigger;
    toolbarMenu = menu;
    await tick();
    document
      .querySelector<HTMLElement>(`.toolbar-menu[data-menu="${menu}"]`)
      ?.querySelector<HTMLElement>(focusableSelector)
      ?.focus();
  }

  function closeToolbarMenu(restoreFocus: boolean): void {
    const trigger = toolbarMenuTrigger;
    toolbarMenu = null;
    toolbarMenuTrigger = null;
    if (restoreFocus && trigger?.isConnected) {
      void tick().then(() => trigger.focus());
    }
  }

  function handleToolbarMenuKeydown(event: KeyboardEvent): void {
    const menu = event.currentTarget as HTMLElement;
    const items = focusableWithin(menu);
    if (!items.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeToolbarMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function modalFocus(node: HTMLElement): { destroy: () => void } {
    const activeElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const returnFocus = toolbarMenuTrigger?.isConnected
      ? toolbarMenuTrigger
      : activeElement;
    toolbarMenuTrigger = null;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(node);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.querySelectorAll<HTMLElement>(".close-button:not([aria-label])").forEach(
      (button) => button.setAttribute("aria-label", "대화상자 닫기"),
    );
    node.addEventListener("keydown", trapFocus);
    void tick().then(() => {
      const preferred = node.querySelector<HTMLElement>(
        `[autofocus], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), ${focusableSelector}`,
      );
      preferred?.focus();
    });
    return {
      destroy: () => {
        node.removeEventListener("keydown", trapFocus);
        if (returnFocus?.isConnected) {
          void tick().then(() => returnFocus.focus());
        }
      },
    };
  }

  async function applyLink(): Promise<void> {
    const api = await editableApi();
    if (!api) return;
    const content = api.getContent();
    const selected = api.getSelection();
    await applyEditorMarkdownEdit(
      insertMarkdownLink(content, selected, linkUrl),
    );
  }

  async function replaceWholeDocument(
    next: string,
    message?: string,
  ): Promise<boolean> {
    if (next === editorValue) return true;
    const api = await editableApi();
    if (!api) {
      notify("읽기 전용 원고는 수정할 수 없습니다.", "error");
      return false;
    }
    api.replaceRange(0, api.getContent().length, next);
    if (message) notify(message, "success");
    return true;
  }

  function openMetadataDialog(): void {
    metadataDraft = { ...analyzeDocumentNow().metadata };
    documentDialog = "metadata";
  }

  async function saveMetadata(): Promise<void> {
    if (!metadataDraft.title.trim()) {
      notify("원고 제목을 입력해주세요.", "error");
      return;
    }
    const next = updateManuscriptMetadata(
      editorValue,
      metadataDraft,
      manuscriptFallbackTitle,
    );
    if (await replaceWholeDocument(next, "원고 정보를 반영했습니다.")) {
      documentDialog = null;
    }
  }

  async function moveToDiagnostic(item: WritingDiagnostic): Promise<void> {
    if (item.category === "metadata" && !item.fix) {
      openMetadataDialog();
      return;
    }
    await switchDocumentView("manuscript");
    editorApi?.setSelection(item.from, item.to);
  }

  async function applyDiagnosticFix(item: WritingDiagnostic): Promise<void> {
    if (!item.fix) {
      await moveToDiagnostic(item);
      return;
    }
    const fix = item.fix;
    if (editorValue.slice(fix.from, fix.to) !== fix.expected) {
      notify("원고가 바뀌어 이 안내를 바로 적용할 수 없습니다.", "error");
      return;
    }
    const api = await editableApi();
    api?.replaceRange(fix.from, fix.to, fix.replacement);
    notify("원고지 규칙에 맞게 고쳤습니다.", "success");
  }

  async function applyAllSafeDiagnostics(): Promise<void> {
    const next = applyQuickFixes(editorValue, diagnostics, true);
    if (next === editorValue) {
      notify("자동으로 고칠 안전한 항목이 없습니다.", "info");
      return;
    }
    await replaceWholeDocument(next, "안전한 원고지 수정 사항을 모두 반영했습니다.");
  }

  function grammarRange(): { from: number; to: number } | null {
    const selected = editorApi?.getSelection() ?? selection;
    if (grammarScope === "selection") {
      return selected.text.trim()
        ? { from: selected.from, to: selected.to }
        : null;
    }
    if (grammarScope === "document") {
      return { from: 0, to: editorValue.length };
    }
    const fromMarker = editorValue.lastIndexOf(
      "\n\n",
      Math.max(0, selected.from - 1),
    );
    const toMarker = editorValue.indexOf("\n\n", selected.to);
    return {
      from: fromMarker < 0 ? 0 : fromMarker + 2,
      to: toMarker < 0 ? editorValue.length : toMarker,
    };
  }

  async function runGrammarCheck(): Promise<void> {
    if (!desktop || !currentDocument || grammarBusy) return;
    const range = grammarRange();
    if (!range) {
      notify("문법 검사를 실행할 문장을 먼저 선택해주세요.", "info");
      return;
    }
    const original = editorValue.slice(range.from, range.to);
    if (!original.trim()) {
      notify("검사할 문장을 먼저 작성하거나 선택해주세요.", "info");
      return;
    }
    grammarBusy = true;
    try {
      const response = await invoke<AiGrammarResponse>(
        "run_ai_grammar_check",
        {
          request: {
            text: original,
            documentContext: currentSection(editorValue, range.from),
          },
        },
      );
      grammarSuggestion = {
        response,
        from: range.from,
        to: range.to,
        original,
      };
      if (response.correctedText === original) {
        notify("AI가 고칠 문법 문제를 찾지 못했습니다.", "success");
      }
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      grammarBusy = false;
    }
  }

  function grammarDiffEdits(
    original: string,
    corrected: string,
  ): GrammarEdit[] {
    const edits: GrammarEdit[] = [];
    let sourceOffset = 0;
    let pending: GrammarEdit | null = null;
    const flush = () => {
      if (!pending) return;
      if (pending.expected !== pending.replacement) edits.push(pending);
      pending = null;
    };
    for (const part of diffChars(original, corrected)) {
      if (!part.added && !part.removed) {
        flush();
        sourceOffset += part.value.length;
        continue;
      }
      if (!pending) {
        pending = {
          from: sourceOffset,
          to: sourceOffset,
          expected: "",
          replacement: "",
        };
      }
      if (part.removed) {
        pending.expected += part.value;
        pending.to += part.value.length;
        sourceOffset += part.value.length;
      } else {
        pending.replacement += part.value;
      }
    }
    flush();
    return edits;
  }

  async function applyGrammarReplacement(replacement: string): Promise<void> {
    if (!grammarSuggestion) return;
    const pending = grammarSuggestion;
    if (
      editorValue.slice(pending.from, pending.to) !== pending.original
    ) {
      notify("검사 뒤 원고가 바뀌었습니다. 다시 문법 검사를 실행해주세요.", "error");
      grammarSuggestion = null;
      return;
    }
    try {
      await createSnapshot("ai");
      const api = await editableApi();
      api?.replaceRange(pending.from, pending.to, replacement);
      grammarSuggestion = null;
      notify("AI 문법 제안을 반영했습니다. 적용 전 버전을 보관했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function applyGrammarEdit(edit: GrammarEdit): Promise<void> {
    if (!grammarSuggestion) return;
    const next =
      grammarSuggestion.original.slice(0, edit.from) +
      edit.replacement +
      grammarSuggestion.original.slice(edit.to);
    await applyGrammarReplacement(next);
  }

  async function insertBlockMarkdown(markdown: string): Promise<void> {
    const api = await editableApi();
    if (!api) return;
    const current = api.getContent();
    const selected = api.getSelection();
    const before = current.slice(0, selected.from);
    const after = current.slice(selected.to);
    const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    api.replaceRange(selected.from, selected.to, `${prefix}${markdown.trim()}${suffix}`);
  }

  function openFigureDialog(): void {
    figureSourcePath = "";
    figureAlt = selection.text.trim();
    figureCaption = "";
    documentDialog = "figure";
  }

  async function chooseFigureSource(): Promise<void> {
    if (!desktop) return;
    const selected = await openDialog({
      title: "원고에 넣을 그림 선택",
      multiple: false,
      directory: false,
      filters: [
        {
          name: "그림",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"],
        },
      ],
    });
    if (typeof selected === "string") figureSourcePath = selected;
  }

  async function insertFigure(): Promise<void> {
    if (!desktop || !currentDocument || !figureSourcePath) return;
    try {
      const imported = await invoke<ImportedAsset>(
        "import_manuscript_asset",
        {
          documentPath: currentDocument.path,
          sourcePath: figureSourcePath,
        },
      );
      const alt = (figureAlt.trim() || "그림").replaceAll("]", "\\]");
      const caption = figureCaption.trim();
      const markdown = [
        `![${alt}](${imported.relativePath})`,
        caption ? `*${caption}*` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      await insertBlockMarkdown(markdown);
      documentDialog = null;
      notify("그림을 assets 폴더에 복사해 원고에 넣었습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  function openTableDialog(): void {
    tableRows = 3;
    tableColumns = 3;
    tableCells = Array.from({ length: tableRows }, (_, row) =>
      Array.from(
        { length: tableColumns },
        (_, column) => (row === 0 ? `열 ${column + 1}` : ""),
      ),
    );
    documentDialog = "table";
  }

  function resizeTable(rows: number, columns: number): void {
    tableRows = Math.min(12, Math.max(2, rows));
    tableColumns = Math.min(8, Math.max(1, columns));
    tableCells = Array.from({ length: tableRows }, (_, row) =>
      Array.from(
        { length: tableColumns },
        (_, column) => tableCells[row]?.[column] ?? (row === 0 ? `열 ${column + 1}` : ""),
      ),
    );
  }

  function tableMarkdown(): string {
    const escape = (value: string) =>
      value.replaceAll("|", "\\|").replace(/\r?\n/g, " ").trim();
    const lines = [
      `| ${tableCells[0].map(escape).join(" | ")} |`,
      `| ${Array.from({ length: tableColumns }, () => "---").join(" | ")} |`,
      ...tableCells
        .slice(1)
        .map((row) => `| ${row.map(escape).join(" | ")} |`),
    ];
    return lines.join("\n");
  }

  async function insertTable(): Promise<void> {
    await insertBlockMarkdown(tableMarkdown());
    documentDialog = null;
    notify("표를 Markdown으로 원고에 넣었습니다.", "success");
  }

  function openMathDialog(): void {
    mathDisplay = true;
    mathValue = selection.text.trim();
    documentDialog = "math";
  }

  async function insertMath(): Promise<void> {
    if (!mathValue.trim()) return;
    const api = await editableApi();
    if (!api) return;
    if (mathDisplay) {
      await insertBlockMarkdown(`$$\n${mathValue.trim()}\n$$`);
    } else {
      api.insertAtCursor(`$${mathValue.trim()}$`);
    }
    documentDialog = null;
    notify("수식을 원고에 넣었습니다.", "success");
  }

  function openFootnoteDialog(): void {
    footnoteValue = "";
    documentDialog = "footnote";
  }

  async function insertFootnoteFromDialog(): Promise<void> {
    if (!footnoteValue.trim()) return;
    await insertFootnote(footnoteValue.trim());
    documentDialog = null;
    footnoteValue = "";
  }

  function editDocumentBlock(block: ManuscriptBlockPlacement): void {
    activeBlock = block;
    blockSource = editorValue.slice(block.from, block.to);
    blockOriginal = blockSource;
    documentDialog = "block";
  }

  async function saveDocumentBlock(): Promise<void> {
    if (!activeBlock) return;
    const current = editorValue.slice(activeBlock.from, activeBlock.to);
    if (current !== blockOriginal) {
      notify("문서 요소가 바뀌었습니다. 다시 열어주세요.", "error");
      return;
    }
    const api = await editableApi();
    api?.replaceRange(activeBlock.from, activeBlock.to, blockSource.trim());
    documentDialog = null;
    activeBlock = null;
    notify("문서 요소를 수정했습니다.", "success");
  }

  async function printCompletedDocument(): Promise<void> {
    if (viewMode !== "preview") await switchDocumentView("preview");
    await tick();
    window.print();
  }

  async function loadRecents(): Promise<void> {
    if (!desktop) return;
    try {
      recents = await invoke<RecentDocument[]>("recent_documents");
    } catch {
      recents = [];
    }
  }

  async function refreshRepositoryDocuments(): Promise<void> {
    if (!desktop || !repository?.available) {
      repositoryDocuments = [];
      return;
    }
    try {
      repositoryDocuments = await invoke<RepositoryDocument[]>(
        "list_repository_documents",
      );
    } catch (error) {
      repositoryDocuments = [];
      notify(errorMessage(error), "error");
    }
  }

  async function refreshRepository(): Promise<RepositoryStatus | null> {
    if (!desktop) return null;
    try {
      repository = await invoke<RepositoryStatus>("repository_status");
      if (repository.available && repository.path) {
        workspaceRoot = repository.path;
        await refreshRepositoryDocuments();
      } else {
        workspaceRoot = "";
        repositoryDocuments = [];
      }
      return repository;
    } catch (error) {
      notify(errorMessage(error), "error");
      return null;
    }
  }

  async function watchActiveRepository(): Promise<void> {
    if (!desktop) return;
    if (watchedRepositoryPath && watchedRepositoryPath !== repository?.path) {
      await invoke("unwatch_repository", {
        path: watchedRepositoryPath,
      }).catch(() => undefined);
      watchedRepositoryPath = "";
    }
    if (!repository?.available || !repository.path) return;
    if (watchedRepositoryPath === repository.path) return;
    await invoke("watch_repository", { path: repository.path }).catch((error) =>
      notify(errorMessage(error), "error"),
    );
    watchedRepositoryPath = repository.path;
  }

  async function clearDocumentState(): Promise<void> {
    if (currentDocument && desktop) {
      await invoke("unwatch_document", {
        path: currentDocument.path,
      }).catch(() => undefined);
    }
    resetVersionPreview(false);
    currentDocument = null;
    resetChromeSuppression();
    cancelDocumentAnalysis();
    editorValue = "";
    analyzedValue = "";
    analysisPending = false;
    baseContent = "";
    parsedManuscript = parseManuscript("", "제목 없는 원고");
    saveState = "saved";
    saveError = "";
    conflict = null;
    viewMode = "manuscript";
    documentDialog = null;
    grammarSuggestion = null;
    sync = null;
    selection = { from: 0, to: 0, text: "", line: 1 };
  }

  async function openRepositoryPath(path: string): Promise<boolean> {
    if (!desktop || repositoryBusy) return false;
    if (!(await maybeSaveBeforeSwitch())) return false;
    repositoryBusy = true;
    try {
      const opened = await invoke<RepositoryStatus>("open_repository", { path });
      if (!opened.available || !opened.path) {
        notify(opened.message, "error");
        return false;
      }
      const openedPath = opened.path;
      const previousRepository = watchedRepositoryPath;
      if (previousRepository) {
        await invoke("unwatch_repository", {
          path: previousRepository,
        }).catch(() => undefined);
        watchedRepositoryPath = "";
      }
      await clearDocumentState();
      repository = opened;
      workspaceRoot = openedPath;
      searchIndexed = false;
      searchResults = [];
      await Promise.all([refreshRepositoryDocuments(), watchActiveRepository()]);
      leftPanel = "repository";
      if (repository.lastDocumentPath) {
        await openPath(repository.lastDocumentPath);
      }
      notify(`${basename(openedPath)} 저장소를 열었습니다.`, "success");
      return true;
    } catch (error) {
      await refreshRepository();
      notify(errorMessage(error), "error");
      return false;
    } finally {
      repositoryBusy = false;
    }
  }

  async function chooseRepository(): Promise<boolean> {
    if (!desktop) return false;
    const selected = await openDialog({
      title: "원고 저장소 열기",
      directory: true,
      multiple: false,
      defaultPath: repository?.available ? repository.path ?? undefined : undefined,
    });
    return typeof selected === "string"
      ? openRepositoryPath(selected)
      : false;
  }

  async function closeRepository(): Promise<void> {
    if (!desktop || !repository?.active || repositoryBusy) return;
    if (!(await maybeSaveBeforeSwitch())) return;
    repositoryBusy = true;
    try {
      const closed = await invoke<RepositoryStatus>("close_repository");
      if (watchedRepositoryPath) {
        await invoke("unwatch_repository", {
          path: watchedRepositoryPath,
        }).catch(() => undefined);
        watchedRepositoryPath = "";
      }
      await clearDocumentState();
      repository = closed;
      repositoryDocuments = [];
      workspaceRoot = "";
      searchResults = [];
      searchIndexed = false;
      renamingPath = "";
      leftPanel = null;
      notify("원고 저장소를 닫았습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      repositoryBusy = false;
    }
  }

  async function setDocument(document: DocumentPayload): Promise<void> {
    if (currentDocument && desktop) {
      await invoke("unwatch_document", {
        path: currentDocument.path,
      }).catch(() => undefined);
    }
    resetVersionPreview(false);
    currentDocument = document;
    resetChromeSuppression();
    cancelDocumentAnalysis();
    editorValue = document.content;
    analyzedValue = document.content;
    analysisPending = false;
    baseContent = document.content;
    parsedManuscript = parseManuscript(
      document.content,
      basename(document.path).replace(/\.(?:md|markdown)$/i, ""),
    );
    saveState = "saved";
    saveError = "";
    conflict = null;
    viewMode = "manuscript";
    documentDialog = null;
    grammarSuggestion = null;
    selection = { from: 0, to: 0, text: "", line: 1 };
    searchIndexed = false;
    lastSnapshotAt = Date.now();
    if (desktop) {
      await invoke("watch_document", { path: document.path }).catch((error) =>
        notify(errorMessage(error), "error"),
      );
      workspaceRoot = repository?.available ? repository.path ?? "" : "";
      if (repositoryDocuments.some((entry) => entry.path === document.path) && repository) {
        repository.lastDocumentPath = document.path;
      }
      await Promise.all([loadRecents(), refreshSync()]);
    }
    await tick();
    editorApi?.focus();
    if (document.readOnly && document.detectedEncoding !== "UTF-8") {
      notify(
        `${document.detectedEncoding} 문서를 읽기 전용으로 열었습니다. UTF-8로 변환하면 편집할 수 있습니다.`,
        "info",
      );
    }
  }

  async function maybeSaveBeforeSwitch(): Promise<boolean> {
    if (saveState === "saved" && !saveFlight.active) return true;
    return saveNow();
  }

  async function openPath(path: string, line?: number): Promise<void> {
    if (!(await maybeSaveBeforeSwitch())) return;
    try {
      if (!desktop) {
        notify("파일 열기는 데스크톱 앱에서 사용할 수 있습니다.", "info");
        return;
      }
      const document = await invoke<DocumentPayload>("read_document", { path });
      await setDocument(document);
      if (line) editorApi?.scrollToLine(line);
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function chooseDocument(): Promise<void> {
    if (!desktop) {
      loadWebPreview();
      return;
    }
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (typeof selected === "string") await openPath(selected);
  }

  async function createDocument(): Promise<void> {
    if (!desktop) {
      loadWebPreview();
      return;
    }
    if (creatingDocument) return;
    if (!repository?.available || !repository.path) {
      notify("새 원고를 만들려면 먼저 저장소를 열어주세요.", "info");
      return;
    }
    if (!repository.writable) {
      notify("읽기 전용 저장소에서는 새 원고를 만들 수 없습니다.", "error");
      return;
    }
    creatingDocument = true;
    try {
      if (!(await maybeSaveBeforeSwitch())) return;
      const created = await invoke<DocumentPayload>("create_repository_document");
      await refreshRepositoryDocuments();
      await setDocument(created);
      await tick();
      renamingPath = created.path;
      renameValue = basename(created.path);
      await tick();
      const renameInput = document.querySelector<HTMLInputElement>(
        `[data-rename-path="${CSS.escape(created.path)}"]`,
      );
      renameInput?.focus();
      renameInput?.select();
      notify("새 원고를 만들었습니다.", "success");
    } catch (error) {
      await refreshRepository();
      notify(errorMessage(error), "error");
    } finally {
      creatingDocument = false;
    }
  }

  async function closeCurrentDocument(): Promise<void> {
    if (!currentDocument || !(await maybeSaveBeforeSwitch())) return;
    if (
      currentDocumentIsStandalone &&
      repository?.lastDocumentPath &&
      repository.lastDocumentPath !== currentDocument.path
    ) {
      const repositoryPath = repository.lastDocumentPath;
      await clearDocumentState();
      await openPath(repositoryPath);
      return;
    }
    if (currentDocumentInRepository && desktop) {
      await invoke("clear_repository_last_document").catch(() => undefined);
      if (repository) repository.lastDocumentPath = null;
    }
    await clearDocumentState();
  }

  async function beginRename(document: RepositoryDocument): Promise<void> {
    if (!repository?.writable) return;
    renamingPath = document.path;
    renameValue = document.name;
    await tick();
    const renameInput = window.document.querySelector<HTMLInputElement>(
      `[data-rename-path="${CSS.escape(document.path)}"]`,
    );
    renameInput?.focus();
    renameInput?.select();
  }

  async function commitRename(document: RepositoryDocument): Promise<void> {
    if (renamingPath !== document.path) return;
    const requested = renameValue.trim();
    if (!requested || requested === document.name) {
      renamingPath = "";
      return;
    }
    if (!(await maybeSaveBeforeSwitch())) return;
    try {
      const renamed = await invoke<DocumentPayload>(
        "rename_repository_document",
        { path: document.path, newName: requested },
      );
      const wasCurrent = currentDocument?.path === document.path;
      renamingPath = "";
      await refreshRepositoryDocuments();
      if (wasCurrent) await setDocument(renamed);
      notify(`원고 이름을 ${basename(renamed.path)}로 바꿨습니다.`, "success");
    } catch (error) {
      notify(errorMessage(error), "error");
      await tick();
      window.document
        .querySelector<HTMLInputElement>(
          `[data-rename-path="${CSS.escape(document.path)}"]`,
        )
        ?.focus();
    }
  }

  async function trashDocument(document: RepositoryDocument): Promise<void> {
    if (!repository?.writable) return;
    if (
      !window.confirm(
        `"${document.name}"을 운영체제 휴지통으로 옮길까요?`,
      )
    ) {
      return;
    }
    if (currentDocument?.path === document.path && !(await maybeSaveBeforeSwitch())) {
      return;
    }
    try {
      if (currentDocument?.path === document.path) {
        await invoke("unwatch_document", { path: document.path }).catch(
          () => undefined,
        );
      }
      await invoke("trash_repository_document", { path: document.path });
      if (currentDocument?.path === document.path) {
        await clearDocumentState();
        if (repository) repository.lastDocumentPath = null;
      }
      renamingPath = "";
      await Promise.all([refreshRepositoryDocuments(), loadRecents()]);
      searchIndexed = false;
      notify("원고를 휴지통으로 옮겼습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function saveAs(): Promise<void> {
    if (!desktop) return;
    const selected = await saveDialog({
      title: "다른 이름으로 저장",
      defaultPath: currentDocument?.path ?? "원고.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!selected) return;
    const path =
      selected.toLowerCase().endsWith(".md") ||
      selected.toLowerCase().endsWith(".markdown")
        ? selected
        : `${selected}.md`;
    try {
      const result = await invoke<SaveDocumentResult>("save_document", {
        request: {
          path,
          content: editorValue,
          expectedHash: null,
          lineEnding: currentDocument?.lineEnding ?? "LF",
          bom: currentDocument?.bom ?? false,
          force: true,
        },
      });
      if (result.status === "saved") await openPath(path);
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  function onEditorChange(
    value: string,
    context: EditorChangeContext = { composing: false },
  ): void {
    editorValue = value;
    analysisPending = value !== analyzedValue;
    if (!currentDocument || currentDocument.readOnly) return;
    saveState = "dirty";
    saveError = "";
    if (context.composing) return;
    scheduleDocumentAnalysis(value);
    scheduleSave();
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 300);
  }

  async function saveUntilSettled(): Promise<boolean> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    while (true) {
      if (!currentDocument || currentDocument.readOnly || !desktop) return true;
      if (conflict) return false;
      if (saveState === "saved") return true;

      const documentAtStart = currentDocument;
      const contentAtStart = editorValue;
      saveState = "saving";
      try {
        const result = await invoke<SaveDocumentResult>("save_document", {
          request: {
            path: documentAtStart.path,
            content: contentAtStart,
            expectedHash: documentAtStart.hash,
            lineEnding: documentAtStart.lineEnding,
            bom: documentAtStart.bom,
            force: false,
          },
        });
        if (currentDocument !== documentAtStart) {
          return false;
        }
        if (result.status === "conflict" && result.diskDocument) {
          conflict = {
            remote: result.diskDocument,
            local: editorValue,
            base: baseContent,
          };
          saveState = "error";
          saveError = "다른 장치에서 원고가 변경되었습니다.";
          return false;
        }
        documentAtStart.hash = result.hash;
        documentAtStart.modifiedAtMs = result.modifiedAtMs;
        baseContent = contentAtStart;
        saveError = "";
        if (editorValue === contentAtStart) {
          saveState = "saved";
        } else {
          saveState = "dirty";
        }
        if (Date.now() - lastSnapshotAt >= 5 * 60_000) {
          lastSnapshotAt = Date.now();
          try {
            await createSnapshot("auto");
          } catch (error) {
            notify(`자동 버전을 남기지 못했습니다: ${errorMessage(error)}`, "error");
          }
        }
      } catch (error) {
        saveState = "error";
        saveError = errorMessage(error);
        notify(`저장하지 못했습니다: ${saveError}`, "error");
        return false;
      }
    }
  }

  function saveNow(): Promise<boolean> {
    return saveFlight.run(saveUntilSettled);
  }

  async function finishAppExit(): Promise<void> {
    exitPrompt = null;
    closing = true;
    try {
      await invoke("complete_app_exit");
    } catch (error) {
      closing = false;
      notify(`앱을 끝내지 못했습니다: ${errorMessage(error)}`, "error");
    }
  }

  function requestAppExit(): Promise<void> {
    return exitFlight.run(async () => {
      if (closing) return;
      const saved = await saveNow();
      if (saved && documentIsSaved() && !conflict) {
        await finishAppExit();
        return;
      }
      exitPrompt = {
        conflict: conflict !== null,
        message: conflict
          ? "같은 원고의 외부 변경과 현재 편집이 겹쳤습니다. 충돌을 해결한 뒤 다시 끝내거나, 마지막 편집을 버리고 끝낼 수 있습니다."
          : saveError ||
            "마지막 편집을 저장하지 못했습니다. 다시 저장하거나 저장하지 않고 끝낼 수 있습니다.",
      };
    });
  }

  async function createSnapshot(
    kind: VersionSummary["kind"],
    name?: string,
  ): Promise<void> {
    if (!desktop || !currentDocument) return;
    await invoke("create_version", {
      path: currentDocument.path,
      content: editorValue,
      kind,
      name: name ?? null,
    });
  }

  async function convertEncoding(): Promise<void> {
    if (!currentDocument || !desktop) return;
    try {
      const converted = await invoke<DocumentPayload>(
        "convert_document_to_utf8",
        { path: currentDocument.path },
      );
      await setDocument(converted);
      notify("원본 버전을 보관하고 UTF-8로 변환했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function refreshSync(): Promise<void> {
    if (!desktop || !currentDocument) return;
    sync = await invoke<SyncthingStatus>("syncthing_status", {
      path: currentDocument.path,
    }).catch(() => null);
  }

  async function handleExternalChange(path: string): Promise<void> {
    if (!currentDocument || path !== currentDocument.path || !desktop) return;
    if (externalTimer) clearTimeout(externalTimer);
    externalTimer = setTimeout(async () => {
      if (!currentDocument) return;
      try {
        const remote = await invoke<DocumentPayload>("read_document", {
          path: currentDocument.path,
        });
        if (remote.hash === currentDocument.hash) return;
        if (saveState === "saved") {
          await setDocument(remote);
          notify("다른 장치의 변경 사항을 불러왔습니다.", "success");
        } else {
          conflict = { remote, local: editorValue, base: baseContent };
          saveState = "error";
          saveError = "외부 변경과 편집 중인 내용이 겹칩니다.";
        }
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    }, 650);
  }

  async function resolveConflict(
    choice: "remote" | "local" | "merge",
  ): Promise<void> {
    if (!conflict || !currentDocument) return;
    const pending = conflict;
    try {
      await Promise.all([
        invoke("create_version", {
          path: currentDocument.path,
          content: pending.local,
          kind: "merge",
          name: "충돌 전 내 편집",
        }),
        invoke("create_version", {
          path: currentDocument.path,
          content: pending.remote.content,
          kind: "merge",
          name: "충돌 전 다른 장치",
        }),
      ]);
      if (choice === "remote") {
        const latest = await invoke<DocumentPayload>("read_document", {
          path: currentDocument.path,
        });
        conflict = null;
        await setDocument(latest);
        notify(
          "내 편집을 버전에 보관하고 다른 장치의 최신 원고를 불러왔습니다.",
          "success",
        );
        return;
      }
      currentDocument.hash = pending.remote.hash;
      baseContent = pending.remote.content;
      conflict = null;
      if (choice === "local") {
        editorValue = pending.local;
      } else {
        const merged = await invoke<{ content: string; conflicted: boolean }>(
          "merge_three_way",
          {
            base: pending.base,
            local: pending.local,
            remote: pending.remote.content,
          },
        );
        editorValue = merged.content;
        if (merged.conflicted) {
          notify(
            "자동 병합할 수 없는 부분에 충돌 표시를 넣었습니다. 확인 후 저장해주세요.",
            "error",
          );
        } else {
          notify("겹치지 않는 변경 사항을 병합했습니다.", "success");
        }
      }
      scheduleDocumentAnalysis(editorValue);
      saveState = "dirty";
      await saveNow();
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function toggleLeft(panel: Exclude<SidePanel, null>): Promise<void> {
    const nextPanel = leftPanel === panel ? null : panel;
    if (nextPanel && typeof window !== "undefined" && window.innerWidth <= 900) {
      rightPanel = null;
    }
    leftPanel = nextPanel;
    if (nextPanel) lastLeftPanel = nextPanel;
    if (leftPanel === "versions") await refreshVersions();
    if (leftPanel === "search") await prepareSearch();
  }

  async function toggleRight(
    panel: Exclude<AssistantPanel, null>,
  ): Promise<void> {
    const nextPanel = rightPanel === panel ? null : panel;
    if (nextPanel && typeof window !== "undefined" && window.innerWidth <= 900) {
      leftPanel = null;
    }
    rightPanel = nextPanel;
    if (nextPanel) lastRightPanel = nextPanel;
    if (rightPanel === "ai" || rightPanel === "proofreading") {
      await refreshAiAccount();
    }
    if (rightPanel === "sources") await refreshSources();
    if (rightPanel === "settings") {
      await Promise.all([
        refreshAiAccount(),
        refreshResearchConnection(),
        refreshResearchWorkspace(),
      ]);
    }
  }

  async function togglePrimaryLeft(): Promise<void> {
    if (leftPanel) {
      lastLeftPanel = leftPanel;
      leftPanel = null;
      return;
    }
    await toggleLeft(lastLeftPanel);
  }

  async function togglePrimaryRight(): Promise<void> {
    if (rightPanel) {
      lastRightPanel = rightPanel;
      rightPanel = null;
      return;
    }
    await toggleRight(lastRightPanel);
  }

  function toggleSingleSheetMode(): void {
    resetChromeSuppression();
    preferences.focusSheetMode = !preferences.focusSheetMode;
    if (preferences.focusSheetMode) {
      leftPanel = null;
      rightPanel = null;
    }
    savePreferences();
  }

  async function selectLeftPanel(
    panel: Exclude<SidePanel, null>,
  ): Promise<void> {
    if (leftPanel === panel) return;
    await toggleLeft(panel);
  }

  async function selectRightPanel(
    panel: Exclude<AssistantPanel, null>,
  ): Promise<void> {
    if (rightPanel === panel) return;
    await toggleRight(panel);
  }

  async function refreshVersions(): Promise<void> {
    if (!desktop || !currentDocument) {
      versions = [];
      return;
    }
    versions = await invoke<VersionSummary[]>("list_versions", {
      path: currentDocument.path,
    }).catch(() => []);
  }

  async function saveNamedVersion(): Promise<void> {
    if (!namedVersion.trim()) return;
    try {
      await createSnapshot("named", namedVersion.trim());
      namedVersion = "";
      await refreshVersions();
      notify("이름 있는 버전을 보관했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function previewVersion(version: VersionSummary): Promise<void> {
    if (!desktop || !currentDocument) return;
    const request = ++versionPreviewRequest;
    const documentPath = currentDocument.path;
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    try {
      const stored = await invoke<StoredVersion>("load_version", {
        id: version.id,
      });
      if (
        request !== versionPreviewRequest ||
        currentDocument?.path !== documentPath
      ) {
        return;
      }
      const currentContent = editorValue;
      versionReturnFocus = returnFocus;
      versionPreview = {
        version,
        documentPath,
        currentContent,
        content: stored.content,
        comparison: compareVersionContent(currentContent, stored.content),
      };
      await tick();
      versionCloseButton?.focus();
    } catch (error) {
      if (request === versionPreviewRequest) {
        notify(errorMessage(error), "error");
      }
    }
  }

  function resetVersionPreview(restoreFocus: boolean): void {
    versionPreviewRequest += 1;
    const returnFocus = versionReturnFocus;
    versionPreview = null;
    versionRestoreBusy = false;
    versionDialog = undefined;
    versionCloseButton = undefined;
    versionReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) {
      void tick().then(() => returnFocus.focus());
    }
  }

  function closeVersionPreview(): void {
    if (versionRestoreBusy) return;
    resetVersionPreview(true);
  }

  function trapVersionPreviewFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !versionDialog) return;
    const focusable = Array.from(
      versionDialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function confirmRestoreVersion(): Promise<void> {
    if (
      !versionPreview ||
      versionRestoreBusy ||
      !desktop ||
      !currentDocument
    ) {
      return;
    }
    const preview = versionPreview;
    if (currentDocument.path !== preview.documentPath) {
      resetVersionPreview(false);
      notify("원고가 바뀌어 이전 버전 비교를 닫았습니다.", "error");
      return;
    }
    if (currentDocument.readOnly) {
      notify("읽기 전용 원고는 이전 버전으로 되돌릴 수 없습니다.", "error");
      return;
    }
    if (editorValue !== preview.currentContent) {
      const currentContent = editorValue;
      versionPreview = {
        ...preview,
        currentContent,
        comparison: compareVersionContent(currentContent, preview.content),
      };
      notify("현재 원고가 바뀌어 비교 내용을 새로 계산했습니다.");
      return;
    }
    versionRestoreBusy = true;
    try {
      await createSnapshot("restore");
      if (currentDocument?.path !== preview.documentPath) {
        throw new Error("복원 중 원고가 바뀌었습니다.");
      }
      editorValue = preview.content;
      scheduleDocumentAnalysis(editorValue);
      saveState = "dirty";
      saveError = "";
      scheduleSave();
      notify("선택한 버전을 편집 화면에 복원했습니다.", "success");
      versionRestoreBusy = false;
      resetVersionPreview(true);
    } catch (error) {
      versionRestoreBusy = false;
      notify(errorMessage(error), "error");
    }
  }

  async function prepareSearch(): Promise<void> {
    if (
      !desktop ||
      !repository?.available ||
      !workspaceRoot ||
      searchBusy ||
      searchIndexed
    ) {
      return;
    }
    searchBusy = true;
    try {
      await invoke<number>("index_workspace", { root: workspaceRoot });
      searchIndexed = true;
      if (searchQuery.trim()) await runSearch();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      searchBusy = false;
    }
  }

  function scheduleSearch(): void {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 180);
  }

  async function runSearch(): Promise<void> {
    if (!desktop || !workspaceRoot || !searchQuery.trim()) {
      searchResults = [];
      return;
    }
    if (!searchIndexed) await prepareSearch();
    searchBusy = true;
    try {
      searchResults = await invoke<SearchResult[]>("search_workspace", {
        root: workspaceRoot,
        query: searchQuery,
      });
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      searchBusy = false;
    }
  }

  async function openSearchResult(result: SearchResult): Promise<void> {
    if (currentDocument?.path === result.path) {
      editorApi?.scrollToLine(result.line);
    } else {
      await openPath(result.path, result.line);
    }
  }

  async function refreshAiAccount(): Promise<void> {
    if (!desktop) {
      aiAccount = {
        codexInstalled: false,
        codexVersion: null,
        authenticated: false,
        accountType: null,
        email: null,
        planType: null,
        message: "AI 연결 상태는 데스크톱 앱에서 확인합니다.",
      };
      return;
    }
    aiAccount = await invoke<AiAccountStatus>("ai_account_status").catch(
      (error) => ({
        codexInstalled: false,
        codexVersion: null,
        authenticated: false,
        accountType: null,
        email: null,
        planType: null,
        message: errorMessage(error),
      }),
    );
  }

  async function startAiLogin(deviceCode = false): Promise<void> {
    if (!desktop) return;
    try {
      login = await invoke<AiLoginStart>("ai_login_start", { deviceCode });
      if (await openExternalUrl(login.url)) {
        notify("브라우저에서 로그인을 마친 뒤 연결 확인을 눌러주세요.", "info");
      }
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  function aiContext(): string {
    if (contextMode === "document") return editorValue;
    if (contextMode === "selection" && selection.text) return selection.text;
    return currentSection(editorValue, selection.from);
  }

  async function runAi(action: string, background = false): Promise<void> {
    if (!desktop || !currentDocument || aiBusy) return;
    const selected = editorApi?.getSelection() ?? selection;
    if (action !== "complete" && !selected.text.trim()) {
      notify("먼저 다듬을 문장을 선택해주세요.", "info");
      return;
    }
    aiBusy = true;
    aiAction = action;
    const contentAtRequest = editorValue;
    if (!background) rightPanel = "ai";
    try {
      await createSnapshot("ai");
      const response = await invoke<AiWritingResponse>("run_ai_writing", {
        request: {
          action,
          selection: action === "complete" ? "" : selected.text,
          documentContext:
            action === "complete"
              ? editorValue.slice(
                  Math.max(0, selected.from - 5500),
                  Math.min(editorValue.length, selected.from + 1000),
                )
              : aiContext(),
          styleReference,
          instructions: aiInstructions,
          sources: sourceContexts,
        },
      });
      if (action === "complete") {
        const latest = editorApi?.getSelection();
        if (
          latest &&
          latest.from === selected.from &&
          latest.to === selected.to &&
          editorValue === contentAtRequest
        ) {
          editorApi?.setGhostText(response.replacement);
        }
      } else {
        suggestion = {
          response,
          action,
          from: selected.from,
          to: selected.to,
          original: selected.text,
        };
      }
    } catch (error) {
      if (!background) notify(errorMessage(error), "error");
    } finally {
      aiBusy = false;
      aiAction = "";
    }
  }

  function applySuggestion(): void {
    if (!suggestion || !editorApi) return;
    const content = editorApi.getContent();
    if (
      content.slice(suggestion.from, suggestion.to) !== suggestion.original
    ) {
      notify(
        "제안 생성 뒤 원문이 바뀌었습니다. 현재 문장을 다시 선택해주세요.",
        "error",
      );
      suggestion = null;
      return;
    }
    editorApi.replaceRange(
      suggestion.from,
      suggestion.to,
      suggestion.response.replacement,
    );
    suggestion = null;
    notify("AI 제안을 원고에 반영했습니다. 실행 취소할 수 있습니다.", "success");
  }

  function scheduleCompletion(): void {
    editorApi?.clearGhostText();
    if (completionTimer) clearTimeout(completionTimer);
    if (!preferences.autoComplete || selection.text || !currentDocument) return;
    completionTimer = setTimeout(() => void runAi("complete", true), 700);
  }

  function noteWritingActivity(): void {
    if (!preferences.immersiveChrome || !currentDocument) return;
    if (chromePauseTimer) clearTimeout(chromePauseTimer);
    chromePauseTimer = setTimeout(() => {
      chromePauseTimer = null;
      chromeSuppressed = false;
      if (chromeStreakTimer) {
        clearTimeout(chromeStreakTimer);
        chromeStreakTimer = null;
      }
    }, 1500);
    if (!chromeStreakTimer) {
      chromeStreakTimer = setTimeout(() => {
        chromeSuppressed = true;
        chromeStreakTimer = null;
      }, 1800);
    }
  }

  function clearChromeTimers(): void {
    if (chromeStreakTimer) clearTimeout(chromeStreakTimer);
    if (chromePauseTimer) clearTimeout(chromePauseTimer);
    chromeStreakTimer = null;
    chromePauseTimer = null;
  }

  function resetChromeSuppression(): void {
    chromeSuppressed = false;
    clearChromeTimers();
  }

  function revealChrome(): void {
    resetChromeSuppression();
  }

  function saveImmersiveChromePreference(): void {
    if (!preferences.immersiveChrome) resetChromeSuppression();
    savePreferences();
  }

  function handleEditorActivity(): void {
    scheduleCompletion();
    noteWritingActivity();
  }

  async function chooseStyleReference(): Promise<void> {
    if (!desktop) return;
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const reference = await invoke<DocumentPayload>("read_document", {
        path: selected,
      });
      styleReference = reference.content.slice(0, 12_000);
      styleReferenceName = basename(selected);
      notify("문체 참고 원고를 이번 세션의 AI 문맥에 추가했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function refreshSources(): Promise<void> {
    await Promise.all([
      refreshZotero(),
      refreshResearchConnection(),
      refreshResearchWorkspace(),
    ]);
    await loadResearchFolders();
  }

  async function refreshZotero(): Promise<void> {
    if (!desktop) return;
    zotero = await invoke<ZoteroStatus>("zotero_status").catch(() => ({
      available: false,
      message: "Zotero 연결 상태를 확인하지 못했습니다.",
    }));
  }

  async function searchZotero(): Promise<void> {
    if (!desktop || zoteroBusy) return;
    zoteroBusy = true;
    try {
      zoteroItems = await invoke<ZoteroItem[]>("zotero_search", {
        query: zoteroQuery,
      });
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      zoteroBusy = false;
    }
  }

  async function insertZoteroCitation(item: ZoteroItem): Promise<void> {
    if (!currentDocument || !(await editableApi())) return;
    try {
      const citation = await invoke<string>("format_zotero_citation", {
        item,
        style: citationStyle,
        locator: citationLocator || null,
        prefix: null,
        suffix: null,
      });
      await insertFootnote(citation, [item.doi, item.url]);
      citationLocator = "";
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function insertFootnote(
    citation: string,
    identities: string[] = [],
  ): Promise<void> {
    const api = await editableApi();
    if (!api || !citation.trim()) return;
    const content = api.getContent();
    const existing = findFootnoteByIdentity(content, identities);
    const id = existing ?? nextFootnoteId(content);
    const selected = api.getSelection();
    if (!existing) {
      const separator = content.endsWith("\n\n")
        ? ""
        : content.endsWith("\n")
          ? "\n"
          : "\n\n";
      api.replaceRange(
        content.length,
        content.length,
        `${separator}[^${id}]: ${citation.trim()}\n`,
      );
    }
    api.replaceRange(selected.from, selected.to, `[^${id}]`);
    notify(
      existing
        ? `기존 각주 ${id}번을 다시 사용했습니다.`
        : `각주 ${id}번을 추가했습니다.`,
      "success",
    );
  }

  async function insertManualCitation(): Promise<void> {
    if (!manualCitation.trim()) return;
    await insertFootnote(manualCitation.trim());
    manualCitation = "";
  }

  async function refreshResearchConnection(): Promise<void> {
    if (!desktop) return;
    researchConnection = await invoke<ResearchConnectionStatus>(
      "research_connection_status",
    ).catch(() => null);
    if (researchConnection?.endpoint) {
      researchEndpoint = researchConnection.endpoint;
    }
  }

  async function refreshResearchWorkspace(): Promise<void> {
    if (!desktop) return;
    researchWorkspace = await invoke<ResearchWorkspaceStatus>(
      "research_workspace_status",
    ).catch(() => null);
  }

  async function chooseResearchWorkspace(): Promise<void> {
    if (!desktop) return;
    const selected = await openDialog({
      title: "Research 작업 폴더 선택",
      directory: true,
      multiple: false,
    });
    if (typeof selected !== "string") return;
    try {
      await invoke("configure_research_workspace", { path: selected });
      await refreshResearchWorkspace();
      await loadResearchFolders();
      notify("로컬 Research 작업 폴더를 연결했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function configureResearch(): Promise<void> {
    if (!desktop) return;
    try {
      await invoke("configure_research_agent", {
        endpoint: researchEndpoint,
        token: researchToken,
      });
      researchToken = "";
      await refreshResearchConnection();
      await loadResearchFolders();
      notify("Research Agent 연결 정보를 OS 보안 저장소에 보관했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function disconnectResearch(): Promise<void> {
    if (!desktop) return;
    try {
      await invoke("clear_research_agent");
      researchEndpoint = "";
      researchToken = "";
      await refreshResearchConnection();
      await loadResearchFolders();
      notify("Research Agent 서버 연결과 저장된 토큰을 지웠습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function loadResearchFolders(): Promise<void> {
    if (
      !desktop ||
      (!researchConnection?.authenticated && !researchWorkspace?.available)
    )
      return;
    try {
      const payload = await invoke<{ research_folders?: ResearchFolder[] }>(
        "research_folders",
      );
      researchFolders = payload.research_folders ?? [];
    } catch {
      researchFolders = [];
    }
  }

  async function loadResearchSources(): Promise<void> {
    if (!desktop || !researchSlug) {
      researchSources = [];
      return;
    }
    try {
      researchSources = await invoke<ResearchSource[]>("research_sources", {
        slug: researchSlug,
      });
      selectedSourceIds = selectedSourceIds.filter((id) =>
        researchSources.some((source) => source.id === id),
      );
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function requestDeepResearch(): Promise<void> {
    if (!desktop || researchBusy || !researchTopic.trim()) return;
    researchBusy = true;
    try {
      await invoke("start_research", { topic: researchTopic });
      researchTopic = "";
      await loadResearchFolders();
      notify(
        "깊은 조사를 Research Agent 큐에 넣었습니다. 원고는 자동으로 바뀌지 않습니다.",
        "success",
      );
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      researchBusy = false;
    }
  }

  function toggleSource(id: string): void {
    selectedSourceIds = selectedSourceIds.includes(id)
      ? selectedSourceIds.filter((value) => value !== id)
      : [...selectedSourceIds, id];
  }

  function loadWebPreview(): void {
    const sample = [
      "# 글을 쓰는 감각을 되찾는 에디터",
      "",
      "연구 도구는 기능이 많아질수록 원고보다 도구 자체를 의식하게 만든다. 이 에디터는 Markdown 파일을 그대로 두고, 쓰는 순간에 필요한 것만 조용히 꺼내는 방향을 택한다.",
      "",
      "## 원고가 먼저다",
      "",
      "화면 가운데에는 스무 칸 스무 줄의 행간 원고지가 놓인다. Markdown 기호는 감추고 완성될 글만 조판하며, 문단 첫 칸과 줄 끝 문장 부호도 원고지 관행에 맞춰 자동으로 배치한다.",
      "",
      "## 리서치는 글 옆에 머문다",
      "",
      "Zotero와 검증된 리서치 출처는 필요할 때만 오른쪽에서 열린다. AI가 제안한 문장은 원문을 덮지 않고 차이로 제시되며, 받아들인 변경은 언제든 되돌릴 수 있다.[^1]",
      "",
      "[^1]: 이 화면은 데스크톱 기능을 설명하기 위한 웹 미리보기입니다.",
      "",
    ].join("\n");
    void setDocument({
      path: "/웹 미리보기/글쓰기 감각.md",
      content: sample,
      hash: "preview",
      lineEnding: "LF",
      bom: false,
      readOnly: false,
      detectedEncoding: "UTF-8",
      modifiedAtMs: Date.now(),
    });
  }

  function keyboardHandler(event: KeyboardEvent): void {
    if (versionPreview) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeVersionPreview();
        return;
      }
      trapVersionPreviewFocus(event);
      if (event.metaKey || event.ctrlKey) event.preventDefault();
      return;
    }
    const command = event.metaKey || event.ctrlKey;
    if (!command) {
      const focusedPath =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("[data-repository-path]")?.dataset
              .repositoryPath
          : undefined;
      const focusedDocument = repositoryDocuments.find(
        (document) => document.path === focusedPath,
      );
      if (
        focusedDocument &&
        event.key === "F2" &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        void beginRename(focusedDocument);
        return;
      }
      if (
        focusedDocument &&
        event.key === "Delete" &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        void trashDocument(focusedDocument);
        return;
      }
      if (event.key === "Escape") {
        if (toolbarMenu) {
          closeToolbarMenu(true);
          return;
        }
        if (documentDialog) {
          documentDialog = null;
          return;
        }
        if (grammarSuggestion) {
          grammarSuggestion = null;
          return;
        }
        if (exitPrompt) {
          exitPrompt = null;
          return;
        }
        if (renamingPath) {
          renamingPath = "";
          return;
        }
        suggestion = null;
        if (!conflict) {
          leftPanel = null;
          rightPanel = null;
        }
      }
      return;
    }
    const formattingTarget =
      event.target instanceof HTMLElement &&
      Boolean(event.target.closest(".editor-host, .source-shell, .topbar"));
    if (
      formattingTarget &&
      !event.shiftKey &&
      event.key.toLowerCase() === "b"
    ) {
      event.preventDefault();
      void formatInline("strong");
    } else if (
      formattingTarget &&
      !event.shiftKey &&
      event.key.toLowerCase() === "i"
    ) {
      event.preventDefault();
      void formatInline("emphasis");
    } else if (
      formattingTarget &&
      !event.shiftKey &&
      event.key.toLowerCase() === "k"
    ) {
      event.preventDefault();
      void openLinkMenu();
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      void createDocument();
    } else if (event.key.toLowerCase() === "q") {
      event.preventDefault();
      void requestAppExit();
    } else if (event.key.toLowerCase() === "o" && event.shiftKey) {
      event.preventDefault();
      void chooseRepository();
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      void chooseDocument();
    } else if (event.key.toLowerCase() === "w") {
      event.preventDefault();
      void closeCurrentDocument();
    } else if (event.key.toLowerCase() === "s" && event.shiftKey) {
      event.preventDefault();
      void saveAs();
    } else if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveNow();
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      void toggleLeft("search");
    } else if (event.key === "\\") {
      event.preventDefault();
      void toggleLeft("outline");
    }
  }

  onMount(async () => {
    desktop = isDesktopRuntime();
    loadPreferences();
    window.addEventListener("keydown", keyboardHandler);
    const toolbarClickAway = (event: PointerEvent) => {
      if (
        toolbarMenu &&
        event.target instanceof HTMLElement &&
        !event.target.closest(".toolbar-menu-host")
      ) {
        toolbarMenu = null;
        toolbarMenuTrigger = null;
      }
    };
    window.addEventListener("pointerdown", toolbarClickAway);
    unlisteners.push(() =>
      window.removeEventListener("pointerdown", toolbarClickAway),
    );
    const blurHandler = () => void saveNow();
    window.addEventListener("blur", blurHandler);
    unlisteners.push(() => window.removeEventListener("blur", blurHandler));

    if (!desktop) {
      loadWebPreview();
      return;
    }

    fonts = await invoke<FontRecord[]>("list_fonts").catch(() => fonts);
    await loadRecents();
    const restoredRepository = await refreshRepository();
    await watchActiveRepository();
    const startup = await invoke<string | null>("startup_document").catch(
      () => null,
    );
    if (startup) {
      await openPath(startup);
    } else if (
      restoredRepository?.available &&
      restoredRepository.lastDocumentPath
    ) {
      await openPath(restoredRepository.lastDocumentPath);
    }
    if (restoredRepository?.available) leftPanel = "repository";

    unlisteners.push(
      await listen<{ path: string }>("external-file-change", (event) => {
        void handleExternalChange(event.payload.path);
      }),
    );
    unlisteners.push(
      await listen<{ path: string }>("repository-change", () => {
        if (repositoryTimer) clearTimeout(repositoryTimer);
        repositoryTimer = setTimeout(() => {
          searchIndexed = false;
          void refreshRepositoryDocuments();
        }, 180);
      }),
    );
    unlisteners.push(
      await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const markdownPath = event.payload.paths.find((value) =>
          /\.(?:md|markdown)$/i.test(value),
        );
        if (markdownPath) {
          void openPath(markdownPath);
          return;
        }
        const folderPath = event.payload.paths[0];
        if (folderPath) void openRepositoryPath(folderPath);
      }),
    );
    unlisteners.push(
      await listen("app-exit-requested", () => {
        void requestAppExit();
      }),
    );
    unlisteners.push(
      await getCurrentWindow().onCloseRequested((event) => {
        if (closing) return;
        event.preventDefault();
        void requestAppExit();
      }),
    );
    await invoke("register_exit_guard");
    syncTimer = setInterval(() => void refreshSync(), 30_000);
  });

  onDestroy(() => {
    window.removeEventListener("keydown", keyboardHandler);
    unlisteners.forEach((unlisten) => unlisten());
    if (saveTimer) clearTimeout(saveTimer);
    if (searchTimer) clearTimeout(searchTimer);
    if (completionTimer) clearTimeout(completionTimer);
    clearChromeTimers();
    resetVersionPreview(false);
    if (toastTimer) clearTimeout(toastTimer);
    if (externalTimer) clearTimeout(externalTimer);
    if (repositoryTimer) clearTimeout(repositoryTimer);
    documentAnalysis.cancel();
    if (syncTimer) clearInterval(syncTimer);
  });
</script>

<svelte:head>
  <title>{documentTitle}</title>
</svelte:head>

<main
  class:panel-left={leftPanel !== null}
  class:panel-right={rightPanel !== null}
  class="app-shell"
  onmousemove={revealChrome}
>
  <header
    class:chrome-hidden={Boolean(currentDocument) &&
      ((chromeSuppressed && preferences.immersiveChrome) ||
        (preferences.focusSheetMode && viewMode === "manuscript"))}
    class="topbar"
  >
    <button
      class:active={leftPanel !== null}
      class="panel-toggle"
      title={leftPanel ? "원고 패널 닫기" : "원고 패널 열기"}
      aria-label={leftPanel ? "원고 패널 닫기" : "원고 패널 열기"}
      aria-expanded={leftPanel !== null}
      aria-controls="left-panel"
      onclick={() => void togglePrimaryLeft()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2"></rect>
        <path d="M9 4v16M6 8h.01M6 12h.01M6 16h.01"></path>
      </svg>
    </button>

    <div class="document-name" title={currentDocument?.path ?? ""}>
      <span>{documentTitle}</span>
      {#if currentDocumentIsStandalone}
        <span class="standalone-badge">저장소 밖</span>
      {/if}
      {#if currentDocument}
        <span
          class:error={saveState === "error"}
          class:saving={saveState === "saving"}
          class="save-dot"
          aria-label={saveState}
        ></span>
        <button
          class="document-close"
          title="현재 원고 닫기 (Ctrl+W)"
          aria-label="현재 원고 닫기"
          onclick={() => void closeCurrentDocument()}
        >×</button>
      {/if}
    </div>

    <div class="writing-toolbar" aria-label="글쓰기 도구">
      <label class="toolbar-select style-select" title="문단의 의미 구조">
        <span class="sr-only">문단 스타일</span>
        <select
          value={activeBlockStyle}
          disabled={formattingDisabled}
          onchange={(event) =>
            void formatBlock(event.currentTarget.value as MarkdownBlockStyle)}
        >
          <option value="body">본문</option>
          <option value="heading2">큰 제목</option>
          <option value="heading3">작은 제목</option>
          <option value="quote">인용</option>
          <option value="bullet">목록</option>
        </select>
      </label>
      <label
        class="toolbar-select font-select"
        title="원고 전체 글꼴 · 원고지 칸 크기는 유지됩니다"
      >
        <span class="sr-only">글꼴</span>
        <select
          bind:value={preferences.fontFamily}
          disabled={!currentDocument}
          onchange={savePreferences}
        >
          {#each fonts as font}
            <option value={font.family}>{font.family}</option>
          {/each}
        </select>
      </label>
      <span class="toolbar-divider"></span>
      <button
        class="format-button"
        title="굵게 (Ctrl+B) · 의미 강조로 저장"
        aria-label="굵게"
        disabled={formattingDisabled}
        onclick={() => void formatInline("strong")}
      ><strong>가</strong></button>
      <button
        class="format-button italic-button"
        title="기울임 (Ctrl+I) · 의미 강조로 저장"
        aria-label="기울임"
        disabled={formattingDisabled}
        onclick={() => void formatInline("emphasis")}
      >가</button>
      <div class="toolbar-menu-host">
        <button
          bind:this={linkMenuButton}
          class:active={toolbarMenu === "link"}
          class="format-button"
          title="링크 (Ctrl+K)"
          aria-label="링크"
          aria-haspopup="dialog"
          aria-expanded={toolbarMenu === "link"}
          disabled={formattingDisabled}
          onclick={() => void openLinkMenu()}
        >↗</button>
        {#if toolbarMenu === "link"}
          <form
            class="toolbar-popover link-popover"
            onsubmit={(event) => {
              event.preventDefault();
              void applyLink();
            }}
          >
            <label for="toolbar-link-url">링크 주소</label>
            <input
              id="toolbar-link-url"
              bind:this={linkInput}
              bind:value={linkUrl}
              inputmode="url"
              placeholder="https://…"
            />
            <button type="submit">적용</button>
          </form>
        {/if}
      </div>
      <div class="toolbar-menu-host compact-menu">
        <button
          class:active={toolbarMenu === "insert"}
          class="toolbar-text-button"
          aria-haspopup="menu"
          aria-expanded={toolbarMenu === "insert"}
          disabled={formattingDisabled}
          onclick={(event) => void toggleToolbarMenu("insert", event.currentTarget)}
        >삽입⌄</button>
        {#if toolbarMenu === "insert"}
          <div
            class="toolbar-popover toolbar-menu"
            role="menu"
            tabindex="-1"
            data-menu="insert"
            onkeydown={handleToolbarMenuKeydown}
          >
            <button role="menuitem" onclick={() => { toolbarMenu = null; openMetadataDialog(); }}>원고 정보</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openFigureDialog(); }}>그림</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openTableDialog(); }}>표</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openMathDialog(); }}>수식</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openFootnoteDialog(); }}>각주</button>
          </div>
        {/if}
      </div>
      <div class="toolbar-menu-host compact-menu">
        <button
          class:active={toolbarMenu === "view"}
          class="toolbar-text-button"
          aria-haspopup="menu"
          aria-expanded={toolbarMenu === "view"}
          disabled={!currentDocument}
          onclick={(event) => void toggleToolbarMenu("view", event.currentTarget)}
        >보기⌄</button>
        {#if toolbarMenu === "view"}
          <div
            class="toolbar-popover toolbar-menu view-menu"
            role="menu"
            tabindex="-1"
            data-menu="view"
            onkeydown={handleToolbarMenuKeydown}
          >
            <button class:active={viewMode === "manuscript"} role="menuitemradio" aria-checked={viewMode === "manuscript"} onclick={() => { closeToolbarMenu(false); void switchDocumentView("manuscript"); }}>원고지</button>
            <button class:active={viewMode === "source"} role="menuitemradio" aria-checked={viewMode === "source"} onclick={() => { closeToolbarMenu(false); void switchDocumentView("source"); }}>Markdown 원문</button>
            <button class:active={viewMode === "preview"} role="menuitemradio" aria-checked={viewMode === "preview"} onclick={() => { closeToolbarMenu(false); void switchDocumentView("preview"); }}>완성본</button>
            <button role="menuitem" onclick={() => { closeToolbarMenu(false); printCompletedDocument(); }}>인쇄·PDF</button>
            <span class="toolbar-menu-divider"></span>
            <button
              class:active={preferences.manuscriptFitMode === "page"}
              role="menuitemradio"
              aria-checked={preferences.manuscriptFitMode === "page"}
              disabled={viewMode !== "manuscript"}
              onclick={() => { closeToolbarMenu(false); setManuscriptFitMode("page"); }}
            >페이지에 맞추기</button>
            <button
              class:active={preferences.manuscriptFitMode === "width"}
              role="menuitemradio"
              aria-checked={preferences.manuscriptFitMode === "width"}
              disabled={viewMode !== "manuscript"}
              onclick={() => { closeToolbarMenu(false); setManuscriptFitMode("width"); }}
            >페이지 너비에 맞추기</button>
            <span class="toolbar-menu-divider"></span>
            <button
              class:active={preferences.focusSheetMode}
              role="menuitemcheckbox"
              aria-checked={preferences.focusSheetMode}
              disabled={viewMode !== "manuscript"}
              onclick={() => { closeToolbarMenu(false); toggleSingleSheetMode(); }}
            >한 장만 보기</button>
          </div>
        {/if}
      </div>
      <button
        class:active={rightPanel === "ai"}
        class="toolbar-text-button ai-toolbar-button"
        disabled={!currentDocument}
        onclick={() => void toggleRight("ai")}
      >AI</button>
    </div>

    <button
      class:active={rightPanel !== null}
      class="panel-toggle tools-toggle"
      title={rightPanel ? "도구 패널 닫기" : "도구 패널 열기"}
      aria-label={`${rightPanel ? "도구 패널 닫기" : "도구 패널 열기"}${diagnostics.length ? `, 규칙 문제 ${diagnostics.length}개` : ""}`}
      aria-expanded={rightPanel !== null}
      aria-controls="right-panel"
      onclick={() => void togglePrimaryRight()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2"></rect>
        <path d="M15 4v16M18 8h.01M18 12h.01M18 16h.01"></path>
      </svg>
      {#if diagnostics.length}
        <span class="panel-count" aria-hidden="true">
          {diagnostics.length > 99 ? "99+" : diagnostics.length}
        </span>
      {/if}
    </button>
  </header>

  {#if leftPanel}
    <aside id="left-panel" class="panel left-panel">
      <div class="panel-heading">
        <div class="panel-tabs">
          <button
            class:active={leftPanel === "repository"}
            onclick={() => void selectLeftPanel("repository")}>원고</button
          >
          <button
            class:active={leftPanel === "outline"}
            onclick={() => void selectLeftPanel("outline")}>개요</button
          >
          <button
            class:active={leftPanel === "search"}
            onclick={() => void selectLeftPanel("search")}>검색</button
          >
          <button
            class:active={leftPanel === "versions"}
            onclick={() => void selectLeftPanel("versions")}>버전</button
          >
        </div>
        <button
          class="close-button"
          aria-label="원고 패널 닫기"
          onclick={() => (leftPanel = null)}
          >×</button
        >
      </div>

      <div
        class:repository-content={leftPanel === "repository"}
        class="panel-content"
      >
        {#if leftPanel === "repository"}
          <div class="repository-panel">
            {#if repository?.available && repository.path}
              <div class="repository-heading">
                <div>
                  <strong>{basename(repository.path)}</strong>
                  <small title={repository.path}>{repository.path}</small>
                </div>
                <div class="repository-heading-actions">
                  <button title="다른 저장소 열기" onclick={() => void chooseRepository()}
                    >열기</button
                  >
                  <button title="저장소 닫기" onclick={() => void closeRepository()}
                    >닫기</button
                  >
                </div>
              </div>
              <div class="repository-toolbar">
                <button
                  disabled={!repository.writable || creatingDocument}
                  onclick={() => void createDocument()}
                >
                  ＋ 새 원고
                </button>
                {#if !repository.writable}
                  <span>읽기 전용</span>
                {/if}
              </div>
              {#if repositoryDocuments.length}
                <nav class="repository-list" aria-label="저장소 원고 목록">
                  {#each repositoryDocuments as document (document.path)}
                    <div
                      class:current={currentDocument?.path === document.path}
                      class="repository-row"
                      data-repository-path={document.path}
                    >
                      {#if renamingPath === document.path}
                        <input
                          class="repository-rename"
                          data-rename-path={document.path}
                          aria-label={`${document.name} 이름 변경`}
                          bind:value={renameValue}
                          onkeydown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitRename(document);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              renamingPath = "";
                            }
                          }}
                          onblur={() => void commitRename(document)}
                        />
                      {:else}
                        <button
                          class="repository-document"
                          data-repository-path={document.path}
                          title={document.path}
                          onclick={() => void openPath(document.path)}
                        >
                          <span>{document.name}</span>
                          <small>
                            {document.readOnly ? "읽기 전용" : displayDate(new Date(document.modifiedAtMs).toISOString())}
                          </small>
                        </button>
                        <div class="repository-row-actions">
                          <button
                            disabled={!repository.writable}
                            title="이름 변경 (F2)"
                            aria-label={`${document.name} 이름 변경`}
                            onclick={() => void beginRename(document)}
                          >✎</button>
                          <button
                            disabled={!repository.writable}
                            title="휴지통으로 이동 (Delete)"
                            aria-label={`${document.name} 휴지통으로 이동`}
                            onclick={() => void trashDocument(document)}
                          >⌫</button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </nav>
              {:else}
                <div class="empty-state small repository-empty">
                  <p>이 저장소에는 아직 원고가 없습니다.</p>
                  <button
                    disabled={!repository.writable}
                    onclick={() => void createDocument()}
                  >첫 원고 만들기</button>
                </div>
              {/if}
            {:else}
              <div class="empty-state repository-empty">
                <p>{repository?.message ?? "원고 저장소를 열어주세요."}</p>
                <button onclick={() => void chooseRepository()}>저장소 열기</button>
                {#if repository?.active}
                  <button onclick={() => void closeRepository()}>기록 닫기</button>
                {/if}
              </div>
            {/if}
          </div>
        {:else if leftPanel === "outline"}
          <p class="eyebrow">문서 구조</p>
          {#if outline.length}
            <nav class="outline-list" aria-label="문서 개요">
              {#each outline as item}
                <button
                  style={`--depth: ${item.level - 1}`}
                  onclick={() => editorApi?.scrollToOffset(item.offset)}
                >
                  <span class="outline-marker">{item.level}</span>
                  <span>{item.title}</span>
                </button>
              {/each}
            </nav>
          {:else}
            <div class="empty-state small">
              <p>제목을 쓰면 문서의 뼈대가 여기에 나타납니다.</p>
              <code>## 두 번째 장</code>
            </div>
          {/if}
        {:else if leftPanel === "search"}
          <p class="eyebrow">Markdown 전체 검색</p>
          <div class="search-row">
            <input
              aria-label="검색어"
              placeholder="단어나 문장"
              bind:value={searchQuery}
              oninput={scheduleSearch}
            />
          </div>
          <div class="search-scope">
            {repository?.available && repository.path
              ? `${basename(repository.path)} · 루트 원고`
              : "검색하려면 저장소를 열어주세요."}
          </div>
          {#if searchBusy}
            <p class="quiet-line">색인과 검색 중…</p>
          {:else if searchQuery && !searchResults.length}
            <div class="empty-state small"><p>일치하는 원고가 없습니다.</p></div>
          {:else}
            <div class="result-list">
              {#each searchResults as result}
                <button onclick={() => void openSearchResult(result)}>
                  <strong>{result.title}</strong>
                  <span>{result.snippet}</span>
                  <small>{basename(result.path)} · {result.line}행</small>
                </button>
              {/each}
            </div>
          {/if}
        {:else}
          <p class="eyebrow">로컬 버전 기록</p>
          <form
            class="named-version"
            onsubmit={(event) => {
              event.preventDefault();
              void saveNamedVersion();
            }}
          >
            <input placeholder="버전 이름" bind:value={namedVersion} />
            <button disabled={!namedVersion.trim()}>보관</button>
          </form>
          <p class="panel-note">
            자동 버전은 최대 1,000개 또는 90일, 이름 있는 버전은 계속
            보관합니다.
          </p>
          <div class="version-list">
            {#each versions as version}
              <button onclick={() => void previewVersion(version)}>
                <span class={`version-kind ${version.kind}`}>
                  {version.kind === "named"
                    ? "이름"
                    : version.kind === "ai"
                      ? "AI 전"
                      : version.kind === "merge"
                        ? "병합 전"
                        : "자동"}
                </span>
                <strong>{version.name ?? displayDate(version.createdAt)}</strong>
                <small>{Math.max(1, Math.round(version.sizeBytes / 1024))} KB</small>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </aside>
  {/if}

  <section class="writing-stage">
    {#if currentDocument}
      {#if currentDocument.readOnly}
        <div class="encoding-banner">
          <span>
            {currentDocument.detectedEncoding} · 읽기 전용
          </span>
          <button onclick={() => void convertEncoding()}>UTF-8로 변환</button>
          <button onclick={() => void saveAs()}>사본 저장</button>
        </div>
      {/if}

      {#if viewMode === "manuscript"}
        <Editor
          value={editorValue}
          readOnly={currentDocument.readOnly}
          fallbackTitle={manuscriptFallbackTitle}
          fontFamily={preferences.fontFamily}
          manuscriptFitMode={preferences.manuscriptFitMode}
          focusMode={preferences.focusMode}
          typewriterMode={preferences.typewriterMode}
          soundEnabled={preferences.soundEnabled}
          singleSheetMode={preferences.focusSheetMode}
          typewriterImperfection={preferences.typewriterImperfection}
          showDiagnostics={preferences.manuscriptGuidance}
          {diagnostics}
          onready={(api) => (editorApi = api)}
          onchange={onEditorChange}
          onselection={handleEditorSelection}
          onactivity={handleEditorActivity}
          onghostaccept={() => notify("자동 완성을 반영했습니다.", "success")}
          onblockactivate={editDocumentBlock}
        />
      {:else if viewMode === "source"}
        <MarkdownSourceEditor
          value={editorValue}
          readOnly={currentDocument.readOnly}
          onready={(api) => (editorApi = api)}
          onchange={onEditorChange}
          onselection={handleEditorSelection}
          onactivity={handleEditorActivity}
        />
      {:else}
        {#if Preview}
          <Preview
            content={editorValue}
            documentPath={currentDocument.path}
            fallbackTitle={manuscriptFallbackTitle}
            fontFamily={preferences.fontFamily}
            {desktop}
            onlink={(url) => void openExternalUrl(url)}
          />
        {/if}
      {/if}

      {#if viewMode !== "preview" && selection.text && !suggestion && !conflict}
        <div class="selection-tools">
          <button onclick={() => void runAi("rewrite")}>다듬기</button>
          <button onclick={() => void runAi("shorten")}>줄이기</button>
          <button onclick={() => void runAi("expand")}>늘리기</button>
          <button onclick={() => void runAi("logic")}>논리</button>
          <button onclick={() => void toggleRight("ai")}>더보기</button>
        </div>
      {/if}

      <footer class="statusbar">
        <div>
          <span>{words.toLocaleString("ko-KR")}단어</span>
          <span>약 {minutes}분</span>
          {#if viewMode === "manuscript"}
            <span>
              {selection.page ?? 1}쪽 · {selection.row ?? 1}행 · {selection.column ?? 1}칸
            </span>
          {:else if viewMode === "source"}
            <span>{selection.line}행 · Markdown 원문</span>
          {:else}
            <span>완성본 미리보기</span>
          {/if}
          {#if diagnostics.length}
            <button
              class="status-diagnostics"
              onclick={() => void toggleRight("proofreading")}
            >규칙 문제 {diagnostics.length}개</button>
          {/if}
        </div>
        <div>
          {#if sync?.folderId}
            <span
              class:warning={sync.conflictFiles.length > 0}
              title={sync.message}
            >
              {sync.conflictFiles.length
                ? `동기화 충돌 ${sync.conflictFiles.length}`
                : sync.state === "idle" && sync.needBytes === 0
                  ? "동기화됨"
                  : "동기화 중"}
            </span>
          {:else if currentSyncProvider}
            <span title={`실제 동기화는 ${currentSyncProvider} 앱이 담당합니다.`}>
              {currentSyncProvider} 폴더
            </span>
          {:else}
            <span>로컬 저장</span>
          {/if}
          <span>
            {saveState === "saving"
              ? "저장 중"
              : saveState === "dirty"
                ? "변경됨"
                : saveState === "error"
                  ? "저장 확인 필요"
                  : "저장됨"}
          </span>
        </div>
      </footer>
    {:else if repository?.available && repository.path}
      <div class="repository-home">
        <div class="repository-home-paper" aria-hidden="true">
          <span>20 × 20</span>
          <strong>NO. 1</strong>
        </div>
        <p class="welcome-kicker">OPEN REPOSITORY</p>
        <h1>{basename(repository.path)}</h1>
        <p>
          왼쪽 원고 목록에서 파일을 열거나<br />
          이 저장소에 새 원고를 만드세요.
        </p>
        <div class="welcome-actions">
          <button
            class="primary-button"
            disabled={!repository.writable || creatingDocument}
            onclick={() => void createDocument()}
          >
            {creatingDocument ? "만드는 중…" : "새 원고"}
          </button>
          <button class="secondary-button" onclick={() => void chooseDocument()}>
            파일 열기
          </button>
        </div>
        <button class="welcome-repository" onclick={() => void chooseRepository()}>
          다른 저장소 열기
        </button>
      </div>
    {:else}
      <div class="welcome">
        <div class="welcome-seal" aria-hidden="true">
          <span>원</span><span>고</span>
        </div>
        <p class="welcome-kicker">LOCAL · MARKDOWN · MANUSCRIPT</p>
        <h1>원고지</h1>
        <p class="welcome-copy">
          폴더를 저장소로 열고,<br />
          한 글자씩 원고지 위에 써 내려갑니다.
        </p>
        <div class="welcome-actions">
          <button
            class="primary-button"
            disabled={repositoryBusy}
            onclick={() => void chooseRepository()}
          >
            {repositoryBusy ? "여는 중…" : "저장소 열기"}
          </button>
          <button class="secondary-button" onclick={() => void chooseDocument()}>
            파일 열기
          </button>
        </div>
        {#if repository?.active && !repository.available}
          <div class="missing-repository">
            <strong>마지막 저장소를 찾을 수 없습니다.</strong>
            <span title={repository.path ?? ""}>{repository.path}</span>
            <button onclick={() => void closeRepository()}>저장소 기록 닫기</button>
          </div>
        {/if}
        {#if recents.length}
          <div class="recent-block">
            <p>최근 원고</p>
            {#each recents.slice(0, 6) as recent}
              <button onclick={() => void openPath(recent.path)}>
                <span>{recent.title}</span>
                <small>{displayDate(recent.openedAt)}</small>
              </button>
            {/each}
          </div>
        {/if}
        <p class="welcome-shortcuts">
          Ctrl+Shift+O 저장소 · Ctrl+N 새 원고 · Ctrl+W 닫기 · Ctrl+Q 끝내기
        </p>
      </div>
    {/if}
  </section>

  {#if rightPanel}
    <aside id="right-panel" class="panel right-panel">
      <div class="panel-heading">
        <div class="panel-tabs">
          <button
            class:active={rightPanel === "proofreading"}
            onclick={() => void selectRightPanel("proofreading")}>교정</button
          >
          <button
            class:active={rightPanel === "ai"}
            onclick={() => void selectRightPanel("ai")}>AI</button
          >
          <button
            class:active={rightPanel === "sources"}
            onclick={() => void selectRightPanel("sources")}>출처</button
          >
          <button
            class:active={rightPanel === "settings"}
            onclick={() => void selectRightPanel("settings")}>설정</button
          >
        </div>
        <button
          class="close-button"
          aria-label="도구 패널 닫기"
          onclick={() => (rightPanel = null)}
          >×</button
        >
      </div>

      <div class="panel-content right-content">
        {#if rightPanel === "proofreading"}
          <section class="panel-section guidance-intro">
            <p class="eyebrow">원고지 작성 안내</p>
            <h3>규칙을 외우지 않아도 됩니다</h3>
            <p>
              문단 첫 칸, 숫자·영문 칸쓰기와 줄 끝 문장 부호는 원문을
              손상하지 않고 자동 배치합니다. 판단이 필요한 부분만 아래에
              설명합니다.
            </p>
            <div class="guidance-checklist">
              <span><b>1</b> Enter는 새 문단, Shift+Enter는 줄바꿈</span>
              <span><b>2</b> 문단과 인용문의 들여쓰기는 자동</span>
              <span><b>3</b> 표·그림·수식은 상단 삽입 도구 사용</span>
            </div>
            <button class="wide-button" onclick={openMetadataDialog}
              >제목·작성자 원고 정보</button
            >
          </section>

          <section class="panel-section">
            <div class="proof-heading">
              <div>
                <p class="eyebrow">현재 원고</p>
                <strong>
                  {analysisPending
                    ? "교정 갱신 중…"
                    : diagnostics.length
                      ? `${diagnostics.length}개 확인 필요`
                      : "원고지 규칙에 맞습니다"}
                </strong>
              </div>
              {#if safeDiagnosticCount}
                <button onclick={() => void applyAllSafeDiagnostics()}>
                  안전 수정 {safeDiagnosticCount}
                </button>
              {/if}
            </div>
            {#if analysisPending}
              <div class="empty-state small proof-empty" aria-live="polite">
                <p>입력을 마치면 잠시 후 교정 결과를 갱신합니다.</p>
              </div>
            {:else if diagnostics.length}
              <div class="diagnostic-list">
                {#each diagnostics as item (item.id)}
                  <article class={`diagnostic-card ${item.severity}`}>
                    <button
                      class="diagnostic-main"
                      onclick={() => void moveToDiagnostic(item)}
                    >
                      <span class="diagnostic-label">
                        {item.severity === "error"
                          ? "오류"
                          : item.severity === "warning"
                            ? "확인"
                            : "안내"}
                      </span>
                      <strong>{item.title}</strong>
                      <p>{item.message}</p>
                      {#if item.example}<code>{item.example}</code>{/if}
                      <small>{item.source}</small>
                    </button>
                    <div class="diagnostic-actions">
                      <button onclick={() => void moveToDiagnostic(item)}>이동</button>
                      {#if item.fix}
                        <button
                          class="accent"
                          onclick={() => void applyDiagnosticFix(item)}
                        >{item.fix.label}</button>
                      {/if}
                    </div>
                  </article>
                {/each}
              </div>
            {:else}
              <div class="empty-state small proof-empty">
                <p>확정적인 원고지 문제를 찾지 못했습니다.</p>
              </div>
            {/if}
          </section>

          <section class="panel-section">
            <p class="eyebrow">AI 맞춤법·문법 검사</p>
            <p class="panel-note">
              아래 버튼을 누를 때만 선택한 범위가 Codex로 전송됩니다.
              자동 백그라운드 검사는 하지 않습니다.
            </p>
            <div class="segmented grammar-scope">
              <button
                class:active={grammarScope === "selection"}
                onclick={() => (grammarScope = "selection")}>선택</button
              >
              <button
                class:active={grammarScope === "paragraph"}
                onclick={() => (grammarScope = "paragraph")}>현재 문단</button
              >
              <button
                class:active={grammarScope === "document"}
                onclick={() => (grammarScope = "document")}>전체</button
              >
            </div>
            <button
              class="wide-button accent"
              disabled={grammarBusy || !currentDocument}
              onclick={() => void runGrammarCheck()}
            >
              {grammarBusy ? "문법을 살피는 중…" : "문법 검사 실행"}
            </button>
            {#if !aiAccount?.authenticated}
              <p class="panel-note">
                AI 검사는 ChatGPT 연결이 필요하지만 위의 원고지 규칙 검사는
                로그인 없이 항상 동작합니다.
              </p>
              <button class="wide-button" onclick={() => void startAiLogin(false)}
                >ChatGPT로 연결</button
              >
            {/if}
          </section>
        {:else if rightPanel === "ai"}
          <section class="panel-section">
            <p class="eyebrow">작문 보조</p>
            {#if aiAccount?.authenticated}
              <div class="connection-line success">
                <span></span>
                <div>
                  <strong>Codex 연결됨</strong>
                  <small>{aiAccount.email ?? aiAccount.planType ?? "ChatGPT OAuth"}</small>
                </div>
              </div>
            {:else}
              <div class="connection-card">
                <strong>ChatGPT로 연결</strong>
                <p>{aiAccount?.message ?? "연결 상태를 확인하고 있습니다."}</p>
                <div class="button-row">
                  <button onclick={() => void startAiLogin(false)}
                    >브라우저 로그인</button
                  >
                  <button onclick={() => void startAiLogin(true)}
                    >기기 코드</button
                  >
                </div>
                {#if login?.userCode}
                  <code class="device-code">{login.userCode}</code>
                  <button class="link-button" onclick={() => void refreshAiAccount()}
                    >로그인 완료 확인</button
                  >
                {/if}
              </div>
            {/if}
          </section>

          <section class="panel-section">
            <p class="eyebrow">보낼 문맥</p>
            <div class="segmented">
              <button
                class:active={contextMode === "selection"}
                onclick={() => (contextMode = "selection")}>선택</button
              >
              <button
                class:active={contextMode === "section"}
                onclick={() => (contextMode = "section")}>현재 절</button
              >
              <button
                class:active={contextMode === "document"}
                onclick={() => (contextMode = "document")}>전체</button
              >
            </div>
            <div class="context-chips">
              {#if selection.text}<span>선택 {countWords(selection.text)}단어</span>{/if}
              {#if styleReferenceName}<span>문체 · {styleReferenceName}</span>{/if}
              {#if sourceContexts.length}<span>출처 {sourceContexts.length}개</span>{/if}
            </div>
            <button class="path-button" onclick={() => void chooseStyleReference()}>
              <span>{styleReferenceName || "문체 참고 원고 선택"}</span>
              <small>{styleReferenceName ? "교체" : "선택"}</small>
            </button>
          </section>

          <section class="panel-section">
            <p class="eyebrow">선택 문장</p>
            <div class="action-grid">
              <button disabled={!selection.text || aiBusy} onclick={() => void runAi("rewrite")}>
                <strong>다듬기</strong><small>뜻은 그대로</small>
              </button>
              <button disabled={!selection.text || aiBusy} onclick={() => void runAi("shorten")}>
                <strong>짧게</strong><small>군더더기 제거</small>
              </button>
              <button disabled={!selection.text || aiBusy} onclick={() => void runAi("expand")}>
                <strong>확장</strong><small>논증 풀어쓰기</small>
              </button>
              <button disabled={!selection.text || aiBusy} onclick={() => void runAi("style")}>
                <strong>문체 맞춤</strong><small>참고 원고 기준</small>
              </button>
              <button disabled={!selection.text || aiBusy} onclick={() => void runAi("logic")}>
                <strong>논리 점검</strong><small>흐름과 비약</small>
              </button>
              <button
                disabled={!selection.text || aiBusy}
                onclick={() => void runAi("counterargument")}
              >
                <strong>반론</strong><small>한계 보강</small>
              </button>
              <button
                disabled={!selection.text || aiBusy || !sourceContexts.length}
                onclick={() => void runAi("evidence")}
              >
                <strong>근거 강화</strong><small>선택 출처만</small>
              </button>
            </div>
            <textarea
              rows="3"
              placeholder="이번 제안에만 적용할 지시"
              bind:value={aiInstructions}
            ></textarea>
            {#if aiBusy}
              <p class="working-line">
                <span></span>{aiAction === "complete" ? "다음 문장" : "제안"}을
                만들고 있습니다…
              </p>
            {/if}
          </section>

          <section class="panel-section">
            <label class="switch-row">
              <div>
                <strong>자동 이어쓰기</strong>
                <small>700ms 멈추면 흐린 제안, Tab으로 수락</small>
              </div>
              <input
                type="checkbox"
                bind:checked={preferences.autoComplete}
                onchange={savePreferences}
              />
            </label>
          </section>
        {:else if rightPanel === "sources"}
          <section class="panel-section">
            <p class="eyebrow">Zotero 라이브러리</p>
            <div class:success={zotero?.available} class="connection-line">
              <span></span>
              <div>
                <strong>{zotero?.available ? "연결됨" : "선택 연결"}</strong>
                <small>{zotero?.message ?? "Zotero 상태 확인 중"}</small>
              </div>
            </div>
            {#if zotero?.available}
              <form
                class="source-search"
                onsubmit={(event) => {
                  event.preventDefault();
                  void searchZotero();
                }}
              >
                <input placeholder="제목, 저자, 연도, 태그" bind:value={zoteroQuery} />
                <button disabled={zoteroBusy}>검색</button>
              </form>
              <div class="citation-options">
                <select bind:value={citationStyle} aria-label="인용 형식">
                  <option value="research">현재 리서치 형식</option>
                  <option value="apa">APA 간이 형식</option>
                  <option value="chicago">Chicago Notes 간이 형식</option>
                </select>
                <input placeholder="p. 14" bind:value={citationLocator} />
              </div>
              <div class="source-list">
                {#each zoteroItems as item}
                  <article>
                    <strong>{item.title}</strong>
                    <p>{item.authors.join(", ") || item.publisher || "저자 미상"}</p>
                    <small>{item.year} {item.publication}</small>
                    <button onclick={() => void insertZoteroCitation(item)}
                      >각주로 넣기</button
                    >
                  </article>
                {/each}
              </div>
            {:else}
              <p class="panel-note">
                Zotero는 필수가 아닙니다. 설치되어 있다면 설정의 고급 탭에서
                로컬 API를 허용하고 Zotero를 실행하세요. 별도 API 키는
                필요하지 않습니다.
              </p>
            {/if}
          </section>

          <section class="panel-section">
            <p class="eyebrow">검증된 리서치 출처</p>
            {#if researchConnection?.authenticated || researchWorkspace?.available}
              {#if researchWorkspace?.available && !researchConnection?.authenticated}
                <p class="panel-note">
                  로컬 Research 출처 색인과 검증 카드를 사용하고 있습니다.
                </p>
              {/if}
              <select
                bind:value={researchSlug}
                onchange={() => void loadResearchSources()}
              >
                <option value="">리서치 선택</option>
                {#each researchFolders as folder}
                  <option value={folder.slug}>{folder.title}</option>
                {/each}
              </select>
              <div class="source-list research-list">
                {#each researchSources as source}
                  <article>
                    <label class="source-check">
                      <input
                        type="checkbox"
                        checked={selectedSourceIds.includes(source.id)}
                        onchange={() => toggleSource(source.id)}
                      />
                      <span>{source.id}</span>
                    </label>
                    <strong>{source.title}</strong>
                    <small>{source.publisher} · {source.classification}</small>
                    <div class="article-actions">
                      <button
                        disabled={!source.citationMarkdown}
                        onclick={() =>
                          void insertFootnote(source.citationMarkdown, [source.url])}
                      >
                        각주
                      </button>
                      {#if source.url}
                        <button onclick={() => void openExternalUrl(source.url)}
                          >원문</button
                        >
                      {/if}
                    </div>
                  </article>
                {/each}
              </div>
            {:else}
              <p class="panel-note">
                설정에서 Research Agent 서버 또는 로컬 Research 작업 폴더를
                연결하면 검증된 출처를 AI 문맥이나 각주로 사용할 수 있습니다.
              </p>
            {/if}
          </section>

          <section class="panel-section">
            <p class="eyebrow">수동 각주</p>
            <textarea
              rows="3"
              placeholder="저자, 제목, 발행처, URL, 확인일"
              bind:value={manualCitation}
            ></textarea>
            <button
              class="wide-button"
              disabled={!manualCitation.trim()}
              onclick={insertManualCitation}
            >
              완전한 Markdown 각주로 넣기
            </button>
          </section>

          <section class="panel-section">
            <p class="eyebrow">깊은 조사</p>
            <textarea
              rows="3"
              placeholder="조사할 질문을 적으세요. 원고는 자동으로 덮어쓰지 않습니다."
              bind:value={researchTopic}
            ></textarea>
            <button
              class="wide-button accent"
              disabled={!researchConnection?.authenticated || !researchTopic.trim() || researchBusy}
              onclick={() => void requestDeepResearch()}
            >
              Research Agent에 요청
            </button>
          </section>
        {:else}
          <section class="panel-section">
            <p class="eyebrow">기본 설정</p>
            <label class="field">
              <span>화면</span>
              <select bind:value={preferences.theme} onchange={savePreferences}>
                <option value="system">시스템 설정</option>
                <option value="light">밝은 작업대</option>
                <option value="dark">어두운 작업대</option>
              </select>
            </label>
            <label class="field">
              <span>집중 모드</span>
              <select bind:value={preferences.focusMode} onchange={savePreferences}>
                <option value="off">끄기</option>
                <option value="paragraph">현재 문단</option>
                <option value="sentence">현재 문장</option>
              </select>
            </label>
            <label class="switch-row">
              <div>
                <strong>원고지 작성 안내</strong>
                <small>규칙 문제를 칸과 교정 패널에 표시</small>
              </div>
              <input
                type="checkbox"
                bind:checked={preferences.manuscriptGuidance}
                onchange={savePreferences}
              />
            </label>
          </section>

          <section class="panel-section">
            <button
              class:active={advancedSettingsOpen}
              class="settings-advanced-toggle"
              onclick={() => (advancedSettingsOpen = !advancedSettingsOpen)}
            >
              <span>고급 설정</span>
              <small>{advancedSettingsOpen ? "접기" : "타자기·연구 연결"}</small>
            </button>
          </section>

          {#if advancedSettingsOpen}
            <section class="panel-section advanced-settings">
              <p class="eyebrow">쓰기 감각</p>
              <label class="switch-row">
                <div><strong>타자기 스크롤</strong><small>커서를 화면 가운데에 유지</small></div>
                <input type="checkbox" bind:checked={preferences.typewriterMode} onchange={savePreferences} />
              </label>
              <label class="switch-row">
                <div><strong>절제된 타건음</strong><small>기본값은 꺼짐</small></div>
                <input type="checkbox" bind:checked={preferences.soundEnabled} onchange={savePreferences} />
              </label>
              <label class="switch-row">
                <div><strong>몰입 중 도구막대 숨기기</strong><small>계속 타이핑하면 옅어지고, 마우스를 움직이거나 멈추면 다시 보임</small></div>
                <input type="checkbox" bind:checked={preferences.immersiveChrome} onchange={saveImmersiveChromePreference} />
              </label>
              <label class="switch-row">
                <div><strong>타자기 활자 느낌</strong><small>글자마다 미세하게 기울고 흔들리는 잉크 농담 표현</small></div>
                <input type="checkbox" bind:checked={preferences.typewriterImperfection} onchange={savePreferences} />
              </label>
            </section>

            <section class="panel-section advanced-settings">
              <p class="eyebrow">Research Agent 연결</p>
              <button class="path-button" onclick={() => void chooseResearchWorkspace()}>
                <span>{researchWorkspace?.path ? basename(researchWorkspace.path) : "로컬 Research 작업 폴더"}</span>
                <small>{researchWorkspace?.available ? "변경" : "선택"}</small>
              </button>
              <label class="field">
                <span>서버 주소</span>
                <input bind:value={researchEndpoint} placeholder="https://…" />
              </label>
              <label class="field">
                <span>Bearer 토큰</span>
                <input type="password" bind:value={researchToken} placeholder={researchConnection?.authenticated ? "저장됨 · 변경할 때만 입력" : "토큰 입력"} />
              </label>
              <button class="wide-button" disabled={!researchEndpoint || !researchToken} onclick={() => void configureResearch()}>
                안전하게 연결
              </button>
              {#if researchConnection?.configured}
                <button class="wide-button" onclick={() => void disconnectResearch()}>연결 해제</button>
              {/if}
            </section>

            <section class="panel-section advanced-settings">
              <p class="eyebrow">AI 보안</p>
              <p class="panel-note">
                {aiAccount?.message ?? "Codex 상태 확인 중"}. 토큰은 Codex와 운영체제 보안 저장소가 관리합니다.
              </p>
            </section>
          {/if}
        {/if}
      </div>
    </aside>
  {/if}
</main>

{#if documentDialog}
  <div class="modal-backdrop" role="presentation">
    {#if documentDialog === "metadata"}
      <div
        class="modal document-element-modal"
        role="dialog"
        aria-modal="true"
        aria-label="원고 정보"
        use:modalFocus
      >
        <form
          class="modal-form"
          onsubmit={(event) => {
            event.preventDefault();
            void saveMetadata();
          }}
        >
        <header>
          <div>
            <p class="eyebrow">첫 장 배치</p>
            <h2>원고 정보</h2>
          </div>
          <button type="button" class="close-button" onclick={() => (documentDialog = null)}
            >×</button
          >
        </header>
        <div class="metadata-form">
          <label class="field">
            <span>제목</span>
            <input required bind:value={metadataDraft.title} />
          </label>
          <label class="field">
            <span>부제</span>
            <input bind:value={metadataDraft.subtitle} />
          </label>
          <label class="field">
            <span>글의 종류</span>
            <input placeholder="논문, 수필, 평론…" bind:value={metadataDraft.genre} />
          </label>
          <label class="field">
            <span>소속</span>
            <input bind:value={metadataDraft.affiliation} />
          </label>
          <label class="field">
            <span>이름</span>
            <input bind:value={metadataDraft.author} />
          </label>
        </div>
        <p class="panel-note">
          정보는 호환 가능한 YAML 속성으로 저장되고 원고지 첫 장에서는
          전통 배치로 표시됩니다.
        </p>
        <footer>
          <button type="button" class="secondary-button" onclick={() => (documentDialog = null)}
            >취소</button
          >
          <button class="primary-button" disabled={currentDocument?.readOnly}
            >반영</button
          >
        </footer>
        </form>
      </div>
    {:else if documentDialog === "figure"}
      <div
        class="modal document-element-modal"
        role="dialog"
        aria-modal="true"
        aria-label="그림 삽입"
        use:modalFocus
      >
        <form
          class="modal-form"
          onsubmit={(event) => {
            event.preventDefault();
            void insertFigure();
          }}
        >
        <header>
          <div><p class="eyebrow">문서 요소</p><h2>그림 넣기</h2></div>
          <button type="button" class="close-button" onclick={() => (documentDialog = null)}
            >×</button
          >
        </header>
        <button type="button" class="asset-picker" onclick={() => void chooseFigureSource()}>
          <span>{figureSourcePath ? basename(figureSourcePath) : "PNG·JPEG·WebP·GIF 선택"}</span>
          <small>{figureSourcePath ? "다른 파일" : "최대 20MiB"}</small>
        </button>
        <label class="field">
          <span>대체 텍스트</span>
          <input placeholder="그림이 보이지 않을 때 전달할 설명" bind:value={figureAlt} />
        </label>
        <label class="field">
          <span>캡션</span>
          <input placeholder="그림 1. 연구 흐름" bind:value={figureCaption} />
        </label>
        <p class="panel-note">
          원본은 건드리지 않고 원고 옆 assets 폴더에 안전한 이름으로
          복사합니다.
        </p>
        <footer>
          <button type="button" class="secondary-button" onclick={() => (documentDialog = null)}
            >취소</button
          >
          <button class="primary-button" disabled={!figureSourcePath}>그림 넣기</button>
        </footer>
        </form>
      </div>
    {:else if documentDialog === "table"}
      <div
        class="modal document-element-modal table-modal"
        role="dialog"
        aria-modal="true"
        aria-label="표 삽입"
        use:modalFocus
      >
        <form
          class="modal-form"
          onsubmit={(event) => {
            event.preventDefault();
            void insertTable();
          }}
        >
        <header>
          <div><p class="eyebrow">문서 요소</p><h2>표 만들기</h2></div>
          <button type="button" class="close-button" onclick={() => (documentDialog = null)}
            >×</button
          >
        </header>
        <div class="table-size-controls">
          <span>{tableRows}행 × {tableColumns}열</span>
          <div>
            <button type="button" onclick={() => resizeTable(tableRows + 1, tableColumns)}
              >＋행</button
            >
            <button type="button" onclick={() => resizeTable(tableRows - 1, tableColumns)}
              >−행</button
            >
            <button type="button" onclick={() => resizeTable(tableRows, tableColumns + 1)}
              >＋열</button
            >
            <button type="button" onclick={() => resizeTable(tableRows, tableColumns - 1)}
              >−열</button
            >
          </div>
        </div>
        <div
          class="table-cell-editor"
          style={`--table-columns: ${tableColumns}`}
        >
          {#each tableCells as row, rowIndex}
            {#each row as _, columnIndex}
              <input
                aria-label={`${rowIndex + 1}행 ${columnIndex + 1}열`}
                class:header-cell={rowIndex === 0}
                bind:value={tableCells[rowIndex][columnIndex]}
              />
            {/each}
          {/each}
        </div>
        <footer>
          <button type="button" class="secondary-button" onclick={() => (documentDialog = null)}
            >취소</button
          >
          <button class="primary-button">표 넣기</button>
        </footer>
        </form>
      </div>
    {:else if documentDialog === "math"}
      <div
        class="modal document-element-modal"
        role="dialog"
        aria-modal="true"
        aria-label="수식 삽입"
        use:modalFocus
      >
        <form
          class="modal-form"
          onsubmit={(event) => {
            event.preventDefault();
            void insertMath();
          }}
        >
        <header>
          <div><p class="eyebrow">KaTeX</p><h2>수식 넣기</h2></div>
          <button type="button" class="close-button" onclick={() => (documentDialog = null)}
            >×</button
          >
        </header>
        <div class="segmented math-kind">
          <button type="button" class:active={!mathDisplay} onclick={() => (mathDisplay = false)}
            >문장 안</button
          >
          <button type="button" class:active={mathDisplay} onclick={() => (mathDisplay = true)}
            >별도 블록</button
          >
        </div>
        <label class="field">
          <span>LaTeX 수식</span>
          <textarea rows="6" placeholder="E = mc^2" bind:value={mathValue}></textarea>
        </label>
        <footer>
          <button type="button" class="secondary-button" onclick={() => (documentDialog = null)}
            >취소</button
          >
          <button class="primary-button" disabled={!mathValue.trim()}>수식 넣기</button>
        </footer>
        </form>
      </div>
    {:else if documentDialog === "footnote"}
      <div
        class="modal document-element-modal"
        role="dialog"
        aria-modal="true"
        aria-label="각주 삽입"
        use:modalFocus
      >
        <form
          class="modal-form"
          onsubmit={(event) => {
            event.preventDefault();
            void insertFootnoteFromDialog();
          }}
        >
        <header>
          <div><p class="eyebrow">문서 요소</p><h2>각주 넣기</h2></div>
          <button type="button" class="close-button" onclick={() => (documentDialog = null)}
            >×</button
          >
        </header>
        <label class="field">
          <span>각주 내용</span>
          <textarea
            rows="6"
            placeholder="저자, 제목, 발행처, 쪽수 또는 설명"
            bind:value={footnoteValue}
          ></textarea>
        </label>
        <p class="panel-note">
          커서 위치에는 각주 번호를, 원고 끝에는 표준 Markdown 각주 정의를
          넣습니다.
        </p>
        <footer>
          <button type="button" class="secondary-button" onclick={() => (documentDialog = null)}
            >취소</button
          >
          <button class="primary-button" disabled={!footnoteValue.trim()}>각주 넣기</button>
        </footer>
        </form>
      </div>
    {:else}
      <div
        class="modal document-element-modal"
        role="dialog"
        aria-modal="true"
        aria-label="문서 요소 편집"
        use:modalFocus
      >
        <form
          class="modal-form"
          onsubmit={(event) => {
            event.preventDefault();
            void saveDocumentBlock();
          }}
        >
        <header>
          <div>
            <p class="eyebrow">{activeBlock?.kind ?? "문서 요소"}</p>
            <h2>{activeBlock?.label ?? "문서 요소 편집"}</h2>
          </div>
          <button type="button" class="close-button" onclick={() => (documentDialog = null)}
            >×</button
          >
        </header>
        <label class="field">
          <span>Markdown 원문</span>
          <textarea rows="12" spellcheck="false" bind:value={blockSource}></textarea>
        </label>
        <p class="panel-note">
          표와 그림의 휴대성을 위해 이 대화상자에서는 해당 블록의 표준
          Markdown만 편집합니다.
        </p>
        <footer>
          <button type="button" class="secondary-button" onclick={() => (documentDialog = null)}
            >취소</button
          >
          <button class="primary-button">반영</button>
        </footer>
        </form>
      </div>
    {/if}
  </div>
{/if}

{#if grammarSuggestion}
  <div class="modal-backdrop" role="presentation">
    <div
      class="modal grammar-modal"
      role="dialog"
      aria-modal="true"
      aria-label="AI 문법 검사 결과"
      use:modalFocus
    >
      <header>
        <div>
          <p class="eyebrow">AI 문법 검사 · {grammarSuggestion.response.model}</p>
          <h2>원문은 아직 바뀌지 않았습니다</h2>
        </div>
        <button
          class="close-button"
          aria-label="문법 검사 결과 닫기"
          onclick={() => (grammarSuggestion = null)}
        >×</button>
      </header>
      <div class="diff-view">
        {#each diffWords(grammarSuggestion.original, grammarSuggestion.response.correctedText) as part}
          <span class:added={part.added} class:removed={part.removed}>
            {part.value}
          </span>
        {/each}
      </div>
      {#if grammarSuggestion.response.rationale}
        <p class="rationale">{grammarSuggestion.response.rationale}</p>
      {/if}
      {#if grammarSuggestion.response.warnings.length}
        <div class="grammar-warnings">
          {#each grammarSuggestion.response.warnings as warning}
            <p>{warning}</p>
          {/each}
        </div>
      {/if}
      {#if grammarEdits.length}
        <div class="grammar-edit-list">
          {#each grammarEdits as edit, index}
            <article>
              <span>{index + 1}</span>
              <div>
                <del>{edit.expected || "삽입"}</del>
                <ins>{edit.replacement || "삭제"}</ins>
              </div>
              <button onclick={() => void applyGrammarEdit(edit)}>이 변경만</button>
            </article>
          {/each}
        </div>
      {/if}
      <footer>
        <button class="secondary-button" onclick={() => (grammarSuggestion = null)}
          >닫기</button
        >
        {#if grammarSuggestion.response.correctedText !== grammarSuggestion.original}
          <button
            class="primary-button"
            onclick={() =>
              void applyGrammarReplacement(grammarSuggestion?.response.correctedText ?? "")}
          >모두 반영</button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

{#if suggestion}
  <div class="modal-backdrop" role="presentation">
    <div
      class="modal suggestion-modal"
      role="dialog"
      aria-modal="true"
      aria-label="AI 작문 제안"
      use:modalFocus
    >
      <header>
        <div>
          <p class="eyebrow">AI 제안 · {suggestion.response.model}</p>
          <h2>원문은 그대로 두었습니다</h2>
        </div>
        <button
          class="close-button"
          aria-label="AI 제안 닫기"
          onclick={() => (suggestion = null)}
        >×</button>
      </header>
      <div class="diff-view">
        {#each diffWords(suggestion.original, suggestion.response.replacement) as part}
          <span class:added={part.added} class:removed={part.removed}>
            {part.value}
          </span>
        {/each}
      </div>
      {#if suggestion.response.rationale}
        <p class="rationale">{suggestion.response.rationale}</p>
      {/if}
      {#if suggestion.response.citations.length}
        <div class="context-chips">
          {#each suggestion.response.citations as citation}
            <span>출처 {citation}</span>
          {/each}
        </div>
      {/if}
      <footer>
        <button class="secondary-button" onclick={() => (suggestion = null)}
          >거절</button
        >
        <button class="primary-button" onclick={applySuggestion}>반영</button>
      </footer>
    </div>
  </div>
{/if}

{#if versionPreview}
  <div class="modal-backdrop" role="presentation">
    <div
      class="modal version-compare-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-preview-title"
      aria-describedby="version-preview-description"
      aria-busy={versionRestoreBusy}
      bind:this={versionDialog}
    >
      <header>
        <div>
          <p class="eyebrow">
            버전 비교 · {versionPreview.version.name ??
              displayDate(versionPreview.version.createdAt)}
          </p>
          <h2 id="version-preview-title">이 버전으로 되돌리면 이렇게 바뀝니다</h2>
        </div>
        <button
          class="close-button"
          aria-label="버전 비교 닫기"
          disabled={versionRestoreBusy}
          bind:this={versionCloseButton}
          onclick={closeVersionPreview}
        >×</button>
      </header>
      <div class="proof-sheet">
        <span class="proof-sheet-stamp">교정</span>
        {#each versionPreview.comparison.parts as part}
          {#if part.removed}<del>{part.value}</del
            >{:else if part.added}<ins>{part.value}</ins
            >{:else}<span>{part.value}</span>{/if}
        {/each}
      </div>
      <p class="panel-note" id="version-preview-description">
        빨간 취소선은 지금 원고에서 사라질 부분, 삽입 표시(⌃)는 이 버전에서
        되돌아올 부분입니다. 되돌리기 전 지금 원고도 자동으로 한 벌
        보관합니다.
        {#if versionPreview.comparison.granularity === "line"}
          긴 원고이므로 줄 단위로 비교했습니다.
        {:else if versionPreview.comparison.granularity === "coarse"}
          차이가 매우 커 전체 변경 단위로 간략히 표시했습니다.
        {/if}
      </p>
      <footer>
        <button
          class="secondary-button"
          disabled={versionRestoreBusy}
          onclick={closeVersionPreview}
          >취소</button
        >
        <button
          class="primary-button"
          disabled={versionRestoreBusy ||
            !versionPreview.comparison.changed ||
            currentDocument?.readOnly}
          onclick={() => void confirmRestoreVersion()}
          >{versionRestoreBusy
            ? "복원 준비 중…"
            : versionPreview.comparison.changed
              ? "이 버전으로 되돌리기"
              : "현재 원고와 같습니다"}</button
        >
      </footer>
    </div>
  </div>
{/if}

{#if conflict}
  <div class="modal-backdrop" role="presentation">
    <div
      class="modal conflict-modal"
      role="alertdialog"
      aria-modal="true"
      aria-label="동기화 충돌 해결"
      use:modalFocus
    >
      <p class="eyebrow">동기화 충돌</p>
      <h2>같은 원고가 다른 곳에서도 바뀌었습니다</h2>
      <p>
        내 편집과 다른 장치의 편집을 모두 보존했습니다. 자동 병합을 먼저
        시도하거나 한쪽을 선택할 수 있습니다.
      </p>
      <div class="conflict-columns">
        <div><strong>내 편집</strong><pre>{conflict.local.slice(0, 900)}</pre></div>
        <div
          ><strong>다른 장치</strong><pre>{conflict.remote.content.slice(0, 900)}</pre></div
        >
      </div>
      <footer>
        <button onclick={() => void resolveConflict("remote")}>다른 장치 사용</button>
        <button onclick={() => void resolveConflict("local")}>내 편집 사용</button>
        <button class="primary-button" onclick={() => void resolveConflict("merge")}
          >자동 병합</button
        >
      </footer>
    </div>
  </div>
{/if}

{#if exitPrompt}
  <div class="modal-backdrop exit-backdrop" role="presentation">
    <div
      class="modal exit-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="exit-dialog-title"
      use:modalFocus
    >
      <p class="eyebrow">{exitPrompt.conflict ? "동기화 충돌" : "저장 실패"}</p>
      <h2 id="exit-dialog-title">마지막 편집을 확인해주세요</h2>
      <p>{exitPrompt.message}</p>
      <footer>
        <button class="secondary-button" onclick={() => (exitPrompt = null)}>
          취소
        </button>
        {#if exitPrompt.conflict}
          <button
            class="primary-button"
            onclick={() => (exitPrompt = null)}
          >충돌 해결로 돌아가기</button>
        {:else}
          <button
            class="primary-button"
            onclick={() => {
              exitPrompt = null;
              void requestAppExit();
            }}
          >다시 저장</button>
        {/if}
        <button class="danger-button" onclick={() => void finishAppExit()}>
          저장하지 않고 끝내기
        </button>
      </footer>
    </div>
  </div>
{/if}

{#if toast}
  <div class:error={toastKind === "error"} class:success={toastKind === "success"} class="toast">
    {toast}
  </div>
{/if}

<style>
  .app-shell {
    display: grid;
    grid-template:
      "top top top" 46px
      "left stage right" minmax(0, 1fr) /
      0 minmax(0, 1fr) 0;
    width: 100vw;
    height: 100vh;
    background: var(--chrome);
    color: var(--ink);
    overflow: hidden;
    transition: grid-template-columns 180ms ease;
  }

  .app-shell.panel-left {
    grid-template-columns: 286px minmax(0, 1fr) 0;
  }

  .app-shell.panel-right {
    grid-template-columns: 0 minmax(0, 1fr) 342px;
  }

  .app-shell.panel-left.panel-right {
    grid-template-columns: 278px minmax(0, 1fr) 334px;
  }

  .topbar {
    grid-area: top;
    z-index: 30;
    display: grid;
    grid-template-columns: auto minmax(120px, 220px) minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 46px;
    padding: 0 10px;
    border-bottom: 1px solid var(--rule);
    background-color: color-mix(in srgb, var(--chrome) 96%, transparent);
    background-image: var(--hanji-texture);
    background-blend-mode: soft-light;
    background-size: 320px 320px;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.25);
    backdrop-filter: blur(8px);
    transition: opacity 700ms ease;
  }

  .topbar.chrome-hidden {
    opacity: 0.06;
    transition: opacity 900ms ease;
  }

  .topbar.chrome-hidden:hover,
  .topbar.chrome-hidden:focus-within {
    opacity: 1;
    transition: opacity 120ms ease;
  }

  .panel-toggle,
  .format-button,
  .toolbar-text-button,
  .close-button,
  .link-button {
    border: 0;
    background: transparent;
    color: var(--ink-muted);
  }

  .panel-toggle,
  .toolbar-text-button {
    height: 30px;
    border-radius: 7px;
    font-size: var(--type-control);
    font-weight: 680;
    white-space: nowrap;
  }

  .toolbar-text-button {
    padding: 0 9px;
  }

  .panel-toggle:hover,
  .format-button:hover:not(:disabled),
  .toolbar-text-button:hover:not(:disabled) {
    color: var(--ink-strong);
    background: color-mix(in srgb, var(--ink-strong) 6%, transparent);
  }

  .panel-toggle.active,
  .format-button.active,
  .toolbar-text-button.active {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    box-shadow: inset 0 -2px var(--accent);
    color: var(--accent);
  }

  .panel-toggle {
    position: relative;
    display: grid;
    place-items: center;
    width: 32px;
    min-width: 32px;
    height: 32px;
    padding: 0;
  }

  .panel-toggle svg {
    display: block;
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.7;
  }

  .panel-count {
    position: absolute;
    top: -3px;
    right: -5px;
    display: grid;
    place-items: center;
    min-width: 16px;
    height: 16px;
    border: 2px solid var(--paper);
    border-radius: 8px;
    background: var(--warning);
    padding: 0 3px;
    color: white;
    font-size: 9px;
    font-weight: 750;
    line-height: 1;
  }

  .tools-toggle {
    justify-self: end;
  }

  .document-name {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    min-width: 0;
    gap: 8px;
    color: var(--ink-muted);
    font-size: var(--type-control);
    letter-spacing: 0.01em;
  }

  .document-name > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .standalone-badge {
    flex: 0 0 auto;
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 2px 6px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .document-close {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--ink-faint);
    font-size: 16px;
  }

  .document-close:hover {
    background: var(--paper-deep);
    color: var(--ink-strong);
  }

  .save-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--success);
  }

  .save-dot.saving {
    background: var(--warning);
    animation: pulse 1s infinite;
  }

  .save-dot.error {
    background: var(--danger);
  }

  .writing-toolbar {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    gap: 2px;
  }

  .toolbar-select {
    display: block;
    min-width: 0;
  }

  .toolbar-select select {
    height: 30px;
    max-width: 126px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 0 24px 0 7px;
    color: var(--ink-muted);
    font-family: var(--ui-font);
    font-size: var(--type-control);
  }

  .style-select select {
    width: 92px;
  }

  .font-select select {
    width: 124px;
  }

  .toolbar-select select:hover:not(:disabled),
  .toolbar-select select:focus {
    outline: 0;
    background: color-mix(in srgb, var(--ink-strong) 6%, transparent);
    color: var(--ink-strong);
  }

  .toolbar-divider {
    width: 1px;
    height: 18px;
    margin: 0 3px;
    background: var(--rule);
  }

  .format-button {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    font-size: 15px;
  }

  .italic-button {
    font-style: italic;
  }

  .format-button:disabled,
  .toolbar-text-button:disabled,
  .toolbar-select select:disabled {
    opacity: 0.38;
  }

  .toolbar-menu-host {
    position: relative;
    display: flex;
  }

  .toolbar-popover {
    position: absolute;
    z-index: 60;
    top: 36px;
    left: 50%;
    min-width: 150px;
    transform: translateX(-50%);
    border: 1px solid var(--rule);
    border-radius: 8px;
    background-color: var(--surface-raised);
    background-image: var(--hanji-texture);
    background-blend-mode: soft-light;
    background-size: 320px 320px;
    padding: 6px;
    box-shadow: var(--shadow-float);
  }

  .toolbar-menu {
    display: grid;
    gap: 2px;
  }

  .toolbar-menu button {
    height: 32px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 0 10px;
    color: var(--ink-muted);
    text-align: left;
    white-space: nowrap;
  }

  .toolbar-menu button:hover,
  .toolbar-menu button.active {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--accent);
  }

  .toolbar-menu-divider {
    height: 1px;
    margin: 4px 6px;
    background: var(--rule);
  }

  .link-popover {
    display: grid;
    grid-template-columns: minmax(190px, 1fr) auto;
    gap: 5px;
    width: 300px;
  }

  .link-popover label {
    grid-column: 1 / -1;
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .link-popover input,
  .link-popover button {
    height: 32px;
  }

  .link-popover input {
    min-width: 0;
  }

  .link-popover button {
    border: 0;
    border-radius: 6px;
    background: var(--accent);
    padding: 0 11px;
    color: white;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .writing-stage {
    grid-area: stage;
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background-color: var(--desk);
    background-image:
      var(--hanji-texture),
      radial-gradient(
        ellipse at 50% 8%,
        color-mix(in srgb, white 18%, transparent),
        transparent 54%
      ),
      linear-gradient(
        115deg,
        color-mix(in srgb, var(--desk) 90%, #756d62),
        var(--desk)
      );
    background-blend-mode: soft-light, normal, normal;
    background-size: 320px 320px, auto, auto;
  }

  .panel {
    z-index: 10;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background-color: var(--panel);
    background-image: var(--hanji-texture);
    background-blend-mode: soft-light;
    background-size: 320px 320px;
  }

  .left-panel {
    grid-area: left;
    border-right: 1px solid var(--rule);
  }

  .right-panel {
    grid-area: right;
    border-left: 1px solid var(--rule);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 10px 0 14px;
    border-bottom: 1px solid var(--rule);
    background: color-mix(in srgb, var(--chrome) 45%, transparent);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.13);
  }

  .panel-tabs {
    display: flex;
    gap: 2px;
  }

  .panel-tabs button {
    position: relative;
    border: 0;
    border-radius: 4px;
    background: transparent;
    padding: 7px 9px;
    color: var(--ink-muted);
    font-size: var(--type-control);
  }

  .panel-tabs button.active {
    background: transparent;
    box-shadow: inset 0 -2px var(--accent);
    color: var(--accent);
  }

  .close-button {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    font-size: 20px;
  }

  .close-button:hover {
    background: var(--paper);
    color: var(--ink-strong);
  }

  .panel-content {
    height: calc(100% - 48px);
    padding: 20px 16px 36px;
    overflow: auto;
  }

  .panel-content.repository-content {
    padding: 0;
  }

  .repository-panel {
    min-height: 100%;
  }

  .repository-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 16px 12px 12px;
    border-bottom: 1px solid var(--rule);
  }

  .repository-heading > div:first-child {
    min-width: 0;
  }

  .repository-heading strong,
  .repository-heading small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repository-heading strong {
    color: var(--ink-strong);
    font-size: var(--type-body);
  }

  .repository-heading small {
    margin-top: 3px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .repository-heading-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 2px;
  }

  .repository-heading-actions button,
  .repository-toolbar button,
  .repository-row-actions button,
  .repository-empty button {
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .repository-heading-actions button:hover,
  .repository-toolbar button:hover,
  .repository-row-actions button:hover,
  .repository-empty button:hover {
    background: var(--paper);
    color: var(--ink-strong);
  }

  .repository-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 8px;
    border-bottom: 1px solid var(--rule);
  }

  .repository-toolbar button {
    padding: 6px 8px;
  }

  .repository-toolbar span {
    padding-right: 6px;
    color: var(--warning);
    font-size: var(--type-micro);
  }

  .repository-list {
    display: flex;
    flex-direction: column;
    padding: 7px;
  }

  .repository-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    min-height: 46px;
    border-radius: 6px;
  }

  .repository-row:hover,
  .repository-row.current {
    background: color-mix(in srgb, var(--surface-raised) 70%, transparent);
  }

  .repository-row.current {
    box-shadow: inset 3px 0 var(--accent);
  }

  .repository-document {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 7px 8px 7px 10px;
    color: var(--ink);
    text-align: left;
  }

  .repository-document span,
  .repository-document small {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repository-document span {
    font-size: var(--type-control);
  }

  .repository-document small {
    margin-top: 2px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .repository-row-actions {
    display: flex;
    padding-right: 4px;
    opacity: 0;
  }

  .repository-row:hover .repository-row-actions,
  .repository-row:focus-within .repository-row-actions {
    opacity: 1;
  }

  .repository-row-actions button {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    padding: 0;
  }

  .repository-rename {
    grid-column: 1 / -1;
    min-width: 0;
    margin: 5px 6px;
    padding: 6px 7px;
    font-size: var(--type-control);
  }

  .repository-empty {
    align-content: center;
    gap: 8px;
    padding: 18px;
  }

  .repository-empty button {
    border: 1px solid var(--rule);
    background: var(--paper-raised);
    padding: 7px 10px;
  }

  .right-content {
    padding-left: 18px;
    padding-right: 18px;
  }

  .proof-button {
    letter-spacing: 0.02em;
  }

  .guidance-intro h3 {
    margin: 0 0 8px;
    color: var(--ink-strong);
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-reading);
    font-weight: 600;
  }

  .guidance-intro > p:not(.eyebrow) {
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.65;
  }

  .guidance-checklist {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 13px 0;
  }

  .guidance-checklist span {
    display: grid;
    grid-template-columns: 20px 1fr;
    align-items: center;
    gap: 6px;
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .guidance-checklist b {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--type-micro);
  }

  .proof-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .proof-heading .eyebrow {
    margin-bottom: 4px;
  }

  .proof-heading strong {
    color: var(--ink-strong);
    font-size: var(--type-control);
  }

  .proof-heading > button {
    flex: 0 0 auto;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: transparent;
    padding: 5px 7px;
    color: var(--accent);
    font-size: var(--type-micro);
  }

  .diagnostic-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 13px;
  }

  .diagnostic-card {
    overflow: hidden;
    border: 1px solid var(--rule);
    border-left-width: 3px;
    border-radius: 8px;
    background: var(--paper-raised);
  }

  .diagnostic-card.error {
    border-left-color: var(--danger);
  }

  .diagnostic-card.warning {
    border-left-color: var(--warning);
  }

  .diagnostic-card.suggestion {
    border-left-color: #658489;
  }

  .diagnostic-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 10px 10px 8px;
    color: var(--ink);
    text-align: left;
  }

  .diagnostic-main:hover {
    background: var(--paper);
  }

  .diagnostic-label {
    margin-bottom: 5px;
    border-radius: 8px;
    background: var(--paper-deep);
    padding: 2px 6px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .diagnostic-main strong {
    font-size: var(--type-control);
    line-height: 1.45;
  }

  .diagnostic-main p {
    margin: 4px 0;
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.55;
  }

  .diagnostic-main code {
    margin: 3px 0;
    color: var(--accent);
    font-size: var(--type-micro);
    white-space: normal;
  }

  .diagnostic-main small {
    margin-top: 4px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .diagnostic-actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    border-top: 1px solid var(--rule);
    padding: 5px 7px;
  }

  .diagnostic-actions button {
    border: 0;
    border-radius: 5px;
    background: transparent;
    padding: 4px 6px;
    color: var(--ink-muted);
    font-size: var(--type-micro);
  }

  .diagnostic-actions button.accent {
    color: var(--accent);
  }

  .proof-empty {
    min-height: 90px;
  }

  .grammar-scope {
    margin: 10px 0 7px;
  }

  .eyebrow {
    margin: 0 0 12px;
    color: var(--ink-muted);
    font-size: var(--type-micro);
    font-weight: 760;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .outline-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .outline-list button {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: 5px;
    width: 100%;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 7px 8px 7px calc(7px + var(--depth) * 9px);
    color: var(--ink);
    text-align: left;
    font-size: var(--type-control);
    line-height: 1.45;
  }

  .outline-list button:hover {
    background: var(--paper);
  }

  .outline-marker {
    color: var(--ink-faint);
    font-size: var(--type-micro);
    line-height: 1.9;
  }

  .empty-state {
    display: grid;
    place-items: center;
    min-height: 180px;
    color: var(--ink-muted);
    text-align: center;
  }

  .empty-state.small {
    min-height: 120px;
    font-size: var(--type-body);
  }

  .empty-state code {
    color: var(--ink-faint);
  }

  .search-row input,
  .source-search input {
    width: 100%;
  }

  .search-scope {
    margin-top: 8px;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: var(--paper-raised);
    padding: 9px 10px;
    color: var(--ink-faint);
    font-size: var(--type-caption);
  }

  .path-button {
    display: flex;
    justify-content: space-between;
    width: 100%;
    margin-top: 8px;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: var(--paper-raised);
    padding: 9px 10px;
    color: var(--ink-muted);
    text-align: left;
    font-size: var(--type-control);
  }

  .path-button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-button small {
    color: var(--accent);
  }

  .repository-path {
    align-items: flex-start;
    gap: 10px;
  }

  .repository-path span {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .repository-path small {
    flex: 0 0 auto;
  }

  .quiet-line,
  .working-line {
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .result-list,
  .version-list,
  .source-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 14px;
  }

  .result-list > button,
  .version-list > button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    width: 100%;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    padding: 9px;
    color: var(--ink);
    text-align: left;
  }

  .result-list > button:hover,
  .version-list > button:hover {
    border-color: var(--rule);
    background: var(--paper);
  }

  .result-list strong,
  .version-list strong {
    font-size: var(--type-control);
  }

  .result-list span {
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.5;
  }

  .result-list small,
  .version-list small {
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .named-version {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
  }

  .named-version input {
    min-width: 0;
  }

  .named-version button,
  .source-search button {
    border: 1px solid var(--rule-strong);
    border-radius: 7px;
    background: var(--paper-raised);
    padding: 0 12px;
    font-size: var(--type-control);
  }

  .panel-note {
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.65;
  }

  .version-list > button {
    position: relative;
    padding-left: 58px;
  }

  .version-kind {
    position: absolute;
    left: 7px;
    top: 10px;
    width: 43px;
    border-radius: 10px;
    background: var(--paper-raised);
    padding: 3px 0;
    color: var(--ink-muted);
    font-size: var(--type-micro);
    text-align: center;
  }

  .version-kind.named {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .encoding-banner {
    position: absolute;
    z-index: 8;
    top: 10px;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 8px;
    transform: translateX(-50%);
    border: 1px solid var(--rule);
    border-radius: 9px;
    background: var(--paper-raised);
    padding: 7px 9px 7px 13px;
    box-shadow: var(--shadow);
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .encoding-banner button {
    border: 0;
    border-radius: 5px;
    background: var(--paper-deep);
    padding: 5px 8px;
    font-size: var(--type-control);
  }

  .selection-tools {
    position: absolute;
    z-index: 9;
    bottom: 40px;
    left: 50%;
    display: flex;
    gap: 2px;
    transform: translateX(-50%);
    border: 1px solid var(--rule);
    border-radius: 9px;
    background: var(--paper-raised);
    padding: 4px;
    box-shadow: var(--shadow);
  }

  .selection-tools button {
    border: 0;
    border-radius: 5px;
    background: transparent;
    padding: 6px 9px;
    color: var(--ink-muted);
    font-size: var(--type-control);
  }

  .selection-tools button:hover {
    background: var(--paper-deep);
    color: var(--ink-strong);
  }

  .statusbar {
    position: absolute;
    z-index: 5;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    justify-content: space-between;
    height: 28px;
    padding: 0 14px;
    border-top: 1px solid color-mix(in srgb, var(--rule) 72%, transparent);
    background: color-mix(in srgb, var(--chrome) 94%, transparent);
    color: var(--ink-muted);
    font-size: var(--type-micro);
    pointer-events: none;
  }

  .statusbar > div {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .statusbar .warning {
    color: var(--danger);
  }

  .status-diagnostics {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--warning);
    font-size: var(--type-micro);
    pointer-events: auto;
  }

  .status-diagnostics:hover {
    color: var(--accent);
  }

  .welcome,
  .repository-home {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 40px;
    text-align: center;
  }

  .welcome > * {
    position: relative;
    z-index: 1;
  }

  .welcome-seal {
    display: grid;
    grid-template-rows: 1fr 1fr;
    place-items: center;
    width: 38px;
    height: 52px;
    margin-bottom: 18px;
    border: 1.5px solid color-mix(in srgb, var(--accent) 82%, transparent);
    border-radius: 2px;
    background-color: var(--sheet);
    background-image: var(--hanji-texture);
    background-size: 160px 160px;
    box-shadow: var(--shadow-contact);
    color: var(--accent);
    font-family: MaruBuri, Georgia, serif;
    font-size: 13px;
    line-height: 1;
    transform: rotate(-1deg);
  }

  .welcome-seal span + span {
    width: 70%;
    border-top: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    padding-top: 4px;
  }

  .repository-home {
    color: var(--ink-muted);
  }

  .repository-home h1 {
    max-width: min(620px, 84vw);
    margin: 8px 0 0;
    overflow: hidden;
    color: var(--ink-strong);
    font-family: MaruBuri, Georgia, serif;
    font-size: 34px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repository-home > p:not(.welcome-kicker) {
    margin: 13px 0 22px;
    font-size: var(--type-body);
    line-height: 1.75;
  }

  .repository-home-paper {
    position: relative;
    width: 232px;
    height: 142px;
    margin-bottom: 23px;
    border: 1px solid rgba(151, 61, 52, 0.52);
    background-color: var(--sheet);
    background-image:
      var(--hanji-texture),
      linear-gradient(to right, rgba(174, 79, 69, 0.34) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(174, 79, 69, 0.34) 1px, transparent 1px);
    background-position: 0 0, 15px 43px, 15px 43px;
    background-size: 160px 160px, 10px 10px, 10px 10px;
    box-shadow: var(--shadow-paper);
    color: rgba(135, 64, 57, 0.7);
  }

  .repository-home-paper::after {
    position: absolute;
    top: 42px;
    right: 15px;
    bottom: 19px;
    left: 15px;
    border: 1px solid rgba(151, 61, 52, 0.58);
    content: "";
  }

  .repository-home-paper span,
  .repository-home-paper strong {
    position: absolute;
    top: 19px;
    z-index: 2;
    font-family: var(--ui-font);
    font-size: 8px;
    font-weight: 500;
    letter-spacing: 0.1em;
  }

  .repository-home-paper span {
    left: 16px;
  }

  .repository-home-paper strong {
    right: 16px;
  }

  .welcome-kicker {
    margin: 0 0 14px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
    letter-spacing: 0.18em;
  }

  .welcome h1 {
    margin: 0;
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-welcome-title);
    font-weight: 400;
    letter-spacing: -0.06em;
    color: var(--ink-strong);
  }

  .welcome-copy {
    margin: 16px 0 24px;
    color: var(--ink-muted);
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-reading);
    line-height: 1.8;
  }

  .welcome-actions,
  .button-row,
  .modal footer {
    display: flex;
    justify-content: center;
    gap: 8px;
  }

  .primary-button,
  .secondary-button {
    min-width: 104px;
    border-radius: 6px;
    padding: 9px 17px;
    font-size: var(--type-control);
  }

  .primary-button {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff9f3;
  }

  .primary-button:hover:not(:disabled),
  .wide-button.accent:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink-strong));
    box-shadow: var(--shadow-contact);
  }

  .secondary-button {
    border: 1px solid var(--rule-strong);
    background: var(--paper-raised);
  }

  .welcome-repository {
    margin: 14px 0 0;
    color: var(--ink-faint);
    font-size: var(--type-caption);
  }

  button.welcome-repository {
    border: 0;
    background: transparent;
    padding: 3px 6px;
  }

  button.welcome-repository:hover {
    color: var(--ink-muted);
  }

  .missing-repository {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: min(440px, 80vw);
    margin-top: 18px;
    border: 1px solid var(--rule);
    border-radius: 9px;
    background: var(--paper-raised);
    padding: 12px;
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .missing-repository span {
    overflow: hidden;
    color: var(--ink-faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .missing-repository button {
    align-self: center;
    border: 0;
    background: transparent;
    color: var(--accent);
  }

  .recent-block {
    display: flex;
    flex-direction: column;
    width: min(420px, 80vw);
    margin-top: 30px;
  }

  .recent-block > p {
    color: var(--ink-faint);
    font-size: var(--type-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .recent-block button {
    display: flex;
    justify-content: space-between;
    border: 0;
    border-top: 1px solid var(--rule);
    background: transparent;
    padding: 9px 4px;
    color: var(--ink-muted);
    font-size: var(--type-control);
  }

  .recent-block small {
    color: var(--ink-faint);
    font-size: var(--type-caption);
  }

  .recent-block button:hover {
    color: var(--ink-strong);
  }

  .welcome-shortcuts {
    margin-top: 24px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .panel-section {
    padding: 2px 0 20px;
    margin-bottom: 20px;
    border-bottom: 1px solid color-mix(in srgb, var(--rule) 74%, transparent);
  }

  .panel-section:last-child {
    border-bottom: 0;
  }

  .connection-line {
    display: grid;
    grid-template-columns: 9px 1fr;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .connection-line > span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ink-faint);
  }

  .connection-line.success > span {
    background: var(--success);
  }

  .connection-line div {
    display: flex;
    flex-direction: column;
  }

  .connection-line strong {
    font-size: var(--type-control);
  }

  .connection-line small {
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.45;
  }

  .connection-card {
    border: 1px solid var(--rule);
    border-radius: 9px;
    background: var(--paper-raised);
    padding: 13px;
  }

  .connection-card strong {
    font-size: var(--type-control);
  }

  .connection-card p {
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.55;
  }

  .button-row button,
  .article-actions button,
  .source-list article > button {
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--paper);
    padding: 6px 9px;
    font-size: var(--type-control);
  }

  .device-code {
    display: block;
    margin: 12px 0 5px;
    padding: 8px;
    text-align: center;
    letter-spacing: 0.12em;
  }

  .link-button {
    width: 100%;
    padding: 5px;
    color: var(--accent);
    font-size: var(--type-caption);
  }

  .segmented {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border: 1px solid var(--rule);
    border-radius: 7px;
    padding: 2px;
  }

  .segmented button {
    border: 0;
    border-radius: 5px;
    background: transparent;
    padding: 6px;
    color: var(--ink-muted);
    font-size: var(--type-control);
  }

  .segmented button.active {
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-raised));
    box-shadow: inset 0 -2px var(--accent);
    color: var(--accent);
  }

  .context-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 9px 0;
  }

  .context-chips span {
    border: 1px solid var(--rule);
    border-radius: 12px;
    background: var(--paper-raised);
    padding: 3px 7px;
    color: var(--ink-muted);
    font-size: var(--type-micro);
  }

  .action-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    margin-bottom: 9px;
  }

  .action-grid button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: color-mix(in srgb, var(--surface-raised) 42%, transparent);
    padding: 9px;
    text-align: left;
  }

  .action-grid button:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 42%, var(--rule));
    background: color-mix(in srgb, var(--surface-raised) 78%, transparent);
  }

  .action-grid strong {
    font-size: var(--type-control);
  }

  .action-grid small {
    margin-top: 2px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
    line-height: 1.35;
  }

  .panel-section textarea {
    width: 100%;
    resize: vertical;
    font-size: var(--type-control);
    line-height: 1.55;
  }

  .working-line {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .working-line span {
    width: 7px;
    height: 7px;
    border: 1px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 10px 0;
  }

  .switch-row > div {
    display: flex;
    flex-direction: column;
  }

  .switch-row strong,
  .field > span {
    font-size: var(--type-control);
  }

  .switch-row small {
    color: var(--ink-faint);
    font-size: var(--type-caption);
    line-height: 1.5;
  }

  .switch-row input {
    flex: 0 0 auto;
    width: 36px;
    height: 20px;
    appearance: none;
    border: 0;
    border-radius: 10px;
    background:
      radial-gradient(
        circle at 9px 50%,
        var(--surface-raised) 0 6px,
        transparent 6.5px
      ),
      var(--rule-strong);
    padding: 0;
    transition: background-color 140ms ease;
  }

  .switch-row input:checked {
    background:
      radial-gradient(
        circle at calc(100% - 9px) 50%,
        #fffaf3 0 6px,
        transparent 6.5px
      ),
      var(--accent);
  }

  .source-search {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
  }

  .citation-options {
    display: grid;
    grid-template-columns: 1fr 72px;
    gap: 6px;
    margin-top: 6px;
  }

  .citation-options select,
  .citation-options input,
  .source-search input {
    min-width: 0;
    padding: 7px;
    font-size: var(--type-control);
  }

  .source-list article {
    position: relative;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper-raised);
    padding: 10px;
  }

  .source-list article > strong {
    display: block;
    padding-right: 52px;
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-control);
    line-height: 1.4;
  }

  .source-list article p,
  .source-list article small {
    display: block;
    margin: 4px 0;
    color: var(--ink-muted);
    font-size: var(--type-micro);
    line-height: 1.4;
  }

  .source-list article > button {
    position: absolute;
    right: 8px;
    bottom: 8px;
  }

  .source-check {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 3px;
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .source-check input {
    accent-color: var(--accent);
  }

  .article-actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 7px;
  }

  .wide-button {
    width: 100%;
    margin-top: 7px;
    border: 1px solid var(--rule-strong);
    border-radius: 7px;
    background: var(--paper-raised);
    padding: 8px 10px;
    font-size: var(--type-control);
  }

  .wide-button.accent {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff9f3;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 10px 0;
  }

  .field > span {
    display: flex;
    justify-content: space-between;
  }

  .field select,
  .field input {
    width: 100%;
    min-width: 0;
    font-size: var(--type-control);
  }

  .settings-fact {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 10px 0;
  }

  .settings-fact strong {
    font-size: var(--type-control);
  }

  .settings-fact span {
    color: var(--ink-muted);
    font-size: var(--type-caption);
    line-height: 1.55;
  }

  .settings-advanced-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 42px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper-raised);
    padding: 0 11px;
    color: var(--ink-strong);
  }

  .settings-advanced-toggle small {
    color: var(--ink-faint);
  }

  .settings-advanced-toggle.active {
    border-color: color-mix(in srgb, var(--accent) 48%, var(--rule));
  }

  .advanced-settings {
    background: color-mix(in srgb, var(--paper-raised) 52%, transparent);
  }

  .danger-note {
    border-left: 2px solid var(--danger);
    padding-left: 9px;
    color: var(--danger);
    font-size: var(--type-caption);
    line-height: 1.55;
  }

  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: color-mix(in srgb, var(--ink-strong) 38%, transparent);
    backdrop-filter: blur(5px);
  }

  .modal {
    width: min(680px, 94vw);
    max-height: 88vh;
    overflow: auto;
    border: 1px solid var(--rule);
    border-radius: 9px;
    background-color: var(--surface-raised);
    background-image: var(--hanji-texture);
    background-blend-mode: soft-light;
    background-size: 320px 320px;
    padding: 22px;
    box-shadow: var(--shadow-float);
  }

  .modal-form {
    margin: 0;
  }

  .modal > header,
  .modal-form > header {
    display: flex;
    justify-content: space-between;
  }

  .modal h2 {
    margin: 0 0 12px;
    color: var(--ink-strong);
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-dialog-title);
    font-weight: 500;
  }

  .document-element-modal {
    width: min(720px, 94vw);
  }

  .metadata-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 12px;
  }

  .metadata-form .field:first-child,
  .metadata-form .field:nth-child(2) {
    grid-column: 1 / -1;
  }

  .asset-picker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin: 8px 0 15px;
    border: 1px dashed var(--rule-strong);
    border-radius: 9px;
    background: var(--paper);
    padding: 18px;
    color: var(--ink-muted);
    text-align: left;
  }

  .asset-picker:hover {
    border-color: var(--accent);
  }

  .asset-picker small {
    color: var(--accent);
    font-size: var(--type-caption);
  }

  .table-modal {
    width: min(880px, 96vw);
  }

  .table-size-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 5px 0 10px;
    color: var(--ink-muted);
    font-size: var(--type-control);
  }

  .table-size-controls div {
    display: flex;
    gap: 3px;
  }

  .table-size-controls button {
    border: 1px solid var(--rule);
    border-radius: 5px;
    background: var(--paper);
    padding: 5px 7px;
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .table-cell-editor {
    display: grid;
    grid-template-columns: repeat(var(--table-columns), minmax(100px, 1fr));
    max-height: 52vh;
    overflow: auto;
    border: 1px solid var(--rule);
    background: var(--rule);
    gap: 1px;
  }

  .table-cell-editor input {
    min-width: 100px;
    border: 0;
    border-radius: 0;
    background: var(--paper-raised);
    padding: 8px;
    font-size: var(--type-control);
  }

  .table-cell-editor input.header-cell {
    background: var(--paper-deep);
    font-weight: 700;
  }

  .math-kind {
    grid-template-columns: 1fr 1fr;
    margin: 6px 0 14px;
  }

  .document-element-modal textarea {
    width: 100%;
    resize: vertical;
    font-family: NanumGothicCoding, monospace;
    line-height: 1.6;
  }

  .grammar-modal {
    width: min(760px, 94vw);
  }

  .grammar-warnings {
    margin-top: 10px;
    border-left: 2px solid var(--warning);
    padding-left: 10px;
    color: var(--ink-muted);
    font-size: var(--type-caption);
  }

  .grammar-warnings p {
    margin: 4px 0;
  }

  .grammar-edit-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    max-height: 220px;
    margin-top: 12px;
    overflow: auto;
  }

  .grammar-edit-list article {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: var(--paper);
    padding: 7px 8px;
  }

  .grammar-edit-list article > span {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--paper-deep);
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .grammar-edit-list article div {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: var(--type-caption);
  }

  .grammar-edit-list del,
  .grammar-edit-list ins {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grammar-edit-list del {
    color: var(--danger);
  }

  .grammar-edit-list ins {
    color: var(--success);
    text-decoration: none;
  }

  .grammar-edit-list button {
    border: 0;
    background: transparent;
    padding: 5px;
    color: var(--accent);
    font-size: var(--type-caption);
  }

  .diff-view {
    max-height: 42vh;
    overflow: auto;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    padding: 18px;
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-reading);
    line-height: 1.85;
    white-space: pre-wrap;
  }

  .diff-view .added {
    background: color-mix(in srgb, var(--success) 19%, transparent);
    color: var(--success);
  }

  .diff-view .removed {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    color: var(--danger);
    text-decoration: line-through;
  }

  .version-compare-modal {
    width: min(820px, 94vw);
  }

  .proof-sheet {
    position: relative;
    max-height: 46vh;
    overflow: auto;
    border: 1px solid rgba(92, 70, 55, 0.18);
    border-radius: 4px;
    background-color: var(--sheet);
    background-image: var(--hanji-texture);
    background-size: 320px 320px;
    padding: 24px 22px 22px 34px;
    color: #342d29;
    font-family: MaruBuri, Georgia, serif;
    font-size: var(--type-reading);
    line-height: 2;
    white-space: pre-wrap;
  }

  .proof-sheet::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 22px;
    width: 1px;
    background: rgba(174, 79, 69, 0.4);
  }

  .proof-sheet del {
    color: rgba(151, 61, 52, 0.85);
    background: rgba(151, 61, 52, 0.07);
    text-decoration: line-through;
    text-decoration-color: rgba(151, 61, 52, 0.75);
  }

  .proof-sheet ins {
    color: rgba(151, 61, 52, 0.92);
    background: rgba(151, 61, 52, 0.09);
    text-decoration: none;
    border-bottom: 2px solid rgba(151, 61, 52, 0.55);
  }

  .proof-sheet ins::before {
    content: "⌃";
    display: inline-block;
    margin-right: 1px;
    color: rgba(151, 61, 52, 0.7);
    font-size: 0.7em;
    vertical-align: top;
  }

  .proof-sheet-stamp {
    position: absolute;
    top: 10px;
    right: 14px;
    border: 1.5px solid rgba(151, 61, 52, 0.55);
    border-radius: 3px;
    padding: 1px 8px;
    color: rgba(151, 61, 52, 0.78);
    font-family: var(--ui-font);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    transform: rotate(-2deg);
  }

  .rationale,
  .conflict-modal > p,
  .exit-modal > p {
    color: var(--ink-muted);
    font-size: var(--type-body);
    line-height: 1.65;
  }

  .modal footer {
    justify-content: flex-end;
    margin-top: 18px;
  }

  .conflict-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .conflict-columns strong {
    font-size: var(--type-control);
  }

  .conflict-columns pre {
    max-height: 260px;
    overflow: auto;
    border: 1px solid var(--rule);
    border-radius: 7px;
    background: var(--paper);
    padding: 10px;
    font-family: NanumGothicCoding, monospace;
    font-size: var(--type-micro);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .conflict-modal footer button {
    border: 1px solid var(--rule-strong);
    border-radius: 7px;
    background: var(--paper);
    padding: 8px 12px;
    font-size: var(--type-control);
  }

  .conflict-modal footer .primary-button {
    background: var(--accent);
  }

  .exit-backdrop {
    z-index: 120;
  }

  .exit-modal {
    width: min(520px, 94vw);
  }

  .exit-modal footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .exit-modal .danger-button {
    border: 1px solid color-mix(in srgb, var(--danger) 70%, var(--rule));
    border-radius: 7px;
    background: transparent;
    padding: 8px 12px;
    color: var(--danger);
    font-size: var(--type-control);
  }

  .exit-modal .danger-button:hover {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }

  .toast {
    position: fixed;
    z-index: 200;
    right: 18px;
    bottom: 18px;
    max-width: min(420px, calc(100vw - 36px));
    border: 1px solid var(--rule-strong);
    border-radius: 7px;
    background-color: var(--surface-raised);
    background-image: var(--hanji-texture);
    background-blend-mode: soft-light;
    background-size: 320px 320px;
    padding: 10px 14px;
    box-shadow: var(--shadow-float);
    color: var(--ink);
    font-size: var(--type-caption);
    line-height: 1.5;
    animation: toast-in 180ms ease-out;
  }

  .toast.error {
    border-color: var(--danger);
    color: var(--danger);
  }

  .toast.success {
    border-color: var(--success);
    color: var(--success);
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes toast-in {
    from {
      transform: translateY(7px);
      opacity: 0;
    }
  }

  @media (max-width: 1280px) {
    .app-shell.panel-left,
    .app-shell.panel-right,
    .app-shell.panel-left.panel-right {
      grid-template-columns: 0 minmax(0, 1fr) 0;
    }

    .panel {
      position: fixed;
      top: 46px;
      bottom: 0;
      width: min(86vw, 342px);
      box-shadow: 0 20px 48px color-mix(in srgb, var(--ink-strong) 22%, transparent);
    }

    .left-panel {
      left: 0;
    }

    .right-panel {
      right: 0;
    }
  }

  @media (max-width: 1100px) {
    .topbar {
      grid-template-columns: auto minmax(90px, 150px) minmax(0, 1fr) auto;
    }

    .font-select {
      display: none;
    }
  }

  @media (max-width: 900px) {
    .app-shell.panel-left.panel-right .right-panel {
      display: none;
    }

    .topbar {
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      gap: 4px;
      padding: 0 6px;
    }

    .document-name {
      font-size: var(--type-caption);
    }

    .style-select,
    .toolbar-divider,
    .compact-menu {
      display: none;
    }
  }

  @media (max-width: 680px) {
    .document-name {
      display: none;
    }

    .topbar {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .writing-toolbar {
      grid-column: 2;
    }

    .metadata-form {
      grid-template-columns: 1fr;
    }

    .metadata-form .field {
      grid-column: 1;
    }
  }

  @media (hover: none), (pointer: coarse) {
    .repository-row-actions {
      opacity: 1;
    }
  }

  @media print {
    :global(html),
    :global(body) {
      width: auto;
      height: auto;
      overflow: visible;
      background: #fff;
    }

    .app-shell {
      display: block;
      width: auto;
      height: auto;
      overflow: visible;
      background: #fff;
    }

    .topbar,
    .panel,
    .encoding-banner,
    .selection-tools,
    .statusbar {
      display: none !important;
    }

    .writing-stage {
      width: auto;
      height: auto;
      min-height: 0;
      overflow: visible;
      background: #fff;
    }
  }
</style>
