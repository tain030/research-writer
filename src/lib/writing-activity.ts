import { countWords } from "./markdown";
import type {
  WritingActivity,
  WritingInputKind,
  WritingInputOrigin,
} from "./types";

export interface PendingWritingInput {
  kind: WritingInputKind;
  origin: WritingInputOrigin;
  text?: string;
  paragraphHadContent?: boolean;
}

interface TextChange {
  insertedText: string;
  removedText: string;
  prefix: number;
}

function textChange(before: string, after: string): TextChange {
  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < suffixLimit &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    insertedText: after.slice(prefix, after.length - suffix),
    removedText: before.slice(prefix, before.length - suffix),
    prefix,
  };
}

function completedParagraph(before: string, change: TextChange): number {
  if (!change.insertedText.includes("\n")) return 0;
  const line = before.slice(0, change.prefix).split(/\r?\n/u).at(-1) ?? "";
  return /\S/u.test(line) ? 1 : 0;
}

export function writingActivity(
  before: string,
  after: string,
  source: WritingActivity["source"],
  input: PendingWritingInput | null,
): WritingActivity {
  const change = textChange(before, after);
  const origin = input?.origin ?? "programmatic";
  const kind = input?.kind ?? "other";
  const direct = origin === "keyboard";
  const directlyInsertedText = input?.text ?? change.insertedText;

  return {
    source,
    kind,
    origin,
    insertedText: change.insertedText,
    removedText: change.removedText,
    wordDelta: direct
      ? Math.max(0, countWords(after) - countWords(before))
      : 0,
    sentenceDelta: direct
      ? directlyInsertedText.match(/[.!?。！？]/gu)?.length ?? 0
      : 0,
    paragraphDelta:
      direct && kind === "enter"
        ? input?.paragraphHadContent === true
          ? 1
          : completedParagraph(before, change)
        : 0,
  };
}

export function writingInputFromBeforeInput(
  event: InputEvent,
): PendingWritingInput | null {
  const type = event.inputType;
  if (type === "insertFromPaste" || type === "insertFromDrop") {
    return { kind: "paste", origin: "paste" };
  }
  if (type === "insertParagraph" || type === "insertLineBreak") {
    return { kind: "enter", origin: "keyboard" };
  }
  if (type === "deleteContentBackward") {
    return { kind: "backspace", origin: "keyboard" };
  }
  if (type === "deleteContentForward") {
    return { kind: "delete", origin: "keyboard" };
  }
  if (type.startsWith("delete")) {
    return { kind: "delete", origin: "keyboard" };
  }
  if (type === "insertText" || type === "insertCompositionText") {
    return {
      kind: event.data === " " ? "space" : "character",
      origin: "keyboard",
      text: event.data ?? "",
    };
  }
  return null;
}

export function writingInputFromKeydown(
  event: KeyboardEvent,
): PendingWritingInput | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Enter") return { kind: "enter", origin: "keyboard" };
  if (event.key === "Backspace") {
    return { kind: "backspace", origin: "keyboard" };
  }
  if (event.key === "Delete") return { kind: "delete", origin: "keyboard" };
  if (event.key === " ") {
    return { kind: "space", origin: "keyboard", text: " " };
  }
  if (event.key.length === 1) {
    return { kind: "character", origin: "keyboard", text: event.key };
  }
  return null;
}
