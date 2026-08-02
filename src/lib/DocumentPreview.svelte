<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import "katex/dist/katex.min.css";
  import { parseManuscript } from "./manuscript-document";
  import { renderManuscriptHtml } from "./render-manuscript";

  interface AssetData {
    relativePath: string;
    mimeType: string;
    dataUrl: string;
    sizeBytes: number;
  }

  interface Props {
    content: string;
    documentPath: string;
    fallbackTitle?: string;
    fontFamily?: string;
    desktop?: boolean;
    onlink?: (url: string) => void;
  }

  let {
    content,
    documentPath,
    fallbackTitle = "제목 없는 원고",
    fontFamily = "Pretendard",
    desktop = false,
    onlink,
  }: Props = $props();

  let assetUrls = $state<Record<string, string>>({});
  let assetLoadId = 0;
  let manuscript = $derived(
    parseManuscript(content, fallbackTitle, { diagnostics: false }),
  );
  let rendered = $derived(
    renderManuscriptHtml(manuscript.previewMarkdown, assetUrls),
  );

  async function loadAssets(
    paths: string[],
    path: string,
    requestId: number,
  ): Promise<void> {
    if (!desktop || !path || !paths.length) {
      if (requestId === assetLoadId) assetUrls = {};
      return;
    }
    const entries = await Promise.all(
      paths.map(async (relativePath) => {
        try {
          const asset = await invoke<AssetData>("read_manuscript_asset", {
            documentPath: path,
            relativePath,
          });
          return [relativePath, asset.dataUrl] as const;
        } catch {
          return null;
        }
      }),
    );
    if (requestId !== assetLoadId) return;
    assetUrls = Object.fromEntries(
      entries.filter(
        (entry): entry is readonly [string, string] => entry !== null,
      ),
    );
  }

  function handleClick(event: MouseEvent): void {
    const anchor =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (!anchor) return;
    const url = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(url)) return;
    event.preventDefault();
    onlink?.(url);
  }

  function interceptLinks(node: HTMLElement): { destroy: () => void } {
    node.addEventListener("click", handleClick);
    return {
      destroy: () => node.removeEventListener("click", handleClick),
    };
  }

  $effect(() => {
    const paths = manuscript.imagePaths;
    const path = documentPath;
    const requestId = ++assetLoadId;
    void loadAssets(paths, path, requestId);
  });
</script>

<div class="preview-scroll">
  <article
    class="preview-paper"
    style={`--preview-font: "${fontFamily.replaceAll('"', '\\"')}", Pretendard, sans-serif`}
    use:interceptLinks
  >
    <header class="document-header">
      {#if manuscript.metadata.genre}
        <p class="genre">{manuscript.metadata.genre}</p>
      {/if}
      <h1>{manuscript.metadata.title}</h1>
      {#if manuscript.metadata.subtitle}
        <p class="subtitle">{manuscript.metadata.subtitle}</p>
      {/if}
      {#if manuscript.metadata.author || manuscript.metadata.affiliation}
        <p class="byline">
          {#if manuscript.metadata.affiliation}
            <span>{manuscript.metadata.affiliation}</span>
          {/if}
          {#if manuscript.metadata.author}
            <strong>{manuscript.metadata.author}</strong>
          {/if}
        </p>
      {/if}
    </header>
    <div class="rendered-markdown">
      {@html rendered}
    </div>
  </article>
</div>

<style>
  .preview-scroll {
    height: 100%;
    overflow: auto;
    background-color: var(--desk);
    background-image:
      var(--hanji-texture),
      radial-gradient(circle at 50% 0, rgba(255, 255, 255, 0.16), transparent 48%);
    background-blend-mode: soft-light, normal;
    background-size: 320px 320px, auto;
    padding: 64px 42px 120px;
  }

  .preview-paper {
    box-sizing: border-box;
    width: min(210mm, 100%);
    min-height: 297mm;
    margin: 0 auto;
    border: 1px solid color-mix(in srgb, var(--sheet-edge) 70%, transparent);
    background-color: var(--sheet);
    background-image: var(--hanji-texture);
    background-size: 320px 320px;
    padding: 25mm 23mm 27mm;
    box-shadow: var(--shadow-paper);
    color: #24201d;
    font-family: var(--preview-font);
    font-size: 11pt;
    line-height: 1.85;
  }

  .document-header {
    margin: 8mm 0 16mm;
    text-align: center;
  }

  .genre {
    margin: 0 0 8mm;
    color: #756b64;
    font-size: 9pt;
    letter-spacing: 0.08em;
  }

  h1 {
    margin: 0;
    font-family: MaruBuri, Georgia, serif;
    font-size: 24pt;
    font-weight: 650;
    line-height: 1.35;
    letter-spacing: -0.035em;
  }

  .subtitle {
    margin: 4mm 0 0;
    color: #665d57;
    font-family: MaruBuri, Georgia, serif;
    font-size: 13pt;
  }

  .byline {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin: 8mm 0 0;
    color: #635b56;
    font-size: 9.5pt;
  }

  .byline strong {
    color: #322d29;
  }

  :global(.rendered-markdown h1) {
    font-size: 20pt;
  }

  :global(.rendered-markdown h2) {
    margin: 2.3em 0 0.75em;
    font-family: MaruBuri, Georgia, serif;
    font-size: 16pt;
    line-height: 1.45;
  }

  :global(.rendered-markdown h3) {
    margin: 1.9em 0 0.65em;
    font-size: 12.5pt;
  }

  :global(.rendered-markdown p) {
    margin: 0 0 1.05em;
    text-align: justify;
    text-indent: 1em;
    word-break: keep-all;
    overflow-wrap: anywhere;
  }

  :global(.rendered-markdown blockquote) {
    margin: 1.4em 0;
    border-left: 3px solid #b99e91;
    padding: 0.2em 0 0.2em 1.2em;
    color: #5d5550;
  }

  :global(.rendered-markdown blockquote p),
  :global(.rendered-markdown li p),
  :global(.rendered-markdown td p) {
    text-indent: 0;
  }

  :global(.rendered-markdown table) {
    width: 100%;
    margin: 1.6em 0;
    border-collapse: collapse;
    break-inside: avoid;
    font-size: 9.5pt;
  }

  :global(.rendered-markdown th),
  :global(.rendered-markdown td) {
    border: 1px solid #bdb5af;
    padding: 0.55em 0.7em;
    text-align: left;
    vertical-align: top;
  }

  :global(.rendered-markdown th) {
    background: #f3f0ed;
    font-weight: 700;
  }

  :global(.rendered-markdown img) {
    display: block;
    max-width: 100%;
    max-height: 180mm;
    margin: 1.7em auto 0.7em;
    object-fit: contain;
    break-inside: avoid;
  }

  :global(.rendered-markdown img.missing-image),
  :global(.rendered-markdown img.remote-image) {
    box-sizing: border-box;
    width: 100%;
    height: 42mm;
    border: 1px dashed #b9aaa1;
    background:
      linear-gradient(135deg, transparent 49.5%, #d4c8c0 50%, transparent 50.5%),
      #f7f4f1;
  }

  :global(.rendered-markdown pre) {
    overflow: auto;
    margin: 1.4em 0;
    border: 1px solid #d3ccc7;
    border-radius: 4px;
    background: #f7f5f3;
    padding: 1em;
    font-family: NanumGothicCoding, monospace;
    font-size: 9pt;
    line-height: 1.6;
    white-space: pre-wrap;
    break-inside: avoid;
  }

  :global(.rendered-markdown code) {
    font-family: NanumGothicCoding, monospace;
    font-size: 0.9em;
  }

  :global(.rendered-markdown a) {
    color: #315f68;
    text-decoration-thickness: 0.06em;
    text-underline-offset: 0.15em;
  }

  :global(.rendered-markdown .katex-display) {
    margin: 1.5em 0;
    overflow-x: auto;
    overflow-y: hidden;
    break-inside: avoid;
  }

  :global(.rendered-markdown [data-footnotes]) {
    margin-top: 3em;
    border-top: 1px solid #aaa19b;
    padding-top: 1em;
    font-size: 8.5pt;
  }

  @media (max-width: 760px) {
    .preview-scroll {
      padding-right: 14px;
      padding-left: 14px;
    }

    .preview-paper {
      width: 100%;
      padding: 18mm 12mm;
    }
  }

  @media print {
    .preview-scroll {
      height: auto;
      overflow: visible;
      background: #fff;
      padding: 0;
    }

    .preview-paper {
      width: auto;
      min-height: 0;
      margin: 0;
      border: 0;
      padding: 0;
      box-shadow: none;
      background: #fff;
    }
  }
</style>
