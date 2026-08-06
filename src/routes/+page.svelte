<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    exportPdf,
    getCurrentWebviewWindow,
    getCurrentWindow,
    invoke,
    isDesktopRuntime,
    listen,
    openDialog,
    openUrl,
    saveDialog,
    type UnlistenFn,
  } from "$lib/desktop";
  import { diffChars, diffWords } from "diff";
  import AiChatPanel from "$lib/AiChatPanel.svelte";
  import PaginatedEditor from "$lib/PaginatedEditor.svelte";
  import {
    conversationHistoryContext,
    createEditProposal,
    markPendingHunks,
    pendingProposalEdits,
    proposalMatchesContent,
    updateProposalAfterHunk,
  } from "$lib/ai-chat";
  import {
    parseManuscript,
    updateManuscriptMetadata,
    type ManuscriptMetadata,
  } from "$lib/manuscript-document";
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
    defaultFontFamilyByExperience,
    parsePreferences,
    shouldInferLegacyWritingExperience,
    writingExperienceForFont,
    type Preferences,
  } from "$lib/preferences";
  import { SingleFlight } from "$lib/single-flight";
  import { externalSyncProvider } from "$lib/storage";
  import {
    compareVersionContent,
    type VersionComparison,
  } from "$lib/version-comparison";
  import type {
    AiAccountStatus,
    AiChatMessage,
    AiChatMessageMetadata,
    AiChatResponse,
    AiConversation,
    AiConversationSummary,
    AiGrammarResponse,
    AiLoginStart,
    AiSourceContext,
    AiWritingResponse,
    AssistantPanel,
    CompanionView,
    DocumentPayload,
    EditorChangeContext,
    EditorApi,
    EditorSelection,
    FontRecord,
    ImportedAsset,
    ManuscriptAssetData,
    RecentDocument,
    RepositoryDocument,
    RepositoryStatus,
    ResearchConnectionStatus,
    ResearchFolder,
    ResearchSource,
    ResearchWorkspaceStatus,
    SaveDocumentResult,
    SearchResult,
    ScrollAnchor,
    SidePanel,
    StoredVersion,
    SyncthingStatus,
    VersionSummary,
    WritingActivity,
    WritingExperience,
    ZoteroItem,
    ZoteroStatus,
  } from "$lib/types";

  type SaveState = "saved" | "dirty" | "saving" | "error";
  type GrammarScope = "selection" | "paragraph" | "document";
  type SourceComponent = typeof import("$lib/MarkdownSourceEditor.svelte").default;
  type ToolbarMenu = "insert" | "link" | "experience" | null;
  type RuntimePlatform = "linux" | "windows" | "macos" | "web";
  type DocumentDialog =
    | "metadata"
    | "figure"
    | "table"
    | "math"
    | "footnote"
    | null;

  interface ConflictState {
    remote: DocumentPayload;
    local: string;
    base: string;
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
  let baseContent = $state("");
  let editorApi = $state.raw<EditorApi | null>(null);
  let paperApi = $state.raw<EditorApi | null>(null);
  let sourceApi = $state.raw<EditorApi | null>(null);
  let activeEditor = $state<"paper" | "source">("paper");
  let SourceEditor = $state<SourceComponent | null>(null);
  let companionView = $state<CompanionView>(null);
  let runtimePlatform = $state<RuntimePlatform>("web");
  let windowMaximized = $state(false);
  let writingStage = $state<HTMLElement>();
  let stageWidth = $state(1180);
  let splitDragging = $state(false);
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
  let advancedSettingsOpen = $state(false);
  let inferWritingExperienceFromFont = false;
  let chromeSuppressed = $state(false);
  let saveState = $state<SaveState>("saved");
  let saveError = $state("");
  let conflict = $state<ConflictState | null>(null);
  let recents = $state<RecentDocument[]>([]);
  const bundledFonts: FontRecord[] = [
    { family: "Goorm Sans Code", monospaced: true, bundled: true },
    { family: "MaruBuri", monospaced: false, bundled: true },
    { family: "Pretendard", monospaced: false, bundled: true },
    { family: "NanumGothicCoding", monospaced: true, bundled: true },
  ];
  let fonts = $state<FontRecord[]>([...bundledFonts]);
  let preferences = $state<Preferences>(parsePreferences(null));
  let currentFontFamily = $derived(
    preferences.fontFamilyByExperience[preferences.writingExperience] ??
      defaultFontFamilyByExperience[preferences.writingExperience],
  );
  let flowChromeHidden = $derived(
    Boolean(currentDocument) &&
      preferences.writingExperience === "flow" &&
      preferences.flowAutoHideChrome &&
      chromeSuppressed,
  );
  let sessionWords = $state(0);
  let sessionSentences = $state(0);
  let sessionParagraphs = $state(0);
  let sessionMarks = $state<Array<"sentence" | "paragraph">>([]);
  let systemPrefersDark = $state(false);
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
  let aiOpen = $state(false);
  let aiExpanded = $state(false);
  let aiChatBusy = $state(false);
  let completionBusy = $state(false);
  let aiConversations = $state<AiConversationSummary[]>([]);
  let aiConversation = $state<AiConversation | null>(null);
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
    layout: "editorial-a4",
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
    !currentDocument || currentDocument.readOnly,
  );
  const writingExperiences: Array<{
    id: WritingExperience;
    label: string;
    cue: string;
    description: string;
  }> = [
    {
      id: "typewriter",
      label: "타자기",
      cue: "고정 타점",
      description: "무음 플래튼과 움직이는 캐리지",
    },
    {
      id: "literary",
      label: "문학 서재",
      cue: "책 한 쪽",
      description: "따뜻한 종이와 조판의 여운",
    },
    {
      id: "flow",
      label: "몰입 캔버스",
      cue: "연속 집중",
      description: "페이지 경계 없는 집중 원고",
    },
  ];
  let currentWritingExperience = $derived(
    writingExperiences.find(
      (experience) => experience.id === preferences.writingExperience,
    ) ?? writingExperiences[0],
  );

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let completionTimer: ReturnType<typeof setTimeout> | null = null;
  let chromeStreakTimer: ReturnType<typeof setTimeout> | null = null;
  let chromePauseTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let externalTimer: ReturnType<typeof setTimeout> | null = null;
  let repositoryTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let stageObserver: ResizeObserver | null = null;
  let suppressedScrollSource: ScrollAnchor["source"] | null = null;
  let versionPreviewRequest = 0;
  let versionReturnFocus: HTMLElement | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let unlisteners: UnlistenFn[] = [];
  let lastSnapshotAt = 0;
  let closing = false;
  const saveFlight = new SingleFlight<boolean>();
  const exitFlight = new SingleFlight<void>();
  let outline = $derived(extractOutline(editorValue));
  let words = $derived(countWords(editorValue));
  let minutes = $derived(Math.max(1, Math.ceil(words / 350)));
  let documentTitle = $derived(
    currentDocument ? basename(currentDocument.path) : "Research Writer",
  );
  let documentFallbackTitle = $derived(
    currentDocument
      ? basename(currentDocument.path).replace(/\.(?:md|markdown)$/i, "")
      : "제목 없는 원고",
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
  let darkThemeActive = $derived(
    preferences.theme === "dark" ||
      (preferences.theme === "system" && systemPrefersDark),
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
  let compactCompanion = $derived(
    companionView !== null && stageWidth < 840,
  );
  let pendingAiSelection = $derived.by(() => {
    if (!aiConversation || !selection.text.trim()) return null;
    const selectedMarkdown = editorValue.slice(selection.from, selection.to);
    if (
      aiConversation.targetKind === "selection" &&
      aiConversation.targetFrom === selection.from &&
      aiConversation.targetTo === selection.to &&
      aiConversation.targetText === selectedMarkdown
    ) {
      return null;
    }
    return selection;
  });
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

  async function initializeWindowChrome(): Promise<void> {
    if (!desktop) {
      runtimePlatform = "web";
      return;
    }
    runtimePlatform = await invoke<RuntimePlatform>("get_runtime_platform").catch(
      () => "linux" as RuntimePlatform,
    );
    const appWindow = getCurrentWindow();
    windowMaximized = await appWindow.isMaximized().catch(() => false);
    unlisteners.push(
      await appWindow.onResized(async () => {
        windowMaximized = await appWindow.isMaximized().catch(
          () => windowMaximized,
        );
      }),
    );
  }

  async function minimizeWindow(): Promise<void> {
    await getCurrentWindow().minimize().catch((error) =>
      notify(`창을 최소화하지 못했습니다: ${errorMessage(error)}`, "error"),
    );
  }

  async function toggleWindowMaximize(): Promise<void> {
    await getCurrentWindow().toggleMaximize().catch((error) =>
      notify(`창 크기를 바꾸지 못했습니다: ${errorMessage(error)}`, "error"),
    );
    windowMaximized = await getCurrentWindow()
      .isMaximized()
      .catch(() => windowMaximized);
  }

  function measureWritingStage(): void {
    if (writingStage) stageWidth = writingStage.clientWidth;
  }

  function beginSplitResize(event: PointerEvent): void {
    if (!writingStage || compactCompanion || event.button !== 0) return;
    event.preventDefault();
    splitDragging = true;
    const move = (moveEvent: PointerEvent) => {
      if (!writingStage) return;
      const bounds = writingStage.getBoundingClientRect();
      const ratio = (moveEvent.clientX - bounds.left) / Math.max(1, bounds.width);
      preferences.companionSplitRatio = Math.min(0.7, Math.max(0.35, ratio));
    };
    const finish = () => {
      splitDragging = false;
      savePreferences();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
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

  function resetWritingSession(): void {
    sessionWords = 0;
    sessionSentences = 0;
    sessionParagraphs = 0;
    sessionMarks = [];
  }

  function loadPreferences(): void {
    const stored = localStorage.getItem("research-writer.preferences");
    inferWritingExperienceFromFont = shouldInferLegacyWritingExperience(stored);
    preferences = parsePreferences(stored);
    const normalized = JSON.stringify(preferences);
    if (stored !== normalized) {
      localStorage.setItem("research-writer.preferences", normalized);
    }
    document.documentElement.dataset.theme = preferences.theme;
  }

  function savePreferences(): void {
    localStorage.setItem(
      "research-writer.preferences",
      JSON.stringify(preferences),
    );
    document.documentElement.dataset.theme = preferences.theme;
  }

  function rememberFontFamily(
    experience: WritingExperience,
    fontFamily: string,
  ): void {
    preferences.fontFamilyByExperience = {
      ...preferences.fontFamilyByExperience,
      [experience]: fontFamily,
    };
  }

  function handleFontFamilyChange(event: Event): void {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    rememberFontFamily(preferences.writingExperience, select.value);
    inferWritingExperienceFromFont = false;
    savePreferences();
  }

  function normalizeRememberedFontFamilies(records: FontRecord[]): boolean {
    const availableFamilies = new Set(records.map((font) => font.family));
    const normalized = { ...preferences.fontFamilyByExperience };
    let changed = false;
    for (const experience of writingExperiences) {
      if (!availableFamilies.has(normalized[experience.id])) {
        normalized[experience.id] =
          defaultFontFamilyByExperience[experience.id];
        changed = true;
      }
    }
    if (changed) preferences.fontFamilyByExperience = normalized;
    return changed;
  }

  function inferLegacyWritingExperience(): void {
    const previousExperience = preferences.writingExperience;
    const previousFontFamily = currentFontFamily;
    const selected = fonts.find(
      (font) => font.family === previousFontFamily,
    );
    const inferredExperience = writingExperienceForFont(
      previousFontFamily,
      selected?.monospaced,
    );

    if (inferredExperience !== previousExperience) {
      const migrated = {
        ...preferences.fontFamilyByExperience,
        [previousExperience]:
          defaultFontFamilyByExperience[previousExperience],
      };
      if (inferredExperience !== "typewriter") {
        migrated[inferredExperience] = previousFontFamily;
      }
      preferences.fontFamilyByExperience = migrated;
      preferences.writingExperience = inferredExperience;
    }
    inferWritingExperienceFromFont = false;
  }

  function toggleTheme(): void {
    preferences.theme = darkThemeActive ? "light" : "dark";
    savePreferences();
  }

  async function setWritingExperience(
    experience: WritingExperience,
  ): Promise<void> {
    if (!currentDocument || experience === preferences.writingExperience) {
      closeToolbarMenu(false);
      return;
    }
    const activeBefore = activeEditor;
    const selectedBefore = editorApi?.getSelection() ?? selection;
    preferences.writingExperience = experience;
    if (experience !== "flow") resetChromeSuppression();
    inferWritingExperienceFromFont = false;
    savePreferences();
    closeToolbarMenu(false);
    await tick();
    await paperApi?.awaitLayout?.();
    await tick();
    const target = activeBefore === "source" ? sourceApi : paperApi;
    target?.setSelection(selectedBefore.from, selectedBefore.to);
  }

  function handleExperiencePickerKeydown(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = writingExperiences.findIndex(
      (experience) => experience.id === preferences.writingExperience,
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? writingExperiences.length - 1
          : event.key === "ArrowRight"
            ? (current + 1) % writingExperiences.length
            : (current - 1 + writingExperiences.length) %
              writingExperiences.length;
    void setWritingExperience(writingExperiences[next].id).then(() => {
      document
        .querySelector<HTMLButtonElement>(
          `.experience-segment[data-experience="${writingExperiences[next].id}"]`,
        )
        ?.focus();
    });
  }

  function watchSystemTheme(): void {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    systemPrefersDark = media.matches;
    const update = (event: MediaQueryListEvent) => {
      systemPrefersDark = event.matches;
    };
    media.addEventListener("change", update);
    unlisteners.push(() => media.removeEventListener("change", update));
  }

  async function installRepositoryFonts(records: FontRecord[]): Promise<void> {
    if (typeof FontFace === "undefined" || !document.fonts) return;
    const repositoryFonts = records.filter(
      (font): font is FontRecord & { dataUrl: string } =>
        !font.bundled && typeof font.dataUrl === "string",
    );
    await Promise.all(
      repositoryFonts.map(async (font) => {
        try {
          const face = new FontFace(font.family, `url("${font.dataUrl}")`);
          await face.load();
          document.fonts.add(face);
        } catch {
          // A damaged optional font must not keep the editor from opening.
        }
      }),
    );
  }

  async function refreshFonts(): Promise<void> {
    if (!desktop) return;
    const loaded = await invoke<FontRecord[]>("list_fonts").catch(
      () => bundledFonts,
    );
    fonts = loaded;
    await installRepositoryFonts(loaded);
    let preferencesChanged = normalizeRememberedFontFamilies(fonts);
    if (inferWritingExperienceFromFont) {
      inferLegacyWritingExperience();
      preferencesChanged = true;
    }
    if (preferencesChanged) savePreferences();
  }

  async function importRepositoryFont(): Promise<void> {
    if (!desktop || !repository?.available) {
      notify("폰트를 가져오려면 먼저 저장소를 열어주세요.", "info");
      return;
    }
    const selected = await openDialog({
      title: "저장소에 폰트 가져오기",
      directory: false,
      multiple: false,
      filters: [{ name: "Font", extensions: ["ttf", "otf", "woff2"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const previousFamilies = new Set(fonts.map((font) => font.family));
      const loaded = await invoke<FontRecord[]>("import_repository_font", {
        sourcePath: selected,
      });
      fonts = loaded;
      await installRepositoryFonts(loaded);
      const imported = loaded.find(
        (font) =>
          !font.bundled &&
          font.dataUrl &&
          !previousFamilies.has(font.family),
      );
      if (imported) {
        rememberFontFamily(preferences.writingExperience, imported.family);
      }
      savePreferences();
      notify("폰트를 저장소에 복사해 적용했습니다.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  function handleEditorSelection(
    source: "paper" | "source",
    value: EditorSelection,
  ): void {
    if (source !== activeEditor) return;
    selection = value;
    editorApi?.clearGhostText();
    if (completionTimer) {
      clearTimeout(completionTimer);
      completionTimer = null;
    }
  }

  function setActiveEditor(source: "paper" | "source"): void {
    activeEditor = source;
    editorApi = source === "source" ? sourceApi : paperApi;
    const nextSelection = editorApi?.getSelection();
    if (nextSelection) handleEditorSelection(source, nextSelection);
  }

  function handlePaperReady(api: EditorApi | null): void {
    const wasActive = editorApi === paperApi;
    paperApi = api;
    if (api && (activeEditor === "paper" || !editorApi)) editorApi = api;
    else if (!api && wasActive) editorApi = sourceApi;
  }

  function handleSourceReady(api: EditorApi | null): void {
    const wasActive = editorApi === sourceApi;
    sourceApi = api;
    if (api && activeEditor === "source") editorApi = api;
    else if (!api && wasActive) {
      activeEditor = "paper";
      editorApi = paperApi;
    }
  }

  async function toggleCompanionView(mode: Exclude<CompanionView, null>): Promise<void> {
    if (companionView === mode) {
      companionView = null;
      if (activeEditor === "source") setActiveEditor("paper");
      return;
    }
    try {
      if (mode === "source" && !SourceEditor) {
        SourceEditor = (await import("$lib/MarkdownSourceEditor.svelte")).default;
      }
    } catch (error) {
      notify(`보조 화면을 불러오지 못했습니다: ${errorMessage(error)}`, "error");
      return;
    }
    companionView = mode;
    await tick();
    const anchor = paperApi?.getScrollAnchor();
    if (anchor) {
      sourceApi?.scrollToAnchor(anchor);
    }
  }

  async function editableApi(): Promise<EditorApi | null> {
    if (!currentDocument || currentDocument.readOnly) return null;
    return editorApi ?? paperApi;
  }

  function handleScrollAnchor(anchor: ScrollAnchor): void {
    if (anchor.source === suppressedScrollSource) return;
    const target =
      anchor.source === "paper"
        ? companionView
        : "paper";
    if (!target) return;
    suppressedScrollSource = target;
    if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
    requestAnimationFrame(() => {
      if (target === "source") sourceApi?.scrollToAnchor(anchor);
      else paperApi?.scrollToAnchor(anchor);
      scrollSyncTimer = setTimeout(() => {
        suppressedScrollSource = null;
      }, 90);
    });
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
    metadataDraft = {
      ...parseManuscript(editorValue, documentFallbackTitle, {
        diagnostics: false,
      }).metadata,
    };
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
      documentFallbackTitle,
    );
    if (await replaceWholeDocument(next, "원고 정보를 반영했습니다.")) {
      documentDialog = null;
    }
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

  async function resolveManuscriptImage(
    relativePath: string,
  ): Promise<string | null> {
    if (!desktop || !currentDocument) return null;
    const documentPath = currentDocument.path;
    try {
      const asset = await invoke<ManuscriptAssetData>(
        "read_manuscript_asset",
        { documentPath, relativePath },
      );
      return currentDocument?.path === documentPath ? asset.dataUrl : null;
    } catch {
      return null;
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

  async function printCompletedDocument(): Promise<void> {
    if (!paperApi) {
      notify("인쇄할 페이지를 준비하지 못했습니다.", "error");
      return;
    }
    await paperApi.awaitLayout?.();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    document.documentElement.dataset.printing = "paper";
    try {
      if (desktop) {
        const stem = currentDocument
          ? basename(currentDocument.path).replace(/\.(?:md|markdown)$/i, "")
          : "원고";
        const path = await exportPdf(`${stem}.pdf`);
        if (path) notify("PDF를 저장했습니다.", "success");
      } else {
        window.print();
      }
    } catch (error) {
      notify(`PDF를 만들지 못했습니다: ${errorMessage(error)}`, "error");
    } finally {
      delete document.documentElement.dataset.printing;
    }
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
    editorValue = "";
    baseContent = "";
    saveState = "saved";
    saveError = "";
    conflict = null;
    companionView = null;
    activeEditor = "paper";
    editorApi = paperApi;
    documentDialog = null;
    grammarSuggestion = null;
    aiOpen = false;
    aiExpanded = false;
    aiConversations = [];
    aiConversation = null;
    sync = null;
    selection = { from: 0, to: 0, text: "", line: 1 };
    resetWritingSession();
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
      await Promise.all([
        refreshRepositoryDocuments(),
        watchActiveRepository(),
        refreshFonts(),
      ]);
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
      fonts = [...bundledFonts];
      if (normalizeRememberedFontFamilies(fonts)) savePreferences();
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
    editorValue = document.content;
    baseContent = document.content;
    saveState = "saved";
    saveError = "";
    conflict = null;
    companionView = null;
    activeEditor = "paper";
    editorApi = paperApi;
    documentDialog = null;
    grammarSuggestion = null;
    aiExpanded = false;
    aiConversation = null;
    aiConversations = [];
    selection = { from: 0, to: 0, text: "", line: 1 };
    resetWritingSession();
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
      await Promise.all([
        loadRecents(),
        refreshSync(),
        loadAiConversations(document.path),
      ]);
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
    if (!currentDocument || currentDocument.readOnly) return;
    saveState = "dirty";
    saveError = "";
    if (context.composing) return;
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
      aiOpen = false;
      aiExpanded = false;
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
    if (nextPanel) {
      aiOpen = false;
      aiExpanded = false;
    }
    rightPanel = nextPanel;
    if (nextPanel) lastRightPanel = nextPanel;
    if (rightPanel === "proofreading") {
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
      aiOpen = false;
      aiExpanded = false;
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

  function aiConversationSummary(
    conversation: AiConversation,
  ): AiConversationSummary {
    const { messages: _messages, ...summary } = conversation;
    return summary;
  }

  function localConversationId(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function reconcileAiConversation(
    conversation: AiConversation,
  ): AiConversation {
    const content = editorValue;
    return {
      ...conversation,
      messages: conversation.messages.map((message) => {
        const proposal = message.metadata.proposal;
        if (!proposal) return message;
        const stale =
          proposal.hunks.some((hunk) => hunk.status === "pending") &&
          !proposalMatchesContent(proposal, content);
        if (!stale) return message;
        return {
          ...message,
          metadata: {
            ...message.metadata,
            proposal: markPendingHunks(proposal, "stale"),
          },
        };
      }),
    };
  }

  async function loadAiConversation(id: string): Promise<void> {
    if (!currentDocument) return;
    if (!desktop) {
      const local = aiConversation?.id === id ? aiConversation : null;
      if (local) aiConversation = reconcileAiConversation(local);
      return;
    }
    const documentPath = currentDocument.path;
    try {
      const loaded = await invoke<AiConversation>("load_ai_conversation", {
        id,
      });
      if (currentDocument?.path !== documentPath) return;
      aiConversation = reconcileAiConversation(loaded);
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function refreshAiConversationList(documentPath: string): Promise<void> {
    if (!desktop) return;
    const listed = await invoke<AiConversationSummary[]>(
      "list_ai_conversations",
      { documentPath },
    ).catch(() => []);
    if (currentDocument?.path === documentPath) aiConversations = listed;
  }

  async function loadAiConversations(documentPath: string): Promise<void> {
    if (!desktop) return;
    await refreshAiConversationList(documentPath);
    if (currentDocument?.path !== documentPath) return;
    const latest = aiConversations[0];
    if (latest) await loadAiConversation(latest.id);
  }

  async function createAiConversation(
    selected = editorApi?.getSelection() ?? selection,
  ): Promise<AiConversation | null> {
    if (!currentDocument) return null;
    const hasSelection = Boolean(selected.text.trim());
    const content = editorApi?.getContent() ?? editorValue;
    const request = {
      documentPath: currentDocument.path,
      targetKind: hasSelection ? "selection" : "document",
      targetFrom: hasSelection ? selected.from : null,
      targetTo: hasSelection ? selected.to : null,
      // Visual selections expose plain text, while these offsets address the
      // canonical Markdown. Persist the exact source slice so emphasis,
      // links, and other delimiters cannot make a fresh target look stale.
      targetText: hasSelection
        ? content.slice(selected.from, selected.to)
        : "",
    };
    try {
      const created = desktop
        ? await invoke<AiConversation>("create_ai_conversation", { request })
        : {
            id: localConversationId(),
            documentPath: currentDocument.path,
            title: "새 대화",
            targetKind: request.targetKind as "selection" | "document",
            targetFrom: request.targetFrom,
            targetTo: request.targetTo,
            targetText: request.targetText,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [],
          };
      aiConversation = created;
      aiConversations = [
        aiConversationSummary(created),
        ...aiConversations.filter((item) => item.id !== created.id),
      ];
      return created;
    } catch (error) {
      notify(errorMessage(error), "error");
      return null;
    }
  }

  async function ensureAiConversation(): Promise<AiConversation | null> {
    if (!currentDocument) return null;
    if (aiConversation?.documentPath === currentDocument.path) {
      return aiConversation;
    }
    const latest = aiConversations[0];
    if (latest) {
      await loadAiConversation(latest.id);
      if (aiConversation) return aiConversation;
    }
    return createAiConversation();
  }

  function closeAi(): void {
    aiOpen = false;
    aiExpanded = false;
  }

  async function toggleAi(): Promise<void> {
    if (aiOpen) {
      closeAi();
      return;
    }
    if (!currentDocument) return;
    aiOpen = true;
    aiExpanded = false;
    rightPanel = null;
    if (typeof window !== "undefined" && window.innerWidth <= 1280) {
      leftPanel = null;
    }
    await Promise.all([refreshAiAccount(), ensureAiConversation()]);
  }

  async function startNewAiConversation(): Promise<void> {
    if (!currentDocument) return;
    aiOpen = true;
    aiExpanded = false;
    rightPanel = null;
    if (typeof window !== "undefined" && window.innerWidth <= 1280) {
      leftPanel = null;
    }
    await createAiConversation(editorApi?.getSelection() ?? selection);
  }

  async function openAiForSelection(): Promise<void> {
    const selected = editorApi?.getSelection() ?? selection;
    if (!selected.text.trim()) return toggleAi();
    aiOpen = true;
    aiExpanded = false;
    rightPanel = null;
    if (typeof window !== "undefined" && window.innerWidth <= 1280) {
      leftPanel = null;
    }
    await Promise.all([refreshAiAccount(), createAiConversation(selected)]);
  }

  async function deleteAiConversation(id: string): Promise<void> {
    if (!window.confirm("이 AI 대화를 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) {
      return;
    }
    try {
      if (desktop) await invoke("delete_ai_conversation", { id });
      aiConversations = aiConversations.filter((item) => item.id !== id);
      if (aiConversation?.id === id) {
        aiConversation = null;
        const next = aiConversations[0];
        if (next) await loadAiConversation(next.id);
        else await createAiConversation();
      }
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function appendAiMessage(request: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    responseKind: "answer" | "edit" | null;
    metadata: AiChatMessageMetadata;
  }): Promise<AiChatMessage> {
    if (desktop) {
      return invoke<AiChatMessage>("append_ai_message", { request });
    }
    return {
      id: localConversationId(),
      conversationId: request.conversationId,
      role: request.role,
      content: request.content,
      responseKind: request.responseKind,
      metadata: request.metadata,
      createdAt: new Date().toISOString(),
    };
  }

  function updateLocalAiMessage(message: AiChatMessage): void {
    if (!aiConversation || message.conversationId !== aiConversation.id) return;
    aiConversation = {
      ...aiConversation,
      messages: aiConversation.messages.map((item) =>
        item.id === message.id ? message : item,
      ),
    };
  }

  async function saveAiMessageMetadata(
    message: AiChatMessage,
    metadata: AiChatMessageMetadata,
  ): Promise<void> {
    const updated = desktop
      ? await invoke<AiChatMessage>("update_ai_message_metadata", {
          id: message.id,
          metadata,
        })
      : { ...message, metadata };
    updateLocalAiMessage(updated);
  }

  async function updateAiConversationTarget(
    proposal: NonNullable<AiChatMessageMetadata["proposal"]>,
  ): Promise<void> {
    if (!aiConversation || aiConversation.targetKind !== "selection" || !editorApi) {
      return;
    }
    const content = editorApi.getContent();
    const request = {
      conversationId: aiConversation.id,
      targetKind: "selection" as const,
      targetFrom: proposal.targetFrom,
      targetTo: proposal.targetTo,
      targetText: content.slice(proposal.targetFrom, proposal.targetTo),
    };
    if (desktop) {
      await invoke("update_ai_conversation_target", { request });
    }
    aiConversation = {
      ...aiConversation,
      targetKind: request.targetKind,
      targetFrom: request.targetFrom,
      targetTo: request.targetTo,
      targetText: request.targetText,
    };
  }

  async function sendAiChat(prompt: string): Promise<boolean> {
    if (!desktop || !currentDocument || aiChatBusy || !aiAccount?.authenticated) {
      if (!desktop) notify("AI 채팅은 데스크톱 앱에서 사용할 수 있습니다.", "info");
      return false;
    }
    const conversation = await ensureAiConversation();
    if (!conversation) return false;
    const content = editorApi?.getContent() ?? editorValue;
    const targetFrom = conversation.targetKind === "selection"
      ? (conversation.targetFrom ?? 0)
      : 0;
    const targetTo = conversation.targetKind === "selection"
      ? (conversation.targetTo ?? targetFrom)
      : content.length;
    const targetText = content.slice(targetFrom, targetTo);
    if (
      conversation.targetKind === "selection" &&
      targetText !== conversation.targetText
    ) {
      notify(
        "대화가 가리키던 원문이 바뀌었습니다. 현재 범위를 다시 선택해 새 대화를 시작해주세요.",
        "error",
      );
      return false;
    }

    aiChatBusy = true;
    const documentPath = currentDocument.path;
    const history = conversationHistoryContext(conversation.messages);
    let userMessage: AiChatMessage | null = null;
    try {
      userMessage = await appendAiMessage({
        conversationId: conversation.id,
        role: "user",
        content: prompt,
        responseKind: null,
        metadata: {},
      });
      if (aiConversation?.id === conversation.id) {
        aiConversation = {
          ...aiConversation,
          title:
            aiConversation.title === "새 대화"
              ? `${prompt.replace(/\s+/g, " ").slice(0, 44)}${prompt.length > 44 ? "…" : ""}`
              : aiConversation.title,
          messages: [...aiConversation.messages, userMessage],
        };
      }
      const response = await invoke<AiChatResponse>("run_ai_chat", {
        request: {
          prompt,
          targetKind: conversation.targetKind,
          targetText,
          documentContext:
            conversation.targetKind === "selection"
              ? currentSection(content, targetFrom)
              : "",
          historySummary: history.historySummary,
          recentMessages: history.recentMessages,
          styleReference,
          sources: sourceContexts,
        },
      });
      const proposal =
        response.kind === "edit" && response.revisedText !== targetText
          ? createEditProposal(
              response,
              conversation.targetKind,
              targetFrom,
              targetText,
            )
          : undefined;
      const assistantMessage = await appendAiMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: response.reply,
        responseKind: response.kind,
        metadata: {
          citations: response.citations,
          warnings: response.warnings,
          model: response.model,
          proposal,
        },
      });
      if (currentDocument?.path === documentPath && aiConversation?.id === conversation.id) {
        aiConversation = {
          ...aiConversation,
          messages: [...aiConversation.messages, assistantMessage],
        };
      }
      await refreshAiConversationList(documentPath);
      return true;
    } catch (error) {
      if (userMessage) {
        await saveAiMessageMetadata(userMessage, {
          ...userMessage.metadata,
          failed: true,
        }).catch(() => undefined);
      }
      notify(errorMessage(error), "error");
      return false;
    } finally {
      aiChatBusy = false;
    }
  }

  function aiMessage(messageId: string): AiChatMessage | null {
    return aiConversation?.messages.find((message) => message.id === messageId) ?? null;
  }

  async function applyAiHunk(messageId: string, hunkId: string): Promise<void> {
    const message = aiMessage(messageId);
    const proposal = message?.metadata.proposal;
    const hunk = proposal?.hunks.find((item) => item.id === hunkId);
    if (!message || !proposal || !hunk || hunk.status !== "pending" || !editorApi) {
      return;
    }
    const content = editorApi.getContent();
    if (
      !proposalMatchesContent(proposal, content) ||
      content.slice(hunk.from, hunk.to) !== hunk.original
    ) {
      const stale = markPendingHunks(proposal, "stale");
      await saveAiMessageMetadata(message, { ...message.metadata, proposal: stale });
      notify("제안 생성 뒤 해당 원문이 바뀌어 적용하지 않았습니다.", "error");
      return;
    }
    await createSnapshot("ai");
    editorApi.replaceRange(hunk.from, hunk.to, hunk.replacement);
    const updated = updateProposalAfterHunk(proposal, hunkId, "applied");
    await saveAiMessageMetadata(message, { ...message.metadata, proposal: updated });
    await updateAiConversationTarget(updated);
    notify("AI 변경 한 건을 적용했습니다. 실행 취소할 수 있습니다.", "success");
  }

  async function rejectAiHunk(messageId: string, hunkId: string): Promise<void> {
    const message = aiMessage(messageId);
    const proposal = message?.metadata.proposal;
    if (!message || !proposal) return;
    const updated = updateProposalAfterHunk(proposal, hunkId, "rejected");
    await saveAiMessageMetadata(message, { ...message.metadata, proposal: updated });
  }

  async function applyAllAiHunks(messageId: string): Promise<void> {
    const message = aiMessage(messageId);
    const proposal = message?.metadata.proposal;
    if (!message || !proposal || !editorApi) return;
    const content = editorApi.getContent();
    const edits = pendingProposalEdits(proposal, content);
    if (!edits) {
      const stale = markPendingHunks(proposal, "stale");
      await saveAiMessageMetadata(message, { ...message.metadata, proposal: stale });
      notify("제안 생성 뒤 원문이 바뀌어 변경을 적용하지 않았습니다.", "error");
      return;
    }
    if (!edits.length) return;
    await createSnapshot("ai");
    editorApi.replaceRanges(edits);
    const delta = edits.reduce(
      (total, edit) => total + edit.text.length - (edit.to - edit.from),
      0,
    );
    const updated = {
      ...markPendingHunks(proposal, "applied"),
      targetTo: proposal.targetTo + delta,
      baseText: editorApi
        .getContent()
        .slice(proposal.targetFrom, proposal.targetTo + delta),
    };
    await saveAiMessageMetadata(message, { ...message.metadata, proposal: updated });
    await updateAiConversationTarget(updated);
    notify(`AI 변경 ${edits.length}건을 적용했습니다. 한 번에 실행 취소할 수 있습니다.`, "success");
  }

  async function rejectAllAiHunks(messageId: string): Promise<void> {
    const message = aiMessage(messageId);
    const proposal = message?.metadata.proposal;
    if (!message || !proposal) return;
    await saveAiMessageMetadata(message, {
      ...message.metadata,
      proposal: markPendingHunks(proposal, "rejected"),
    });
  }

  function setAutoComplete(enabled: boolean): void {
    preferences.autoComplete = enabled;
    savePreferences();
    if (!enabled) editorApi?.clearGhostText();
  }

  async function runCompletion(): Promise<void> {
    if (!desktop || !currentDocument || completionBusy || aiChatBusy) return;
    const selected = editorApi?.getSelection() ?? selection;
    completionBusy = true;
    const contentAtRequest = editorValue;
    try {
      const response = await invoke<AiWritingResponse>("run_ai_writing", {
        request: {
          action: "complete",
          selection: "",
          documentContext: editorValue.slice(
            Math.max(0, selected.from - 5500),
            Math.min(editorValue.length, selected.from + 1000),
          ),
          styleReference,
          instructions: "",
          sources: sourceContexts,
        },
      });
      const latest = editorApi?.getSelection();
      if (
        latest &&
        latest.from === selected.from &&
        latest.to === selected.to &&
        editorValue === contentAtRequest
      ) {
        editorApi?.setGhostText(response.replacement);
      }
    } catch {
      // Background completion stays silent; explicit chat errors remain visible.
    } finally {
      completionBusy = false;
    }
  }

  function scheduleCompletion(): void {
    editorApi?.clearGhostText();
    if (completionTimer) clearTimeout(completionTimer);
    if (!preferences.autoComplete || selection.text || !currentDocument) return;
    completionTimer = setTimeout(() => void runCompletion(), 700);
  }

  function noteWritingActivity(): void {
    if (
      !preferences.flowAutoHideChrome ||
      preferences.writingExperience !== "flow" ||
      !currentDocument
    ) {
      return;
    }
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
      }, 1200);
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

  function saveFlowChromePreference(): void {
    if (!preferences.flowAutoHideChrome) resetChromeSuppression();
    savePreferences();
  }

  function handleEditorActivity(activity: WritingActivity): void {
    if (activity.origin !== "keyboard") return;
    sessionWords += activity.wordDelta;
    sessionSentences += activity.sentenceDelta;
    sessionParagraphs += activity.paragraphDelta;
    const completed: Array<"sentence" | "paragraph"> = [
      ...Array.from(
        { length: activity.sentenceDelta },
        () => "sentence" as const,
      ),
      ...Array.from(
        { length: activity.paragraphDelta },
        () => "paragraph" as const,
      ),
    ];
    if (completed.length) {
      sessionMarks = [...sessionMarks, ...completed].slice(-12);
    }
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
      "화면 가운데에는 여백과 행간을 세심하게 다듬은 A4 종이가 놓인다. Markdown 기호는 조용한 표식으로 안내하고, 제목·본문·인용은 출판 원고처럼 즉시 조판된다.",
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
        if (flowChromeHidden) {
          event.preventDefault();
          resetChromeSuppression();
          return;
        }
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
        if (aiOpen) {
          if (
            aiExpanded &&
            typeof window !== "undefined" &&
            window.innerWidth <= 1280
          ) {
            aiExpanded = false;
          } else {
            closeAi();
          }
          return;
        }
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
    } else if (event.key.toLowerCase() === "p" && event.shiftKey) {
      event.preventDefault();
      void toggleLeft("search");
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      void printCompletedDocument();
    } else if (event.key === "\\") {
      event.preventDefault();
      void toggleLeft("outline");
    }
  }

  onMount(async () => {
    desktop = isDesktopRuntime();
    loadPreferences();
    watchSystemTheme();
    await initializeWindowChrome();
    if (typeof ResizeObserver !== "undefined" && writingStage) {
      stageObserver = new ResizeObserver(measureWritingStage);
      stageObserver.observe(writingStage);
      measureWritingStage();
    }
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

    await refreshFonts();
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
    if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
    stageObserver?.disconnect();
    stageObserver = null;
    if (syncTimer) clearInterval(syncTimer);
  });
</script>

<svelte:head>
  <title>{documentTitle}</title>
</svelte:head>

<main
  class:panel-left={leftPanel !== null}
  class:panel-right={rightPanel !== null}
  class:ai-open={aiOpen}
  class:platform-macos={runtimePlatform === "macos"}
  class:split-dragging={splitDragging}
  class:flow-chrome-hidden={flowChromeHidden}
  class="app-shell"
  onmousemove={revealChrome}
>
  <header
    class:chrome-hidden={Boolean(currentDocument) &&
      (flowChromeHidden || preferences.focusSheetMode)}
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

    <div class="formatting-toolbar" aria-label="글쓰기 서식">
      <label class="toolbar-select style-select" title="문단의 의미 구조">
        <span class="sr-only">문단 스타일</span>
        <select
          value={activeBlockStyle}
          disabled={formattingDisabled}
          onchange={(event) =>
            void formatBlock(event.currentTarget.value as MarkdownBlockStyle)}
        >
          <option value="body">본문</option>
          <option value="heading1">문서 제목</option>
          <option value="heading2">큰 제목</option>
          <option value="heading3">작은 제목</option>
          <option value="quote">인용</option>
          <option value="bullet">목록</option>
        </select>
      </label>
      <label
        class="toolbar-select font-select"
        title="문서 전체 글꼴 · 저장소에 포함된 글꼴만 사용합니다"
      >
        <span class="sr-only">글꼴</span>
        <select
          value={currentFontFamily}
          disabled={!currentDocument}
          onchange={handleFontFamilyChange}
        >
          {#each fonts as font}
            <option value={font.family}>{font.family}</option>
          {/each}
        </select>
      </label>
      <div class="experience-picker">
        <div
          class="experience-segmented"
          role="radiogroup"
          tabindex="-1"
          aria-label="쓰기 감각"
          onkeydown={handleExperiencePickerKeydown}
        >
          {#each writingExperiences as experience}
            <button
              class:active={preferences.writingExperience === experience.id}
              class="experience-segment"
              data-experience={experience.id}
              role="radio"
              aria-checked={preferences.writingExperience === experience.id}
              title={experience.description}
              disabled={!currentDocument}
              onclick={() => void setWritingExperience(experience.id)}
            >
              <span class="experience-glyph" data-kind={experience.id} aria-hidden="true">
                {#if experience.id === "typewriter"}
                  <svg viewBox="0 0 24 24"><path d="M7 3h10v6H7zM3 9h18M5 12h14l2 8H3l2-8M7 15h.01M10.3 15h.01M13.7 15h.01M17 15h.01M6 18h12"></path></svg>
                {:else if experience.id === "literary"}
                  <svg viewBox="0 0 24 24"><path d="M4 5.5c3-1 5.6-.6 8 1.2v12c-2.4-1.8-5-2.2-8-1.2zM20 5.5c-3-1-5.6-.6-8 1.2v12c2.4-1.8 5-2.2 8-1.2z"></path></svg>
                {:else}
                  <svg viewBox="0 0 24 24"><path d="M5 7h14M7 12h10M9 17h6"></path><circle cx="12" cy="12" r="9"></circle></svg>
                {/if}
              </span>
              <span class="experience-segment-copy"><strong>{experience.label}</strong><small>{experience.cue}</small></span>
            </button>
          {/each}
        </div>

        <div class="toolbar-menu-host experience-compact">
          <button
            class:active={toolbarMenu === "experience"}
            class="toolbar-text-button toolbar-menu-button experience-current"
            aria-label={`쓰기 감각: ${currentWritingExperience.label}`}
            title={currentWritingExperience.description}
            aria-haspopup="menu"
            aria-expanded={toolbarMenu === "experience"}
            disabled={!currentDocument}
            onclick={(event) =>
              void toggleToolbarMenu("experience", event.currentTarget)}
          >
            {#if currentWritingExperience.id === "typewriter"}
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3h10v6H7zM3 9h18M5 12h14l2 8H3l2-8M7 15h.01M10.3 15h.01M13.7 15h.01M17 15h.01M6 18h12"></path></svg>
            {:else if currentWritingExperience.id === "literary"}
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5.5c3-1 5.6-.6 8 1.2v12c-2.4-1.8-5-2.2-8-1.2zM20 5.5c-3-1-5.6-.6-8 1.2v12c2.4-1.8 5-2.2 8-1.2z"></path></svg>
            {:else}
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M7 12h10M9 17h6"></path><circle cx="12" cy="12" r="9"></circle></svg>
            {/if}
            <span class="experience-current-label">{currentWritingExperience.label}</span>
            <svg class="toolbar-chevron" aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"></path></svg>
          </button>
          {#if toolbarMenu === "experience"}
            <div
              class="toolbar-popover toolbar-menu experience-menu"
              role="menu"
              tabindex="-1"
              data-menu="experience"
              onkeydown={handleToolbarMenuKeydown}
            >
              {#each writingExperiences as experience}
                <button
                  class:active={preferences.writingExperience === experience.id}
                  role="menuitemradio"
                  aria-checked={preferences.writingExperience === experience.id}
                  onclick={() => void setWritingExperience(experience.id)}
                >
                  <span class="experience-menu-copy">
                    <strong>{experience.label}</strong>
                    <small>{experience.description}</small>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
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
    </div>

    <div class="document-toolbar" aria-label="문서 작업">
      <div class="toolbar-menu-host compact-menu">
        <button
          class:active={toolbarMenu === "insert" || toolbarMenu === "link"}
          class="toolbar-text-button toolbar-menu-button"
          aria-label="삽입 메뉴"
          title="삽입"
          aria-haspopup="menu"
          aria-expanded={toolbarMenu === "insert" || toolbarMenu === "link"}
          disabled={formattingDisabled}
          onclick={(event) => void toggleToolbarMenu("insert", event.currentTarget)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>
          <span class="toolbar-menu-label">삽입</span>
          <svg class="toolbar-chevron" aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"></path></svg>
        </button>
        {#if toolbarMenu === "insert"}
          <div
            class="toolbar-popover toolbar-menu"
            role="menu"
            tabindex="-1"
            data-menu="insert"
            onkeydown={handleToolbarMenuKeydown}
          >
            <button role="menuitem" onclick={() => { toolbarMenu = null; openMetadataDialog(); }}>원고 정보</button>
            <button role="menuitem" onclick={() => void openLinkMenu()}>링크… <kbd>Ctrl K</kbd></button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openFigureDialog(); }}>그림</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openTableDialog(); }}>표</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openMathDialog(); }}>수식</button>
            <button role="menuitem" onclick={() => { toolbarMenu = null; openFootnoteDialog(); }}>각주</button>
          </div>
        {:else if toolbarMenu === "link"}
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
      <span class="toolbar-divider document-divider"></span>
      <button
        class="toolbar-icon-button"
        title="인쇄/PDF 저장 (Ctrl+P)"
        aria-label="인쇄 또는 PDF 저장"
        disabled={!currentDocument}
        onclick={() => void printCompletedDocument()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7zM17 11h.01"></path></svg>
      </button>
    </div>

    <div class="topbar-actions">
      <button
        class:active={aiOpen}
        class="ai-header-button"
        title={aiOpen ? "AI 채팅 닫기" : "AI 채팅 열기"}
        aria-label={aiOpen ? "AI 채팅 닫기" : "AI 채팅 열기"}
        aria-expanded={aiOpen}
        aria-controls="ai-panel"
        disabled={!currentDocument}
        onclick={() => void toggleAi()}
      >
        <span aria-hidden="true">✦</span><strong>AI</strong>
      </button>
      <button
        class="panel-toggle theme-toggle"
        title={darkThemeActive ? "밝은 모드로 전환" : "어두운 모드로 전환"}
        aria-label={darkThemeActive ? "밝은 모드로 전환" : "어두운 모드로 전환"}
        aria-pressed={darkThemeActive}
        onclick={toggleTheme}
      >
        {#if darkThemeActive}
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3.5"></circle>
            <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"></path>
          </svg>
        {:else}
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"></path>
          </svg>
        {/if}
      </button>
      <button
        class:active={rightPanel !== null}
        class="panel-toggle tools-toggle"
        title={rightPanel ? "도구 패널 닫기" : "도구 패널 열기"}
        aria-label={rightPanel ? "도구 패널 닫기" : "도구 패널 열기"}
        aria-expanded={rightPanel !== null}
        aria-controls="right-panel"
        onclick={() => void togglePrimaryRight()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <path d="M15 4v16M18 8h.01M18 12h.01M18 16h.01"></path>
        </svg>
      </button>
      {#if desktop && runtimePlatform !== "macos"}
        <div class="window-controls" aria-label="창 제어">
          <button title="최소화" aria-label="최소화" onclick={() => void minimizeWindow()}><svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2 6h8"></path></svg></button>
          <button title={windowMaximized ? "복원" : "최대화"} aria-label={windowMaximized ? "창 복원" : "최대화"} onclick={() => void toggleWindowMaximize()}>
            {#if windowMaximized}<svg aria-hidden="true" viewBox="0 0 12 12"><path d="M3.5 1.5h7v7M1.5 3.5h7v7h-7z"></path></svg>{:else}<svg aria-hidden="true" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"></rect></svg>{/if}
          </button>
          <button class="window-close" title="끝내기" aria-label="프로그램 끝내기" onclick={() => void requestAppExit()}><svg aria-hidden="true" viewBox="0 0 12 12"><path d="m2 2 8 8M10 2 2 10"></path></svg></button>
        </div>
      {/if}
    </div>
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

  <section class="writing-stage" bind:this={writingStage}>
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

      <div
        class:has-companion={companionView !== null}
        class:compact-companion={compactCompanion}
        class="writing-surface"
        style={companionView && !compactCompanion
          ? `grid-template-columns:calc(${preferences.companionSplitRatio * 100}% - 4px) 8px minmax(0, 1fr)`
          : undefined}
      >
        <div class="document-pane paper-pane">
          <PaginatedEditor
            value={editorValue}
            readOnly={currentDocument.readOnly}
            fallbackTitle={documentFallbackTitle}
            documentPath={currentDocument.path}
            fontFamily={currentFontFamily}
            experience={preferences.writingExperience}
            fitMode={preferences.pageFitMode}
            focusMode={preferences.focusMode}
            {sessionWords}
            {sessionSentences}
            {sessionParagraphs}
            {sessionMarks}
            resolveImage={resolveManuscriptImage}
            onready={handlePaperReady}
            onchange={onEditorChange}
            onselection={(value) => handleEditorSelection("paper", value)}
            onactivity={handleEditorActivity}
            onfocuschange={(focused) => focused && setActiveEditor("paper")}
            onscrollanchor={handleScrollAnchor}
          />
        </div>
        {#if companionView}
          <button
            class="split-handle"
            title="분할 너비 조절"
            aria-label="편집 화면과 Markdown 원문 너비 조절"
            onpointerdown={beginSplitResize}
          ><span></span></button>
          <div class="companion-pane">
            {#if SourceEditor}
              <SourceEditor
                value={editorValue}
                readOnly={currentDocument.readOnly}
                fontFamily={currentFontFamily}
                onready={handleSourceReady}
                onchange={onEditorChange}
                onselection={(value) => handleEditorSelection("source", value)}
                onactivity={handleEditorActivity}
                onfocuschange={(focused) => focused && setActiveEditor("source")}
                onscrollanchor={handleScrollAnchor}
              />
            {/if}
          </div>
        {/if}
      </div>

      {#if selection.text && !conflict && !aiOpen}
        <div class="selection-ai-trigger">
          <button onclick={() => void openAiForSelection()}><span aria-hidden="true">✦</span> AI로 수정</button>
        </div>
      {/if}

      <footer class="statusbar">
        <div>
          <span>{words.toLocaleString("ko-KR")}단어</span>
          <span>약 {minutes}분</span>
          {#if activeEditor === "paper"}
            <span>
              {selection.page ?? 1}쪽 · {selection.line}행
            </span>
          {:else}
            <span>{selection.line}행 · Markdown 원문</span>
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
          <span>A4</span>
          <strong>EDITORIAL</strong>
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
          <span>R</span><span>W</span>
        </div>
        <p class="welcome-kicker">LOCAL · MARKDOWN · EDITORIAL</p>
        <h1>Research Writer</h1>
        <p class="welcome-copy">
          폴더를 저장소로 열고,<br />
          종이 위에 쓰듯 차분하게 문서를 완성하세요.
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
            <p class="eyebrow">문서 작성 안내</p>
            <h3>형식보다 문장에 집중하세요</h3>
            <p>
              A4 편집 화면이 Markdown 문법을 자연스러운 제목·본문·인용으로
              보여줍니다. 원문은 계속 표준 Markdown으로 저장되므로 다른
              편집기에서도 그대로 열 수 있습니다.
            </p>
            <div class="guidance-checklist">
              <span><b>1</b> Enter는 새 문단, Shift+Enter는 줄바꿈</span>
              <span><b>2</b> 제목·목록·인용은 상단 서식에서 선택</span>
              <span><b>3</b> 표·그림·수식은 상단 삽입 도구 사용</span>
            </div>
            <button class="wide-button" onclick={openMetadataDialog}
              >제목·작성자 문서 정보</button
            >
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
                AI 검사는 ChatGPT 연결 후 사용하며, 실행할 때 선택한 범위만
                전송합니다.
              </p>
              <button class="wide-button" onclick={() => void startAiLogin(false)}
                >ChatGPT로 연결</button
              >
            {/if}
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
            <button
              class="wide-button"
              disabled={!repository?.available}
              onclick={() => void importRepositoryFont()}
            >
              저장소에 글꼴 가져오기
            </button>
            <p class="panel-note">
              TTF·OTF·WOFF2 파일을 <code>.research-writer/fonts</code>에 복사해 모든 운영체제와 PDF에서 같은 조판을 유지합니다.
            </p>
            <label class="field">
              <span>집중 모드</span>
              <select bind:value={preferences.focusMode} onchange={savePreferences}>
                <option value="off">끄기</option>
                <option value="paragraph">현재 문단</option>
                <option value="sentence">현재 문장</option>
              </select>
            </label>
          </section>

          <section class="panel-section">
            <button
              class:active={advancedSettingsOpen}
              class="settings-advanced-toggle"
              onclick={() => (advancedSettingsOpen = !advancedSettingsOpen)}
            >
              <span>고급 설정</span>
              <small>{advancedSettingsOpen ? "접기" : "쓰기 감각·연구 연결"}</small>
            </button>
          </section>

          {#if advancedSettingsOpen}
            <section class="panel-section advanced-settings">
              <p class="eyebrow">쓰기 감각</p>
              <label class="switch-row">
                <div><strong>집중 집필</strong><small>현재 장만 남기고 패널과 헤더를 조용히 감춤</small></div>
                <input type="checkbox" checked={preferences.focusSheetMode} onchange={toggleSingleSheetMode} />
              </label>
              <label class="switch-row">
                <div><strong>몰입 캔버스 자동 정리</strong><small>계속 타이핑하면 도구와 패널만 물러나고 원고 위치는 유지</small></div>
                <input type="checkbox" bind:checked={preferences.flowAutoHideChrome} onchange={saveFlowChromePreference} />
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

  {#if aiOpen && currentDocument}
    <aside id="ai-panel" class:expanded={aiExpanded} class="ai-panel">
      <AiChatPanel
        account={aiAccount}
        {login}
        conversation={aiConversation}
        conversations={aiConversations}
        busy={aiChatBusy}
        expanded={aiExpanded}
        readOnly={currentDocument.readOnly}
        pendingSelection={pendingAiSelection}
        {styleReferenceName}
        sourceCount={sourceContexts.length}
        autoComplete={preferences.autoComplete}
        onclose={closeAi}
        onexpandedchange={(expanded) => (aiExpanded = expanded)}
        onnewconversation={startNewAiConversation}
        onselectconversation={loadAiConversation}
        ondeleteconversation={deleteAiConversation}
        onnewselection={startNewAiConversation}
        onsend={sendAiChat}
        onapplyhunk={applyAiHunk}
        onrejecthunk={rejectAiHunk}
        onapplyall={applyAllAiHunks}
        onrejectall={rejectAllAiHunks}
        onlogin={startAiLogin}
        onrefreshlogin={refreshAiAccount}
        onchoosestyle={chooseStyleReference}
        onautocompletechange={setAutoComplete}
      />
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
          정보는 호환 가능한 YAML 속성으로 저장되며 제목과 문서 속성에
          일관되게 반영됩니다.
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

  .app-shell.ai-open {
    grid-template-columns: 0 minmax(0, 1fr) 380px;
  }

  .app-shell.panel-left.panel-right {
    grid-template-columns: 278px minmax(0, 1fr) 334px;
  }

  .app-shell.panel-left.ai-open {
    grid-template-columns: 278px minmax(0, 1fr) 372px;
  }

  .topbar {
    grid-area: top;
    z-index: 30;
    display: grid;
    grid-template-columns:
      auto minmax(100px, 220px) minmax(250px, 1fr) auto auto;
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
    user-select: none;
    -webkit-app-region: drag;
  }

  .topbar button,
  .topbar input,
  .topbar select {
    -webkit-app-region: no-drag;
  }

  .platform-macos .topbar {
    padding-left: 78px;
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

  .panel,
  .statusbar {
    transition: opacity 520ms ease;
  }

  .flow-chrome-hidden .panel,
  .flow-chrome-hidden .ai-panel,
  .flow-chrome-hidden .statusbar {
    opacity: 0.035;
    pointer-events: none;
  }

  .panel-toggle,
  .format-button,
  .toolbar-icon-button,
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
  .toolbar-icon-button.active,
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
    color: var(--control-on-warning);
    font-size: 9px;
    font-weight: 750;
    line-height: 1;
  }

  .tools-toggle {
    justify-self: end;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    align-self: stretch;
    gap: 4px;
  }

  .ai-header-button {
    display: flex;
    height: 32px;
    align-items: center;
    gap: 5px;
    border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--rule));
    border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    padding: 0 10px;
    color: var(--accent);
    font-size: var(--type-control);
  }

  .ai-header-button > span {
    font-size: 14px;
    line-height: 1;
  }

  .ai-header-button > strong { font-size: 11px; }

  .ai-header-button:hover:not(:disabled),
  .ai-header-button.active {
    border-color: color-mix(in srgb, var(--accent) 64%, var(--rule));
    background: color-mix(in srgb, var(--accent) 13%, transparent);
  }

  .ai-header-button:disabled { opacity: 0.45; }

  .window-controls {
    display: flex;
    align-self: stretch;
    margin: 0 -10px 0 2px;
  }

  .window-controls button {
    display: grid;
    place-items: center;
    width: 42px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--ink-muted);
  }

  .window-controls button:hover {
    background: color-mix(in srgb, var(--ink-strong) 8%, transparent);
    color: var(--ink-strong);
  }

  .window-controls .window-close:hover {
    background: #c4473d;
    color: white;
  }

  .window-controls svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.1;
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

  .formatting-toolbar,
  .document-toolbar {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 2px;
  }

  .formatting-toolbar {
    justify-content: center;
  }

  .experience-picker {
    display: flex;
    min-width: 0;
  }

  .experience-segmented {
    display: flex;
    align-items: center;
    height: 36px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--rule) 76%, transparent);
    border-radius: 11px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--surface-raised) 64%, transparent), transparent),
      color-mix(in srgb, var(--chrome) 78%, transparent);
    padding: 2px;
    box-shadow: inset 0 1px color-mix(in srgb, white 24%, transparent);
  }

  .experience-segment {
    display: flex;
    height: 30px;
    align-items: center;
    gap: 6px;
    border-radius: 8px;
    padding: 0 9px 0 7px;
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .experience-glyph {
    display: grid;
    width: 20px;
    height: 20px;
    place-items: center;
    border-radius: 6px;
    background: color-mix(in srgb, var(--ink-strong) 5%, transparent);
  }

  .experience-glyph svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.45;
  }

  .experience-segment-copy {
    display: grid;
    gap: 0;
    text-align: left;
  }

  .experience-segment-copy strong {
    font-size: 10px;
    font-weight: 720;
    line-height: 1.05;
  }

  .experience-segment-copy small {
    color: var(--ink-faint);
    font-size: 8px;
    font-weight: 580;
    line-height: 1.15;
  }

  .experience-segment:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink-strong) 5%, transparent);
    color: var(--ink-strong);
  }

  .experience-segment.active {
    background: var(--surface-raised);
    box-shadow: 0 1px 5px color-mix(in srgb, var(--ink-strong) 14%, transparent);
    color: var(--accent);
  }

  .experience-segment[data-experience="typewriter"].active .experience-glyph {
    background: #30322f;
    color: #e1c994;
  }

  .experience-segment[data-experience="literary"].active .experience-glyph {
    background: color-mix(in srgb, #9a6847 14%, var(--surface-raised));
    color: #95603e;
  }

  .experience-segment[data-experience="flow"].active .experience-glyph {
    background: color-mix(in srgb, var(--link) 13%, var(--surface-raised));
    color: var(--link);
  }

  .toolbar-menu-host.experience-compact {
    display: none;
  }

  .experience-current {
    gap: 6px;
  }

  .experience-current > svg:first-child {
    width: 16px;
    height: 16px;
  }

  .experience-menu {
    width: 220px;
  }

  .experience-menu button {
    display: flex;
    height: auto;
    align-items: center;
    padding: 8px 10px;
  }

  .experience-menu-copy { display: grid; gap: 2px; }

  .experience-menu button strong {
    color: inherit;
    font-size: var(--type-control);
  }

  .experience-menu button small {
    color: var(--ink-faint);
    font-size: var(--type-micro);
  }

  .document-toolbar {
    justify-self: end;
    padding-left: 9px;
    border-left: 1px solid color-mix(in srgb, var(--rule) 78%, transparent);
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

  .toolbar-icon-button {
    display: grid;
    place-items: center;
    width: 30px;
    min-width: 30px;
    height: 30px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-muted);
  }

  .toolbar-icon-button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink-strong) 6%, transparent);
    color: var(--ink-strong);
  }

  .toolbar-icon-button:disabled { opacity: 0.55; }

  .toolbar-icon-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.6;
  }

  .toolbar-menu-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 0 7px;
  }

  .toolbar-menu-button > svg:first-child {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.65;
  }

  .toolbar-menu-button .toolbar-chevron {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.4;
  }

  .document-divider {
    margin-right: 4px;
    margin-left: 5px;
  }

  .italic-button {
    font-style: italic;
  }

  .format-button:disabled,
  .toolbar-text-button:disabled,
  .toolbar-select select:disabled {
    opacity: 0.55;
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

  .toolbar-menu button kbd {
    float: right;
    margin-left: 20px;
    color: var(--ink-faint);
    font-family: var(--ui-font);
    font-size: var(--type-micro);
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
    color: var(--control-on-accent);
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

  .writing-surface {
    position: absolute;
    inset: 0 0 28px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .document-pane,
  .companion-pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .split-handle {
    position: relative;
    z-index: 6;
    display: grid;
    place-items: center;
    width: 8px;
    min-width: 8px;
    border: 0;
    border-right: 1px solid color-mix(in srgb, var(--rule) 74%, transparent);
    border-left: 1px solid color-mix(in srgb, var(--rule) 74%, transparent);
    background: var(--chrome);
    padding: 0;
    cursor: col-resize;
  }

  .split-handle span {
    width: 2px;
    height: 34px;
    border-radius: 2px;
    background: var(--rule-strong);
  }

  .split-handle:hover span,
  .split-dragging .split-handle span { background: var(--accent); }

  .split-dragging,
  .split-dragging * { cursor: col-resize !important; user-select: none !important; }

  .writing-surface.compact-companion {
    grid-template-columns: minmax(0, 1fr) !important;
  }

  .writing-surface.compact-companion .document-pane,
  .writing-surface.compact-companion .split-handle { display: none; }

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

  .ai-panel {
    grid-area: right;
    position: relative;
    z-index: 18;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-left: 1px solid var(--rule);
    background: var(--panel);
    box-shadow: -8px 0 24px color-mix(in srgb, var(--ink-strong) 5%, transparent);
    transition: opacity 220ms ease, transform 220ms ease;
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

  .quiet-line {
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
    border: 1px solid var(--control-border);
    border-radius: 7px;
    background: var(--control-bg);
    padding: 0 12px;
    color: var(--control-fg);
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
    background: var(--control-bg);
    padding: 5px 8px;
    color: var(--control-fg);
    font-size: var(--type-control);
  }

  .selection-ai-trigger {
    position: absolute;
    z-index: 9;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
  }

  .writing-stage:has(.encoding-banner) .selection-ai-trigger {
    top: 54px;
  }

  .selection-ai-trigger button {
    height: 36px;
    border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--rule));
    border-radius: 10px;
    background: var(--paper-raised);
    padding: 0 12px;
    box-shadow: var(--shadow);
    color: var(--ink-strong);
    font-size: 13px;
    font-weight: 650;
  }

  .selection-ai-trigger button span {
    margin-right: 5px;
    color: var(--accent);
  }

  .selection-ai-trigger button:hover {
    border-color: color-mix(in srgb, var(--accent) 68%, var(--rule));
    background: color-mix(in srgb, var(--accent) 8%, var(--paper-raised));
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
    color: var(--control-on-accent);
  }

  .primary-button:hover:not(:disabled),
  .wide-button.accent:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink-strong));
    box-shadow: var(--shadow-contact);
  }

  .secondary-button:hover:not(:disabled),
  .wide-button:not(.accent):hover:not(:disabled),
  .named-version button:hover:not(:disabled),
  .source-search button:hover:not(:disabled),
  .article-actions button:hover:not(:disabled),
  .source-list article > button:hover:not(:disabled),
  .table-size-controls button:hover:not(:disabled),
  .conflict-modal footer button:hover:not(:disabled) {
    background: var(--control-bg-hover);
    color: var(--control-fg);
  }

  .secondary-button {
    border: 1px solid var(--control-border);
    background: var(--control-bg);
    color: var(--control-fg);
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

  .article-actions button,
  .source-list article > button {
    border: 1px solid var(--control-border);
    border-radius: 6px;
    background: var(--control-bg);
    padding: 6px 9px;
    color: var(--control-fg);
    font-size: var(--type-control);
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

  .panel-section textarea {
    width: 100%;
    resize: vertical;
    font-size: var(--type-control);
    line-height: 1.55;
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
    border: 1px solid var(--control-border);
    border-radius: 7px;
    background: var(--control-bg);
    padding: 8px 10px;
    color: var(--control-fg);
    font-size: var(--type-control);
  }

  .wide-button.accent {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--control-on-accent);
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
    border: 1px solid var(--control-border);
    border-radius: 5px;
    background: var(--control-bg);
    padding: 5px 7px;
    color: var(--control-fg-muted);
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
    border: 1px solid var(--control-border);
    border-radius: 7px;
    background: var(--control-bg);
    padding: 8px 12px;
    color: var(--control-fg);
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
    .app-shell.ai-open,
    .app-shell.panel-left.ai-open,
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

    .ai-panel {
      position: fixed;
      z-index: 26;
      top: 58px;
      left: 50%;
      width: min(680px, calc(100vw - 24px));
      height: auto;
      min-height: 0;
      max-height: 52px;
      transform: translateX(-50%);
      border: 1px solid var(--rule-strong);
      border-radius: 12px;
      box-shadow: 0 20px 52px color-mix(in srgb, var(--ink-strong) 24%, transparent);
      transition: max-height 180ms ease, opacity 180ms ease, transform 180ms ease;
    }

    .ai-panel.expanded {
      max-height: min(60vh, 560px);
    }

    .app-shell:has(.encoding-banner) .ai-panel {
      top: 104px;
    }
  }

  @media (max-width: 1100px) {
    .topbar {
      grid-template-columns:
        auto minmax(80px, 140px) minmax(220px, 1fr) auto auto;
    }

    .font-select select {
      width: 108px;
    }

    .experience-segmented {
      display: none;
    }

    .toolbar-menu-host.experience-compact {
      display: flex;
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
      display: none;
    }

    .toolbar-menu-label,
    .toolbar-chevron {
      display: none;
    }

    .toolbar-menu-button {
      width: 30px;
      min-width: 30px;
      padding: 0;
    }

    .formatting-toolbar {
      justify-content: flex-start;
    }

    .style-select select {
      width: 80px;
    }

    .font-select select {
      width: 104px;
    }

    .document-toolbar {
      padding-left: 5px;
    }

    .ai-header-button {
      width: 32px;
      justify-content: center;
      padding: 0;
    }

    .ai-header-button > strong { display: none; }
  }

  @media (max-width: 760px) {
    .topbar {
      gap: 2px;
      padding: 0 4px;
    }

    .style-select select {
      width: 76px;
    }

    .font-select select {
      width: 96px;
    }

    .document-toolbar {
      padding-left: 3px;
    }

    .window-controls {
      margin-left: 0;
    }
  }

  @media (max-width: 680px) {
    .font-select {
      display: none;
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
    .ai-panel,
    .encoding-banner,
    .selection-ai-trigger,
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

    .writing-surface {
      position: static;
      display: block;
      overflow: visible;
    }

    .split-handle,
    .companion-pane {
      display: none !important;
    }

    .document-pane {
      display: block;
      overflow: visible;
    }
  }
</style>
