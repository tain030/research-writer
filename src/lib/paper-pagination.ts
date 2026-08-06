import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export interface PaperPageBreak {
  /** ProseMirror position immediately before the first block on the next page. */
  pos: number;
  /** Empty space needed to finish the previous sheet and enter the next one. */
  restPx: number;
}

interface PaginationState {
  breaks: PaperPageBreak[];
  decorations: DecorationSet;
}

const paginationMeta = "research-writer:paper-pagination";
const MAX_PAPER_PAGE_REST_PX = 297 * 96 / 25.4;

export const paperPaginationKey = new PluginKey<PaginationState>(
  "research-writer-paper-pagination",
);

function decorationFor(pageBreak: PaperPageBreak, index: number): Decoration {
  return Decoration.widget(
    pageBreak.pos,
    () => {
      const spacer = document.createElement("span");
      spacer.className = "paper-page-break";
      spacer.contentEditable = "false";
      spacer.setAttribute("aria-hidden", "true");
      spacer.dataset.pageBreak = String(index + 1);
      spacer.style.setProperty("--page-rest", `${Math.max(0, pageBreak.restPx)}px`);
      return spacer;
    },
    {
      side: -100,
      key: `paper-page-break:${index}:${pageBreak.pos}:${pageBreak.restPx.toFixed(2)}`,
      ignoreSelection: true,
      stopEvent: () => true,
    },
  );
}

export function normalizePaperPageBreaks(
  breaks: PaperPageBreak[],
  documentSize: number,
): PaperPageBreak[] {
  if (!Number.isInteger(documentSize) || documentSize <= 1) return [];
  const byPosition = new Map<number, number>();
  for (const entry of breaks) {
    if (
      !Number.isInteger(entry.pos) ||
      !Number.isFinite(entry.restPx) ||
      entry.pos <= 0 ||
      entry.pos >= documentSize
    ) {
      continue;
    }
    const restPx = Math.max(
      0,
      Math.min(MAX_PAPER_PAGE_REST_PX, entry.restPx),
    );
    const previous = byPosition.get(entry.pos);
    byPosition.set(
      entry.pos,
      previous === undefined ? restPx : Math.min(previous, restPx),
    );
  }
  return Array.from(byPosition, ([pos, restPx]) => ({ pos, restPx })).sort(
    (left, right) => left.pos - right.pos,
  );
}

function paginationState(
  doc: Transaction["doc"],
  breaks: PaperPageBreak[],
): PaginationState {
  const safeBreaks = normalizePaperPageBreaks(breaks, doc.content.size);
  return {
    breaks: safeBreaks,
    decorations: DecorationSet.create(
      doc,
      safeBreaks.map(decorationFor),
    ),
  };
}

export const PaperPagination = Extension.create({
  name: "paperPagination",

  addProseMirrorPlugins() {
    return [
      new Plugin<PaginationState>({
        key: paperPaginationKey,
        state: {
          init: (_, state) => paginationState(state.doc, []),
          apply: (transaction, current) => {
            const next = transaction.getMeta(paginationMeta) as
              | PaperPageBreak[]
              | undefined;
            if (next) return paginationState(transaction.doc, next);
            if (!transaction.docChanged) return current;
            const mapped = current.breaks.map((entry) => ({
              ...entry,
              pos: transaction.mapping.map(entry.pos, -1),
            }));
            return paginationState(transaction.doc, mapped);
          },
        },
        props: {
          decorations: (state) =>
            paperPaginationKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export function setPaperPageBreaks(
  view: EditorView,
  breaks: PaperPageBreak[],
): void {
  view.dispatch(view.state.tr.setMeta(paginationMeta, breaks).setMeta("addToHistory", false));
}

export function paperPageBreaks(view: EditorView): PaperPageBreak[] {
  return paperPaginationKey.getState(view.state)?.breaks ?? [];
}
