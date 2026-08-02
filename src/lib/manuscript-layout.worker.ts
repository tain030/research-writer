import { layoutManuscript, type ManuscriptLayout } from "./manuscript-layout";

export interface ManuscriptLayoutRequest {
  revision: number;
  source: string;
  fallbackTitle: string;
}

export interface ManuscriptLayoutResponse {
  revision: number;
  source: string;
  fallbackTitle: string;
  layout: ManuscriptLayout;
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ManuscriptLayoutRequest>) => void) | null;
  postMessage: (message: ManuscriptLayoutResponse) => void;
};

workerScope.onmessage = (event) => {
  const request = event.data;
  workerScope.postMessage({
    revision: request.revision,
    source: request.source,
    fallbackTitle: request.fallbackTitle,
    layout: layoutManuscript(request.source, request.fallbackTitle),
  });
};
