import { parseManuscript, type ParsedManuscript } from "./manuscript-document";
import { renderManuscriptHtml } from "./render-manuscript";

export interface PreviewRenderRequest {
  revision: number;
  content: string;
  fallbackTitle: string;
  assetUrls: Record<string, string>;
}

export interface PreviewRenderResponse {
  revision: number;
  manuscript: ParsedManuscript;
  html: string;
}

self.onmessage = (event: MessageEvent<PreviewRenderRequest>) => {
  const request = event.data;
  const manuscript = parseManuscript(request.content, request.fallbackTitle, {
    diagnostics: false,
  });
  const hiddenRanges = [
    manuscript.frontmatterRange,
    manuscript.titleHeadingRange,
  ].filter((range): range is { from: number; to: number } => range !== null);
  const html = renderManuscriptHtml(request.content, request.assetUrls, {
    hiddenRanges,
  });
  self.postMessage({
    revision: request.revision,
    manuscript,
    html,
  } satisfies PreviewRenderResponse);
};
