<script lang="ts">
  import { createEditHunkReview } from "./ai-chat";
  import { renderAiMarkdown } from "./ai-markdown";
  import type {
    AiAccountStatus,
    AiChatMessage,
    AiConversation,
    AiConversationSummary,
    AiEditHunk,
    AiLoginStart,
    EditorSelection,
  } from "./types";

  interface Props {
    account: AiAccountStatus | null;
    login: AiLoginStart | null;
    conversation: AiConversation | null;
    conversations: AiConversationSummary[];
    busy: boolean;
    expanded: boolean;
    readOnly: boolean;
    pendingSelection: EditorSelection | null;
    styleReferenceName: string;
    sourceCount: number;
    autoComplete: boolean;
    onclose: () => void;
    onexpandedchange: (expanded: boolean) => void;
    onnewconversation: () => void | Promise<void>;
    onselectconversation: (id: string) => void | Promise<void>;
    ondeleteconversation: (id: string) => void | Promise<void>;
    onnewselection: () => void | Promise<void>;
    oncleartarget: () => void | Promise<void>;
    onopenlink: (url: string) => void | Promise<void>;
    onsend: (prompt: string) => Promise<boolean>;
    onapplyhunk: (messageId: string, hunkId: string) => void | Promise<void>;
    onrejecthunk: (messageId: string, hunkId: string) => void | Promise<void>;
    onapplyall: (messageId: string) => void | Promise<void>;
    onrejectall: (messageId: string) => void | Promise<void>;
    onlogin: (deviceCode: boolean) => void | Promise<void>;
    onrefreshlogin: () => void | Promise<void>;
    onchoosestyle: () => void | Promise<void>;
    onautocompletechange: (enabled: boolean) => void;
  }

  let {
    account,
    login,
    conversation,
    conversations,
    busy,
    expanded,
    readOnly,
    pendingSelection,
    styleReferenceName,
    sourceCount,
    autoComplete,
    onclose,
    onexpandedchange,
    onnewconversation,
    onselectconversation,
    ondeleteconversation,
    onnewselection,
    oncleartarget,
    onopenlink,
    onsend,
    onapplyhunk,
    onrejecthunk,
    onapplyall,
    onrejectall,
    onlogin,
    onrefreshlogin,
    onchoosestyle,
    onautocompletechange,
  }: Props = $props();

  let prompt = $state("");
  let historyOpen = $state(false);
  let menuOpen = $state(false);
  let currentTask = $state<HTMLElement>();
  let historyTranscript = $state<HTMLElement>();
  let dockPromptInput = $state<HTMLTextAreaElement>();
  let floatingPromptInput = $state<HTMLTextAreaElement>();
  let conversationTrackingReady = false;
  let lastConversationId = "";
  let lastMessageCount = 0;

  let activeTurn = $derived.by(() => {
    const messages = conversation?.messages ?? [];
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        userIndex = index;
        break;
      }
    }
    const user = userIndex >= 0 ? messages[userIndex] : null;
    const assistant =
      userIndex >= 0
        ? (messages.slice(userIndex + 1).find((message) => message.role === "assistant") ?? null)
        : (messages.findLast((message) => message.role === "assistant") ?? null);
    return { user, assistant };
  });

  let hasBodyContent = $derived(
    !account?.authenticated ||
      historyOpen ||
      Boolean(activeTurn.user) ||
      Boolean(activeTurn.assistant) ||
      busy,
  );

  $effect(() => {
    const id = conversation?.id ?? "";
    const count = conversation?.messages.length ?? 0;
    if (id === lastConversationId && count === lastMessageCount) return;
    lastConversationId = id;
    lastMessageCount = count;
    if (!conversationTrackingReady) {
      conversationTrackingReady = true;
      return;
    }
    if (count > 0) onexpandedchange(true);
    requestAnimationFrame(() => {
      currentTask?.scrollTo({ top: 0, behavior: "smooth" });
      if (historyOpen) {
        historyTranscript?.scrollTo({
          top: historyTranscript.scrollHeight,
          behavior: "smooth",
        });
      }
    });
  });

  $effect(() => {
    if (busy && !expanded) onexpandedchange(true);
  });

  $effect(() => {
    if (expanded) return;
    historyOpen = false;
    menuOpen = false;
  });

  function targetLabel(): string {
    return conversation?.targetKind === "selection" ? "선택 영역" : "전체 원고";
  }

  function targetTitle(): string {
    if (!conversation || conversation.targetKind === "document") {
      return "현재 원고 전체를 대상으로 합니다.";
    }
    const compact = conversation.targetText.replace(/\s+/g, " ").trim();
    const preview = compact.length > 100 ? `${compact.slice(0, 100)}…` : compact;
    return `${conversation.targetText.length.toLocaleString("ko-KR")}자 · ${preview}`;
  }

  function pendingHunks(message: AiChatMessage): AiEditHunk[] {
    return message.metadata.proposal?.hunks.filter((hunk) => hunk.status === "pending") ?? [];
  }

  function staleHunks(message: AiChatMessage): AiEditHunk[] {
    return message.metadata.proposal?.hunks.filter((hunk) => hunk.status === "stale") ?? [];
  }

  function proposalSummary(message: AiChatMessage): string {
    const hunks = message.metadata.proposal?.hunks ?? [];
    if (!hunks.length) return "";
    const applied = hunks.filter((hunk) => hunk.status === "applied").length;
    const rejected = hunks.filter((hunk) => hunk.status === "rejected").length;
    const stale = hunks.filter((hunk) => hunk.status === "stale").length;
    const states = [
      applied ? `적용 ${applied}` : "",
      rejected ? `제외 ${rejected}` : "",
      stale ? `적용 불가 ${stale}` : "",
    ].filter(Boolean);
    return states.length ? states.join(" · ") : `수정안 ${hunks.length}건`;
  }

  function focusPrompt(): void {
    requestAnimationFrame(() => {
      const target =
        typeof window !== "undefined" && window.innerWidth <= 1280
          ? floatingPromptInput
          : dockPromptInput;
      target?.focus();
      target?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  async function submitPrompt(): Promise<void> {
    const value = prompt.trim();
    if (!value || busy) return;
    historyOpen = false;
    menuOpen = false;
    onexpandedchange(true);
    if (await onsend(value)) prompt = "";
    focusPrompt();
  }

  function handlePromptKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submitPrompt();
  }

  function toggleMenu(): void {
    menuOpen = !menuOpen;
    if (menuOpen) onexpandedchange(true);
  }

  function showHistory(): void {
    menuOpen = false;
    historyOpen = true;
    onexpandedchange(true);
    requestAnimationFrame(() => {
      historyTranscript?.scrollTo({ top: historyTranscript.scrollHeight });
    });
  }

  function closeHistory(): void {
    historyOpen = false;
    focusPrompt();
  }

  async function startNewConversation(): Promise<void> {
    menuOpen = false;
    historyOpen = false;
    onexpandedchange(false);
    await onnewconversation();
    focusPrompt();
  }

  async function selectConversation(id: string): Promise<void> {
    await onselectconversation(id);
    requestAnimationFrame(() => {
      historyTranscript?.scrollTo({ top: historyTranscript.scrollHeight });
    });
  }

  async function usePendingSelection(): Promise<void> {
    menuOpen = false;
    historyOpen = false;
    onexpandedchange(false);
    await onnewselection();
    focusPrompt();
  }

  function connect(deviceCode: boolean): void {
    menuOpen = false;
    onexpandedchange(true);
    void onlogin(deviceCode);
  }

  function handleMarkdownClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    event.preventDefault();
    void onopenlink(link.href);
  }

  function markdownLinks(node: HTMLElement): { destroy: () => void } {
    node.addEventListener("click", handleMarkdownClick);
    return {
      destroy: () => node.removeEventListener("click", handleMarkdownClick),
    };
  }
</script>

<section class:expanded class="ai-chat" aria-label="AI 채팅">
  <header class="ai-chat-header desktop-only">
    <div class="ai-heading-copy">
      <span class="ai-mark" aria-hidden="true">✦</span>
      <strong>AI</strong>
      {#if pendingSelection}
        <button class="new-selection-button" type="button" onclick={() => void usePendingSelection()}>
          새 선택 사용
        </button>
      {:else}
        <span class="target-chip" title={targetTitle()}>
          {targetLabel()}
          {#if conversation?.targetKind === "selection"}
            <button type="button" aria-label="선택 영역 AI 문맥 해제" title="전체 원고로 전환" onclick={() => void oncleartarget()}>×</button>
          {/if}
        </span>
      {/if}
    </div>
    <div class="ai-header-actions">
      <button type="button" title="대화 기록" aria-label="AI 대화 기록" onclick={showHistory}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"></path></svg>
      </button>
      <button type="button" title="새 대화" aria-label="새 AI 대화" onclick={() => void startNewConversation()}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>
      </button>
      <button class:active={menuOpen} type="button" title="AI 설정" aria-label="AI 설정" aria-expanded={menuOpen} onclick={toggleMenu}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>
      </button>
      <button type="button" title="AI 닫기" aria-label="AI 채팅 닫기" onclick={onclose}>×</button>
    </div>
  </header>

  <form
    class="floating-composer"
    onsubmit={(event) => {
      event.preventDefault();
      void submitPrompt();
    }}
  >
    <span class="compact-mark" aria-hidden="true">✦</span>
    {#if pendingSelection}
      <button class="new-selection-button" type="button" onclick={() => void usePendingSelection()}>
        새 선택 사용
      </button>
    {:else}
      <span class="target-chip" title={targetTitle()}>
        {targetLabel()}
        {#if conversation?.targetKind === "selection"}
          <button type="button" aria-label="선택 영역 AI 문맥 해제" title="전체 원고로 전환" onclick={() => void oncleartarget()}>×</button>
        {/if}
      </span>
    {/if}
    {#if account?.authenticated}
      <textarea
        bind:this={floatingPromptInput}
        bind:value={prompt}
        rows="1"
        disabled={busy || !conversation}
        placeholder="AI에게 요청"
        aria-label="AI에게 보낼 메시지"
        onkeydown={handlePromptKeydown}
      ></textarea>
      <button class="send-button" type="submit" disabled={busy || !prompt.trim() || !conversation} aria-label="AI 메시지 보내기">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 14-7-4 14-3-5-7-2Z"></path><path d="m12 14 7-9"></path></svg>
      </button>
    {:else}
      <span class="connection-needed">AI 연결 필요</span>
      <button class="connect-button" type="button" onclick={() => connect(false)}>연결</button>
    {/if}
    <button class:active={menuOpen} class="compact-icon-button" type="button" title="AI 메뉴" aria-label="AI 메뉴" aria-expanded={menuOpen} onclick={toggleMenu}>•••</button>
    <button class="compact-icon-button close" type="button" title="AI 닫기" aria-label="AI 채팅 닫기" onclick={onclose}>×</button>
  </form>

  {#if menuOpen}
    <div class="action-menu" role="menu">
      <button class="floating-menu-item" type="button" role="menuitem" onclick={showHistory}>대화 기록</button>
      <button class="floating-menu-item" type="button" role="menuitem" onclick={() => void startNewConversation()}>새 대화</button>
      <button type="button" role="menuitem" onclick={() => { menuOpen = false; void onchoosestyle(); }}>
        <span>문체 참고</span><strong>{styleReferenceName || "선택"}</strong>
      </button>
      {#if sourceCount > 0}
        <div class="menu-status"><span>연결 출처</span><strong>{sourceCount}개</strong></div>
      {/if}
      <label class="menu-switch">
        <span>자동 이어쓰기</span>
        <input type="checkbox" checked={autoComplete} onchange={(event) => onautocompletechange(event.currentTarget.checked)} />
      </label>
      {#if !account?.authenticated}
        <button type="button" role="menuitem" onclick={() => connect(true)}>기기 코드로 연결</button>
      {/if}
    </div>
  {/if}

  <div class:has-content={hasBodyContent} class="ai-body">
    {#if !account?.authenticated}
      <div class="login-strip">
        <strong>AI 연결 필요</strong>
        <button type="button" onclick={() => connect(false)}>연결</button>
        {#if login?.userCode}
          <code>{login.userCode}</code>
          <button type="button" onclick={() => void onrefreshlogin()}>확인</button>
        {/if}
      </div>
    {/if}

    {#if historyOpen}
      <section class="history-view" aria-label="AI 대화 기록">
        <header>
          <button class="back-button" type="button" onclick={closeHistory}>←</button>
          <strong>대화 기록</strong>
          <button type="button" onclick={() => void startNewConversation()}>새 대화</button>
        </header>
        <div class="conversation-list">
          {#each conversations as item (item.id)}
            <div class:current={conversation?.id === item.id} class="conversation-row">
              <button class="conversation-open" type="button" onclick={() => void selectConversation(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.targetKind === "selection" ? "선택 영역" : "전체 원고"}</span>
              </button>
              <button class="conversation-delete" type="button" title="대화 삭제" aria-label={`${item.title} 대화 삭제`} onclick={() => void ondeleteconversation(item.id)}>×</button>
            </div>
          {/each}
        </div>
        <div class="history-transcript" bind:this={historyTranscript}>
          {#if conversation?.messages.length}
            {#each conversation.messages as message (message.id)}
              <article class:user={message.role === "user"} class="history-message">
                <strong>{message.role === "user" ? "나" : "AI"}</strong>
                {#if message.role === "assistant"}
                  <div class="message-markdown" use:markdownLinks>
                    {@html renderAiMarkdown(message.content)}
                  </div>
                {:else}
                  <p>{message.content}</p>
                {/if}
                {#if message.metadata.proposal}
                  <small>{proposalSummary(message)}</small>
                {/if}
                {#if message.metadata.failed}<small class="error-text">응답 실패</small>{/if}
              </article>
            {/each}
          {:else}
            <p class="empty-history">저장된 메시지가 없습니다.</p>
          {/if}
        </div>
      </section>
    {:else}
      <section class="current-task" bind:this={currentTask} aria-label="현재 AI 작업">
        {#if activeTurn.user}
          <p class="current-request">{activeTurn.user.content}</p>
        {/if}

        {#if activeTurn.assistant}
          {@const message = activeTurn.assistant}
          <article class="current-response">
            <div class="message-markdown" use:markdownLinks>
              {@html renderAiMarkdown(message.content)}
            </div>
            {#if message.metadata.citations?.length}
              <div class="message-chips">
                {#each message.metadata.citations as citation}<span>출처 {citation}</span>{/each}
              </div>
            {/if}
            {#if message.metadata.warnings?.length}
              <div class="message-warnings">
                {#each message.metadata.warnings as warning}<p>{warning}</p>{/each}
              </div>
            {/if}
            {#if message.metadata.proposal}
              {@const proposal = message.metadata.proposal}
              {@const waiting = pendingHunks(message)}
              {@const stale = staleHunks(message)}
              <section class="proposal-card">
                {#if waiting.length}
                  <header>
                    <strong>수정안 {waiting.length}건</strong>
                    <div>
                      <button type="button" onclick={() => void onrejectall(message.id)}>모두 제외</button>
                      <button class="apply" type="button" disabled={readOnly} onclick={() => void onapplyall(message.id)}>전체 적용</button>
                    </div>
                  </header>
                  <div class="hunk-list">
                    {#each waiting as hunk (hunk.id)}
                      {@const review = createEditHunkReview(proposal, hunk)}
                      <div class="edit-hunk">
                        <div class="hunk-labels">
                          {#each review.labels as label}<span>{label}</span>{/each}
                        </div>
                        <div class="hunk-diff">
                          {#if review.before}
                            <div class="diff-row before" aria-label="변경 전 Markdown">
                              <span class="diff-sign" aria-hidden="true">−</span>
                              <code>{#each review.beforeSegments as segment}<span class:changed={segment.changed}>{segment.text}</span>{/each}</code>
                            </div>
                          {/if}
                          {#if review.after}
                            <div class="diff-row after" aria-label="변경 후 Markdown">
                              <span class="diff-sign" aria-hidden="true">+</span>
                              <code>{#each review.afterSegments as segment}<span class:changed={segment.changed}>{segment.text}</span>{/each}</code>
                            </div>
                          {/if}
                        </div>
                        <div class="hunk-actions">
                          <button type="button" onclick={() => void onrejecthunk(message.id, hunk.id)}>제외</button>
                          <button class="apply" type="button" disabled={readOnly} onclick={() => void onapplyhunk(message.id, hunk.id)}>적용</button>
                        </div>
                      </div>
                    {/each}
                  </div>
                  {#if readOnly}<p class="state-note error-text">읽기 전용 원고에서는 적용할 수 없습니다.</p>{/if}
                  {#if stale.length}<p class="state-note error-text">일부 원문이 바뀌어 적용할 수 없습니다.</p>{/if}
                {:else if stale.length}
                  <p class="proposal-state error-text">원문이 바뀌어 적용할 수 없습니다.</p>
                {:else}
                  <p class="proposal-state">변경 검토 완료</p>
                {/if}
              </section>
            {/if}
          </article>
        {/if}

        {#if activeTurn.user?.metadata.failed}
          <p class="failed-note">응답을 받지 못했습니다. 다시 요청해주세요.</p>
        {/if}
        {#if busy}
          <div class="working-message"><span></span>답변 작성 중…</div>
        {/if}
      </section>
    {/if}
  </div>

  <form
    class="dock-composer desktop-only"
    onsubmit={(event) => {
      event.preventDefault();
      void submitPrompt();
    }}
  >
    <textarea
      bind:this={dockPromptInput}
      bind:value={prompt}
      rows="2"
      disabled={busy || !conversation || !account?.authenticated}
      placeholder={conversation?.targetKind === "selection" ? "선택한 부분을 어떻게 바꿀까요?" : "AI에게 요청"}
      aria-label="AI에게 보낼 메시지"
      onkeydown={handlePromptKeydown}
    ></textarea>
    <button class="send-button" type="submit" disabled={busy || !prompt.trim() || !conversation || !account?.authenticated} aria-label="AI 메시지 보내기">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 14-7-4 14-3-5-7-2Z"></path><path d="m12 14 7-9"></path></svg>
    </button>
  </form>
</section>

<style>
  .ai-chat {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--panel);
    color: var(--ink);
  }

  button,
  textarea,
  input { font: inherit; }

  .ai-chat-header {
    display: flex;
    min-height: 54px;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--rule);
    padding: 0 10px 0 14px;
    background: color-mix(in srgb, var(--chrome) 52%, transparent);
  }

  .ai-heading-copy,
  .ai-header-actions,
  .proposal-card > header,
  .hunk-actions,
  .login-strip,
  .history-view > header,
  .conversation-row,
  .menu-switch,
  .menu-status {
    display: flex;
    align-items: center;
  }

  .ai-heading-copy { min-width: 0; gap: 8px; }
  .ai-heading-copy > strong { font-size: 14px; }

  .ai-mark,
  .compact-mark {
    display: grid;
    place-items: center;
    color: var(--accent);
  }

  .ai-mark {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    font-size: 16px;
  }

  .target-chip,
  .new-selection-button {
    flex: 0 0 auto;
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--paper-deep);
    padding: 5px 8px;
    color: var(--ink-muted);
    font-size: 12px;
    line-height: 1;
  }

  .target-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .target-chip button {
    display: grid;
    width: 16px;
    height: 16px;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ink-faint) 12%, transparent);
    padding: 0;
    color: var(--ink-faint);
    font-size: 13px;
    line-height: 1;
  }

  .target-chip button:hover {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }

  button.new-selection-button {
    border-color: color-mix(in srgb, var(--accent) 46%, var(--rule));
    background: color-mix(in srgb, var(--accent) 9%, var(--paper));
    color: var(--accent);
  }

  .ai-header-actions { gap: 2px; }
  .ai-header-actions button,
  .compact-icon-button {
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ink-muted);
    font-size: 20px;
  }
  .ai-header-actions button:hover,
  .ai-header-actions button.active,
  .compact-icon-button:hover,
  .compact-icon-button.active { background: var(--paper-deep); color: var(--ink-strong); }
  .ai-header-actions svg { width: 17px; fill: currentColor; stroke: currentColor; stroke-linecap: round; stroke-width: 1.6; }

  .floating-composer { display: none; }

  .action-menu {
    position: absolute;
    z-index: 8;
    top: 48px;
    right: 9px;
    display: grid;
    width: 220px;
    overflow: hidden;
    border: 1px solid var(--rule-strong);
    border-radius: 10px;
    background: var(--surface-raised);
    padding: 5px;
    box-shadow: var(--shadow-float);
  }

  .action-menu > button,
  .menu-switch,
  .menu-status {
    display: flex;
    min-height: 36px;
    align-items: center;
    justify-content: space-between;
    border: 0;
    border-radius: 7px;
    background: transparent;
    padding: 7px 9px;
    color: var(--ink-muted);
    font-size: 13px;
    text-align: left;
  }
  .action-menu > button:hover { background: var(--paper-deep); color: var(--ink-strong); }
  .action-menu strong { overflow: hidden; max-width: 118px; color: var(--ink); text-overflow: ellipsis; white-space: nowrap; }
  .menu-status { border-top: 1px solid var(--rule); border-radius: 0; }
  .floating-menu-item { display: none; }

  .ai-body {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }

  .login-strip {
    flex-wrap: wrap;
    gap: 7px;
    border-bottom: 1px solid var(--rule);
    background: color-mix(in srgb, var(--accent) 6%, var(--surface-raised));
    padding: 9px 12px;
    font-size: 12px;
  }
  .login-strip strong { margin-right: auto; }
  .login-strip button {
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--rule));
    border-radius: 7px;
    background: var(--control-bg);
    padding: 6px 9px;
    color: var(--accent);
    font-size: 12px;
  }
  .login-strip code { font-size: 15px; letter-spacing: .1em; }

  .current-task {
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 16px 14px 28px;
    scrollbar-width: thin;
  }

  .current-request {
    width: fit-content;
    max-width: 92%;
    margin: 0 0 14px auto;
    border-radius: 12px 12px 3px 12px;
    background: var(--paper-deep);
    padding: 9px 11px;
    color: var(--ink);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
  }

  .message-markdown {
    overflow-wrap: anywhere;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.68;
  }

  .history-message .message-markdown { font-size: 13px; line-height: 1.62; }
  .message-markdown > :global(:first-child) { margin-top: 0; }
  .message-markdown > :global(:last-child) { margin-bottom: 0; }
  .message-markdown :global(p) { margin: 0 0 .72em; }
  .message-markdown :global(h1),
  .message-markdown :global(h2),
  .message-markdown :global(h3),
  .message-markdown :global(h4) {
    margin: 1em 0 .45em;
    color: var(--ink-strong);
    font-weight: 700;
    line-height: 1.35;
  }
  .message-markdown :global(h1) { font-size: 1.3em; }
  .message-markdown :global(h2) { font-size: 1.18em; }
  .message-markdown :global(h3),
  .message-markdown :global(h4) { font-size: 1.06em; }
  .message-markdown :global(ul),
  .message-markdown :global(ol) { margin: .45em 0 .8em; padding-left: 1.5em; }
  .message-markdown :global(li + li) { margin-top: .24em; }
  .message-markdown :global(blockquote) {
    margin: .65em 0;
    border-left: 3px solid color-mix(in srgb, var(--accent) 48%, var(--rule));
    padding: .12em 0 .12em .8em;
    color: var(--ink-muted);
  }
  .message-markdown :global(code) {
    border-radius: 4px;
    background: var(--paper-deep);
    padding: .12em .32em;
    font-family: "Goorm Sans Code", NanumGothicCoding, monospace;
    font-size: .9em;
  }
  .message-markdown :global(pre) {
    overflow: auto;
    margin: .7em 0;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper-deep);
    padding: .75em .85em;
    line-height: 1.55;
  }
  .message-markdown :global(pre code) { background: transparent; padding: 0; }
  .message-markdown :global(table) {
    width: 100%;
    margin: .7em 0;
    border-collapse: collapse;
    font-size: .94em;
  }
  .message-markdown :global(th),
  .message-markdown :global(td) { border: 1px solid var(--rule); padding: .4em .5em; text-align: left; }
  .message-markdown :global(th) { background: var(--paper-deep); color: var(--ink-strong); }
  .message-markdown :global(a) { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
  .message-markdown :global(hr) { margin: .9em 0; border: 0; border-top: 1px solid var(--rule); }
  .message-markdown :global(.katex-display) { overflow-x: auto; overflow-y: hidden; }

  .message-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
  .message-chips span { border-radius: 999px; background: var(--paper-deep); padding: 4px 7px; color: var(--ink-muted); font-size: 12px; }
  .message-warnings { margin-top: 10px; border-left: 2px solid var(--warning); padding-left: 9px; }
  .message-warnings p { margin: 4px 0; color: var(--ink-muted); font-size: 12px; line-height: 1.55; }

  .proposal-card {
    margin-top: 14px;
    overflow: hidden;
    border: 1px solid var(--rule);
    border-radius: 11px;
    background: var(--surface-raised);
  }
  .proposal-card > header { justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--rule); padding: 9px 10px; }
  .proposal-card > header strong { font-size: 13px; }
  .proposal-card > header > div { display: flex; gap: 5px; }
  .proposal-card button,
  .history-view button {
    border: 1px solid var(--control-border);
    border-radius: 7px;
    background: var(--control-bg);
    padding: 6px 9px;
    color: var(--control-fg);
    font-size: 12px;
  }
  .proposal-card button.apply { border-color: color-mix(in srgb, var(--accent) 60%, var(--rule)); background: var(--accent); color: var(--control-on-accent); }
  .proposal-card button:disabled { opacity: .45; }
  .hunk-list { display: grid; gap: 1px; background: var(--rule); }
  .edit-hunk { background: var(--paper); padding: 11px; }
  .hunk-labels { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .hunk-labels span { border: 1px solid var(--rule); border-radius: 999px; background: var(--paper-deep); padding: 3px 7px; color: var(--ink-muted); font-size: 12px; font-weight: 650; }
  .hunk-diff { display: grid; max-height: 300px; gap: 5px; overflow: auto; font-size: 14px; line-height: 1.62; }
  .diff-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; border-radius: 6px; padding: 6px 7px 6px 3px; }
  .diff-row.before { background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); }
  .diff-row.after { background: color-mix(in srgb, var(--success) 9%, transparent); color: var(--success); }
  .diff-sign { text-align: center; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 750; user-select: none; }
  .diff-row code { overflow-wrap: anywhere; color: inherit; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: inherit; white-space: pre-wrap; }
  .diff-row code .changed { border-radius: 2px; background: color-mix(in srgb, currentColor 16%, transparent); font-weight: 700; }
  .hunk-actions { justify-content: flex-end; gap: 5px; margin-top: 9px; }
  .proposal-state,
  .state-note { margin: 0; padding: 12px; color: var(--ink-muted); font-size: 13px; }

  .failed-note,
  .error-text { color: var(--danger) !important; }
  .failed-note { margin: 12px 0; font-size: 13px; }

  .working-message { display: flex; align-items: center; gap: 8px; margin-top: 14px; color: var(--ink-muted); font-size: 13px; }
  .working-message span { width: 10px; height: 10px; border: 1.5px solid var(--rule-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }

  .history-view {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template-rows: auto auto minmax(0, 1fr);
    overflow: hidden;
  }
  .history-view > header { gap: 8px; border-bottom: 1px solid var(--rule); padding: 8px 10px; }
  .history-view > header strong { flex: 1; font-size: 14px; }
  .back-button { width: 32px; padding: 6px !important; }
  .conversation-list { display: flex; gap: 5px; overflow-x: auto; border-bottom: 1px solid var(--rule); padding: 8px 10px; scrollbar-width: thin; }
  .conversation-row { min-width: 170px; max-width: 230px; border: 1px solid transparent; border-radius: 9px; }
  .conversation-row.current { border-color: color-mix(in srgb, var(--accent) 45%, var(--rule)); background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .conversation-open { display: grid; min-width: 0; flex: 1; gap: 3px; border: 0 !important; background: transparent !important; text-align: left; }
  .conversation-open strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .conversation-open span { color: var(--ink-faint); font-size: 12px; }
  .conversation-delete { width: 30px; border: 0 !important; background: transparent !important; color: var(--ink-faint) !important; }
  .history-transcript { min-height: 0; overflow: auto; padding: 14px; scrollbar-width: thin; }
  .history-message { margin-bottom: 15px; }
  .history-message > strong { display: block; margin-bottom: 4px; color: var(--accent); font-size: 12px; }
  .history-message.user > strong { color: var(--ink-muted); }
  .history-message p { margin: 0; color: var(--ink); font-size: 13px; line-height: 1.62; white-space: pre-wrap; }
  .history-message small { display: block; margin-top: 5px; color: var(--ink-faint); font-size: 12px; }
  .empty-history { margin: 0; color: var(--ink-faint); font-size: 13px; }

  .dock-composer {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 38px;
    gap: 7px;
    border-top: 1px solid var(--rule);
    background: var(--surface-raised);
    padding: 10px;
  }
  .dock-composer textarea,
  .floating-composer textarea {
    resize: none;
    border: 1px solid var(--control-border);
    background: var(--control-bg);
    color: var(--control-fg);
    font-size: 14px;
    line-height: 1.45;
  }
  .dock-composer textarea { min-height: 58px; max-height: 132px; border-radius: 11px; padding: 10px 11px; }
  .send-button {
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 9px;
    background: var(--accent);
    color: var(--control-on-accent);
  }
  .dock-composer .send-button { align-self: end; width: 38px; height: 38px; }
  .send-button:disabled { opacity: .4; }
  .send-button svg { width: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }

  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 1280px) {
    .ai-chat {
      height: auto;
      max-height: min(60vh, 560px);
      background: var(--surface-raised);
    }
    .desktop-only { display: none; }
    .floating-composer {
      display: flex;
      min-height: 52px;
      align-items: center;
      gap: 7px;
      padding: 7px 8px 7px 11px;
      background: var(--surface-raised);
    }
    .compact-mark { flex: 0 0 auto; font-size: 17px; }
    .floating-composer textarea {
      min-width: 80px;
      height: 36px;
      flex: 1;
      border-radius: 9px;
      padding: 7px 10px;
      overflow: hidden;
    }
    .floating-composer .send-button { width: 34px; height: 34px; flex: 0 0 auto; }
    .compact-icon-button { width: 32px; height: 34px; flex: 0 0 auto; font-size: 15px; letter-spacing: -.08em; }
    .compact-icon-button.close { font-size: 20px; letter-spacing: normal; }
    .connection-needed { min-width: 0; flex: 1; color: var(--ink-muted); font-size: 13px; }
    .connect-button {
      flex: 0 0 auto;
      border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--rule));
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      padding: 7px 10px;
      color: var(--accent);
      font-size: 12px;
    }
    .ai-body { display: none; border-top: 1px solid var(--rule); }
    .ai-chat.expanded .ai-body.has-content {
      display: flex;
      max-height: calc(min(60vh, 560px) - 52px);
      flex: 0 1 auto;
    }
    .current-task { flex: 0 1 auto; max-height: calc(min(60vh, 560px) - 52px); padding: 14px 16px 20px; }
    .history-view { max-height: calc(min(60vh, 560px) - 52px); }
    .action-menu {
      position: relative;
      z-index: 1;
      top: auto;
      right: auto;
      width: auto;
      flex: 0 0 auto;
      margin: 0 8px 8px;
      box-shadow: 0 10px 28px color-mix(in srgb, var(--ink-strong) 12%, transparent);
    }
    .floating-menu-item { display: flex; }
  }

  @media (max-width: 680px) {
    .floating-composer { gap: 5px; padding-left: 8px; }
    .target-chip,
    .new-selection-button { max-width: 112px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .compact-icon-button { width: 29px; }
  }
</style>
