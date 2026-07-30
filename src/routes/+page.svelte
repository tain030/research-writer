<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { diffWords } from "diff";
  import Editor, { type EditorApi } from "$lib/Editor.svelte";
  import {
    basename,
    countWords,
    currentSection,
    displayDate,
    extractOutline,
    findFootnoteByIdentity,
    nextFootnoteId,
    readingMinutes,
  } from "$lib/markdown";
  import {
    defaultPreferences,
    parsePreferences,
    type Preferences,
  } from "$lib/preferences";
  import { externalSyncProvider } from "$lib/storage";
  import type {
    AiAccountStatus,
    AiLoginStart,
    AiSourceContext,
    AiWritingResponse,
    AssistantPanel,
    DocumentPayload,
    EditorSelection,
    FontRecord,
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

  let desktop = $state(false);
  let currentDocument = $state<DocumentPayload | null>(null);
  let editorValue = $state("");
  let baseContent = $state("");
  let editorApi = $state<EditorApi | null>(null);
  let selection = $state<EditorSelection>({
    from: 0,
    to: 0,
    text: "",
    line: 1,
  });
  let leftPanel = $state<SidePanel>(null);
  let rightPanel = $state<AssistantPanel>(null);
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
  let login = $state<AiLoginStart | null>(null);
  let styleReference = $state("");
  let styleReferenceName = $state("");
  let selectedSourceIds = $state<string[]>([]);

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

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let completionTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let externalTimer: ReturnType<typeof setTimeout> | null = null;
  let repositoryTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let unlisteners: UnlistenFn[] = [];
  let lastSnapshotAt = 0;
  let closing = false;

  let outline = $derived(extractOutline(editorValue));
  let words = $derived(countWords(editorValue));
  let minutes = $derived(readingMinutes(editorValue));
  let documentTitle = $derived(
    currentDocument ? basename(currentDocument.path) : "Research Writer",
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
    currentDocument = null;
    editorValue = "";
    baseContent = "";
    saveState = "saved";
    saveError = "";
    conflict = null;
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
    currentDocument = document;
    editorValue = document.content;
    baseContent = document.content;
    saveState = "saved";
    saveError = "";
    conflict = null;
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
    if (saveState !== "dirty" && saveState !== "error") return true;
    await saveNow();
    return documentIsSaved();
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

  function onEditorChange(value: string): void {
    editorValue = value;
    if (!currentDocument || currentDocument.readOnly) return;
    saveState = "dirty";
    saveError = "";
    scheduleSave();
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 300);
  }

  async function saveNow(): Promise<void> {
    if (!currentDocument || currentDocument.readOnly || !desktop) return;
    if (saveState === "saved") return;
    if (conflict) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveState = "saving";
    const contentAtStart = editorValue;
    try {
      const result = await invoke<SaveDocumentResult>("save_document", {
        request: {
          path: currentDocument.path,
          content: contentAtStart,
          expectedHash: currentDocument.hash,
          lineEnding: currentDocument.lineEnding,
          bom: currentDocument.bom,
          force: false,
        },
      });
      if (result.status === "conflict" && result.diskDocument) {
        conflict = {
          remote: result.diskDocument,
          local: editorValue,
          base: baseContent,
        };
        saveState = "error";
        saveError = "다른 장치에서 원고가 변경되었습니다.";
        return;
      }
      currentDocument.hash = result.hash;
      currentDocument.modifiedAtMs = result.modifiedAtMs;
      baseContent = contentAtStart;
      if (editorValue === contentAtStart) {
        saveState = "saved";
      } else {
        saveState = "dirty";
        scheduleSave();
      }
      if (Date.now() - lastSnapshotAt >= 5 * 60_000) {
        lastSnapshotAt = Date.now();
        await createSnapshot("auto");
      }
    } catch (error) {
      saveState = "error";
      saveError = errorMessage(error);
      notify(`저장하지 못했습니다: ${saveError}`, "error");
    }
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
    }
    leftPanel = nextPanel;
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
    if (rightPanel === "ai") await refreshAiAccount();
    if (rightPanel === "sources") await refreshSources();
    if (rightPanel === "settings") {
      await Promise.all([
        refreshAiAccount(),
        refreshResearchConnection(),
        refreshResearchWorkspace(),
      ]);
    }
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

  async function restoreVersion(version: VersionSummary): Promise<void> {
    if (!desktop || !currentDocument) return;
    if (!window.confirm("현재 원고를 보관하고 이 버전으로 되돌릴까요?")) return;
    try {
      await createSnapshot("restore");
      const stored = await invoke<StoredVersion>("load_version", {
        id: version.id,
      });
      editorValue = stored.content;
      saveState = "dirty";
      scheduleSave();
      notify("선택한 버전을 편집 화면에 복원했습니다.", "success");
    } catch (error) {
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
    if (!editorApi || !currentDocument) return;
    try {
      const citation = await invoke<string>("format_zotero_citation", {
        item,
        style: citationStyle,
        locator: citationLocator || null,
        prefix: null,
        suffix: null,
      });
      insertFootnote(citation, [item.doi, item.url]);
      citationLocator = "";
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  function insertFootnote(citation: string, identities: string[] = []): void {
    if (!editorApi || !citation.trim()) return;
    const content = editorApi.getContent();
    const existing = findFootnoteByIdentity(content, identities);
    const id = existing ?? nextFootnoteId(content);
    const selected = editorApi.getSelection();
    if (!existing) {
      const separator = content.endsWith("\n\n")
        ? ""
        : content.endsWith("\n")
          ? "\n"
          : "\n\n";
      editorApi.replaceRange(
        content.length,
        content.length,
        `${separator}[^${id}]: ${citation.trim()}\n`,
      );
    }
    editorApi.replaceRange(selected.from, selected.to, `[^${id}]`);
    notify(
      existing
        ? `기존 각주 ${id}번을 다시 사용했습니다.`
        : `각주 ${id}번을 추가했습니다.`,
      "success",
    );
  }

  function insertManualCitation(): void {
    if (!manualCitation.trim()) return;
    insertFootnote(manualCitation.trim());
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
      "화면 가운데에는 스무 칸 열 줄의 원고지가 놓인다. Markdown 기호까지 한 칸씩 자리를 잡고, 이백 자가 차면 다음 장으로 자연스럽게 넘어간다.",
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
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      void createDocument();
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
      await getCurrentWindow().onCloseRequested(async (event) => {
        if (closing || saveState === "saved") return;
        event.preventDefault();
        await saveNow();
        if (documentIsSaved()) {
          closing = true;
          await getCurrentWindow().destroy();
        }
      }),
    );
    syncTimer = setInterval(() => void refreshSync(), 30_000);
  });

  onDestroy(() => {
    window.removeEventListener("keydown", keyboardHandler);
    unlisteners.forEach((unlisten) => unlisten());
    if (saveTimer) clearTimeout(saveTimer);
    if (searchTimer) clearTimeout(searchTimer);
    if (completionTimer) clearTimeout(completionTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (externalTimer) clearTimeout(externalTimer);
    if (repositoryTimer) clearTimeout(repositoryTimer);
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
>
  <header class="topbar">
    <div class="topbar-side">
      <button
        class:active={leftPanel === "repository"}
        class="icon-button"
        title="원고 저장소"
        onclick={() => void toggleLeft("repository")}
        aria-label="원고 저장소 열기"
      >
        ▱
      </button>
      <button
        class="icon-button"
        title="새 원고 (Ctrl+N)"
        aria-label="새 원고 만들기"
        disabled={creatingDocument || !repository?.available || !repository.writable}
        onclick={() => void createDocument()}
      >
        ＋
      </button>
      <button
        class:active={leftPanel === "outline"}
        class="icon-button"
        title="개요 (Ctrl+\\)"
        onclick={() => void toggleLeft("outline")}
        aria-label="개요 열기"
      >
        ☰
      </button>
      <button
        class:active={leftPanel === "search"}
        class="icon-button"
        title="전체 검색 (Ctrl+P)"
        onclick={() => void toggleLeft("search")}
        aria-label="검색 열기"
      >
        ⌕
      </button>
      <button
        class:active={leftPanel === "versions"}
        class="icon-button"
        title="버전"
        onclick={() => void toggleLeft("versions")}
        aria-label="버전 열기"
      >
        ◷
      </button>
    </div>

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

    <div class="topbar-side topbar-right">
      <button
        class:active={rightPanel === "ai"}
        class="text-button"
        onclick={() => void toggleRight("ai")}
      >
        AI
      </button>
      <button
        class:active={rightPanel === "sources"}
        class="icon-button"
        title="출처"
        onclick={() => void toggleRight("sources")}
        aria-label="출처 열기"
      >
        ◇
      </button>
      <button
        class:active={rightPanel === "settings"}
        class="icon-button"
        title="설정"
        onclick={() => void toggleRight("settings")}
        aria-label="설정 열기"
      >
        ···
      </button>
    </div>
  </header>

  {#if leftPanel}
    <aside class="panel left-panel">
      <div class="panel-heading">
        <div class="panel-tabs">
          <button
            class:active={leftPanel === "repository"}
            onclick={() => (leftPanel = "repository")}>원고</button
          >
          <button
            class:active={leftPanel === "outline"}
            onclick={() => (leftPanel = "outline")}>개요</button
          >
          <button
            class:active={leftPanel === "search"}
            onclick={() => void toggleLeft("search")}>검색</button
          >
          <button
            class:active={leftPanel === "versions"}
            onclick={() => void toggleLeft("versions")}>버전</button
          >
        </div>
        <button class="close-button" onclick={() => (leftPanel = null)}
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
              <button onclick={() => void restoreVersion(version)}>
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

      <Editor
        value={editorValue}
        readOnly={currentDocument.readOnly}
        fontFamily={preferences.fontFamily}
        focusMode={preferences.focusMode}
        typewriterMode={preferences.typewriterMode}
        soundEnabled={preferences.soundEnabled}
        onready={(api) => (editorApi = api)}
        onchange={onEditorChange}
        onselection={(value) => {
          selection = value;
          scheduleCompletion();
        }}
        onactivity={scheduleCompletion}
        onghostaccept={() => notify("자동 완성을 반영했습니다.", "success")}
      />

      {#if selection.text && !suggestion && !conflict}
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
          <span>
            {selection.page ?? 1}쪽 · {selection.row ?? 1}행 · {selection.column ?? 1}칸
          </span>
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
          <span>20 × 10</span>
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
          Ctrl+Shift+O 저장소 · Ctrl+O 파일 · Ctrl+N 새 원고 · Ctrl+W 닫기
        </p>
      </div>
    {/if}
  </section>

  {#if rightPanel}
    <aside class="panel right-panel">
      <div class="panel-heading">
        <div class="panel-tabs">
          <button
            class:active={rightPanel === "ai"}
            onclick={() => (rightPanel = "ai")}>AI</button
          >
          <button
            class:active={rightPanel === "sources"}
            onclick={() => void toggleRight("sources")}>출처</button
          >
          <button
            class:active={rightPanel === "settings"}
            onclick={() => (rightPanel = "settings")}>설정</button
          >
        </div>
        <button class="close-button" onclick={() => (rightPanel = null)}
          >×</button
        >
      </div>

      <div class="panel-content right-content">
        {#if rightPanel === "ai"}
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
                          insertFootnote(source.citationMarkdown, [source.url])}
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
            <p class="eyebrow">글자와 지면</p>
            <label class="field">
              <span>본문 글꼴</span>
              <select
                bind:value={preferences.fontFamily}
                onchange={savePreferences}
              >
                {#each fonts as font}
                  <option value={font.family}>
                    {font.family}{font.bundled ? " · 기본 제공" : ""}
                  </option>
                {/each}
              </select>
            </label>
            <div class="settings-fact">
              <strong>200자 원고지</strong>
              <span>20칸 × 10줄 · 한 글자 한 칸</span>
            </div>
            <label class="field">
              <span>집중 모드</span>
              <select bind:value={preferences.focusMode} onchange={savePreferences}>
                <option value="off">끄기</option>
                <option value="paragraph">현재 문단</option>
                <option value="sentence">현재 문장</option>
              </select>
            </label>
            <label class="switch-row">
              <div><strong>타자기 스크롤</strong><small>커서를 화면 42% 부근에 유지</small></div>
              <input
                type="checkbox"
                bind:checked={preferences.typewriterMode}
                onchange={savePreferences}
              />
            </label>
            <label class="switch-row">
              <div><strong>절제된 타건음</strong><small>기본값은 꺼짐</small></div>
              <input
                type="checkbox"
                bind:checked={preferences.soundEnabled}
                onchange={savePreferences}
              />
            </label>
            <label class="field">
              <span>화면</span>
              <select bind:value={preferences.theme} onchange={savePreferences}>
                <option value="system">시스템 설정</option>
                <option value="light">밝은 작업대</option>
                <option value="dark">어두운 작업대</option>
              </select>
            </label>
          </section>

          <section class="panel-section">
            <p class="eyebrow">저장과 동기화</p>
            <button
              class="path-button repository-path"
              onclick={() => void chooseRepository()}
            >
              <span title={repository?.path ?? ""}>
                {repository?.path ?? "원고 저장소 열기"}
              </span>
              <small>{repository?.available ? "변경" : "열기"}</small>
            </button>
            {#if repository?.active && !repository.available}
              <p class="danger-note">{repository.message}</p>
            {:else}
              <p class="panel-note">
                어떤 폴더든 저장소로 열 수 있습니다. 새 원고와 검색은 열린
                저장소의 루트에서 동작합니다.
              </p>
            {/if}
            {#if repository?.active}
              <button class="wide-button" onclick={() => void closeRepository()}>
                저장소 닫기
              </button>
            {/if}
            <div class="settings-fact">
              <strong>300ms 자동 저장</strong>
              <span>임시 파일 · fsync · 원자 교체</span>
            </div>
            {#if repositorySyncProvider}
              <div class="settings-fact">
                <strong>{repositorySyncProvider} 관리 폴더</strong>
                <span>
                  실제 동기화와 상태 확인은 {repositorySyncProvider} 앱이 담당합니다.
                </span>
              </div>
            {:else}
              <div class="settings-fact">
                <strong>Syncthing</strong>
                <span>{sync?.message ?? "로컬 설치를 자동 감지합니다."}</span>
              </div>
            {/if}
            {#if currentSyncProvider && sync?.folderId}
              <p class="danger-note">
                이 폴더는 다른 클라우드 동기화 도구와 Syncthing에 동시에 포함된
                것으로 보입니다. 같은 폴더에는 하나의 동기화 도구만 사용하세요.
              </p>
            {/if}
          </section>

          <section class="panel-section">
            <p class="eyebrow">Research Agent 연결</p>
            <button class="path-button" onclick={() => void chooseResearchWorkspace()}>
              <span>
                {researchWorkspace?.path
                  ? basename(researchWorkspace.path)
                  : "로컬 Research 작업 폴더"}
              </span>
              <small>{researchWorkspace?.available ? "변경" : "선택"}</small>
            </button>
            <p class="panel-note">
              같은 컴퓨터나 Syncthing에 복제된 작업 폴더가 있으면 서버의 출처
              API가 없어도 검증 카드와 출처 색인을 읽습니다.
            </p>
            <label class="field">
              <span>서버 주소</span>
              <input bind:value={researchEndpoint} placeholder="https://…" />
            </label>
            <label class="field">
              <span>Bearer 토큰</span>
              <input
                type="password"
                bind:value={researchToken}
                placeholder={researchConnection?.authenticated
                  ? "저장됨 · 변경할 때만 입력"
                  : "토큰 입력"}
              />
            </label>
            <button
              class="wide-button"
              disabled={!researchEndpoint || !researchToken}
              onclick={() => void configureResearch()}
            >
              보안 저장소에 연결 정보 보관
            </button>
            {#if researchConnection?.configured}
              <button class="wide-button" onclick={() => void disconnectResearch()}>
                서버 연결 해제
              </button>
            {/if}
            <p class="panel-note">
              토큰은 웹 화면이나 SQLite에 저장하지 않고 macOS Keychain,
              Windows Credential Manager, Linux Secret Service를 사용합니다.
            </p>
          </section>

          <section class="panel-section">
            <p class="eyebrow">AI 보안</p>
            <div class="settings-fact">
              <strong>{aiAccount?.message ?? "Codex 상태 확인 중"}</strong>
              <span
                >토큰은 Codex가 관리하며 앱은 읽지 않습니다. AI는 빈 임시
                폴더와 읽기 전용 샌드박스에서 선택한 문맥만 받습니다.</span
              >
            </div>
          </section>
        {/if}
      </div>
    </aside>
  {/if}
</main>

{#if suggestion}
  <div class="modal-backdrop" role="presentation">
    <section class="modal suggestion-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p class="eyebrow">AI 제안 · {suggestion.response.model}</p>
          <h2>원문은 그대로 두었습니다</h2>
        </div>
        <button class="close-button" onclick={() => (suggestion = null)}>×</button>
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
    </section>
  </div>
{/if}

{#if conflict}
  <div class="modal-backdrop" role="presentation">
    <section class="modal conflict-modal" role="alertdialog" aria-modal="true">
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
    </section>
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
    background: var(--paper);
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
    z-index: 20;
    display: grid;
    grid-template-columns: 1fr minmax(0, auto) 1fr;
    align-items: center;
    min-width: 0;
    height: 46px;
    padding: 0 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--rule) 68%, transparent);
    background: color-mix(in srgb, var(--paper) 93%, transparent);
    backdrop-filter: blur(12px);
    transition: opacity 160ms ease;
  }

  .topbar-side {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .topbar-right {
    justify-content: flex-end;
  }

  .icon-button,
  .text-button,
  .close-button,
  .link-button {
    border: 0;
    background: transparent;
    color: var(--ink-muted);
  }

  .icon-button {
    display: grid;
    place-items: center;
    width: 34px;
    height: 32px;
    border-radius: 7px;
    font-size: 17px;
  }

  .text-button {
    height: 32px;
    padding: 0 10px;
    border-radius: 7px;
    font-size: var(--type-control);
    font-weight: 720;
    letter-spacing: 0.08em;
  }

  .icon-button:hover,
  .text-button:hover,
  .icon-button.active,
  .text-button.active {
    color: var(--ink-strong);
    background: var(--paper-deep);
  }

  .document-name {
    display: flex;
    align-items: center;
    justify-content: center;
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

  .writing-stage {
    grid-area: stage;
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background:
      radial-gradient(
        ellipse at 50% 8%,
        color-mix(in srgb, white 20%, transparent),
        transparent 54%
      ),
      var(--paper);
  }

  .panel {
    z-index: 10;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--paper-deep);
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
  }

  .panel-tabs {
    display: flex;
    gap: 2px;
  }

  .panel-tabs button {
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 7px 9px;
    color: var(--ink-muted);
    font-size: var(--type-control);
  }

  .panel-tabs button.active {
    background: var(--paper-raised);
    color: var(--ink-strong);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 8%, transparent);
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
    min-height: 42px;
    border-radius: 6px;
  }

  .repository-row:hover,
  .repository-row.current {
    background: var(--paper);
  }

  .repository-row.current {
    box-shadow: inset 2px 0 var(--accent);
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

  .eyebrow {
    margin: 0 0 12px;
    color: var(--ink-faint);
    font-size: var(--type-caption);
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
    background: linear-gradient(transparent, var(--paper));
    color: var(--ink-faint);
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
    background-color: #fffdf7;
    background-image:
      linear-gradient(to right, rgba(174, 79, 69, 0.34) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(174, 79, 69, 0.34) 1px, transparent 1px);
    background-position: 15px 43px;
    background-size: 10px 10px;
    box-shadow: 0 14px 34px rgba(49, 39, 29, 0.15);
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
    border-radius: 7px;
    padding: 9px 17px;
    font-size: var(--type-control);
  }

  .primary-button {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff9f3;
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
    border-bottom: 1px solid var(--rule);
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
    background: var(--paper-raised);
    color: var(--ink-strong);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 8%, transparent);
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
    background: var(--paper-raised);
    padding: 9px;
    text-align: left;
  }

  .action-grid button:hover:not(:disabled) {
    border-color: var(--rule-strong);
    transform: translateY(-1px);
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
    width: 30px;
    height: 16px;
    accent-color: var(--accent);
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
    background: color-mix(in srgb, var(--ink-strong) 32%, transparent);
    backdrop-filter: blur(4px);
  }

  .modal {
    width: min(680px, 94vw);
    max-height: 88vh;
    overflow: auto;
    border: 1px solid var(--rule);
    border-radius: 13px;
    background: var(--paper-raised);
    padding: 22px;
    box-shadow: var(--shadow);
  }

  .modal > header {
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

  .rationale,
  .conflict-modal > p {
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

  .toast {
    position: fixed;
    z-index: 200;
    right: 18px;
    bottom: 18px;
    max-width: min(420px, calc(100vw - 36px));
    border: 1px solid var(--rule-strong);
    border-radius: 9px;
    background: var(--paper-raised);
    padding: 10px 14px;
    box-shadow: var(--shadow);
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

  @media (max-width: 900px) {
    .app-shell.panel-left.panel-right .right-panel {
      display: none;
    }
  }
</style>
