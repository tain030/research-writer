export type UnlistenFn = () => void;

export interface DesktopEvent<T = unknown> {
  payload: T;
}

interface OpenDialogOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface ResearchWriterBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, listener: (payload: T) => void): number;
  unsubscribe(id: number): void;
  openDialog(options: OpenDialogOptions): Promise<string | string[] | null>;
  saveDialog(options: SaveDialogOptions): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  exportPdf(suggestedName?: string): Promise<string | null>;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onResized(listener: () => void): number;
    onCloseRequested(listener: () => void): number;
  };
  onDragDrop(listener: (paths: string[]) => void): number;
}

declare global {
  interface Window {
    researchWriter?: ResearchWriterBridge;
  }
}

function bridge(): ResearchWriterBridge {
  if (typeof window === "undefined" || !window.researchWriter) {
    throw new Error("이 기능은 Research Writer 데스크톱 앱에서만 사용할 수 있습니다.");
  }
  return window.researchWriter;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.researchWriter);
}

export function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return bridge().invoke<T>(command, args);
}

export function listen<T>(
  event: string,
  listener: (event: DesktopEvent<T>) => void,
): Promise<UnlistenFn> {
  const id = bridge().listen<T>(event, (payload) => listener({ payload }));
  return Promise.resolve(() => bridge().unsubscribe(id));
}

export function openDialog(
  options: OpenDialogOptions,
): Promise<string | string[] | null> {
  return bridge().openDialog(options);
}

export function saveDialog(options: SaveDialogOptions): Promise<string | null> {
  return bridge().saveDialog(options);
}

export function openUrl(url: string): Promise<void> {
  return bridge().openExternal(url);
}

export function exportPdf(suggestedName?: string): Promise<string | null> {
  return bridge().exportPdf(suggestedName);
}

export function getCurrentWindow() {
  return {
    minimize: () => bridge().window.minimize(),
    toggleMaximize: () => bridge().window.toggleMaximize(),
    isMaximized: () => bridge().window.isMaximized(),
    onResized: (listener: () => void) => {
      const id = bridge().window.onResized(listener);
      return Promise.resolve(() => bridge().unsubscribe(id));
    },
    onCloseRequested: (
      listener: (event: { preventDefault(): void }) => void,
    ) =>
      Promise.resolve(
        bridge().window.onCloseRequested(() =>
          listener({ preventDefault: () => undefined }),
        ),
      ).then((id) => () => bridge().unsubscribe(id)),
  };
}

export function getCurrentWebviewWindow() {
  return {
    onDragDropEvent: (
      listener: (event: {
        payload: { type: "drop"; paths: string[] } | { type: "cancel" };
      }) => void,
    ) =>
      Promise.resolve(
        bridge().onDragDrop((paths) =>
          listener({ payload: { type: "drop", paths } }),
        ),
      ).then((id) => () => bridge().unsubscribe(id)),
  };
}
