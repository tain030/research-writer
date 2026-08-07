export interface PrintCarrierOffsetInput {
  printPointLeft: number;
  paperLeft: number;
  paperWidth: number;
}

export interface PrintingCellCenterInput {
  caretLeft: number;
  glyphLeft?: number | null;
  glyphRight?: number | null;
  fallbackAdvance: number;
  direction?: "ltr" | "rtl";
  fallbackSide?: "before" | "after";
}

export interface PaperMachineOriginInput {
  paperLeft: number;
  paperWidth: number;
  machineLeft: number;
  machineWidth: number;
}

export interface PrintingKeyInput {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export interface PrintingElementPose {
  rotate: number;
  tilt: number;
}

export interface PrintingCursorMetrics {
  strikeWidth: number;
  strikeHeight: number;
  strikeTopOffset: number;
  elementWidth: number;
  elementHeight: number;
}

const PRINTING_SAMPLE_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("ko", { granularity: "grapheme" })
    : null;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const HANGUL_CHARACTER = /\p{Script=Hangul}/u;
const HAN_CHARACTER = /\p{Script=Han}/u;
const HIRAGANA_CHARACTER = /\p{Script=Hiragana}/u;
const KATAKANA_CHARACTER = /\p{Script=Katakana}/u;
const LATIN_CHARACTER = /\p{Script=Latin}/u;
const UPPERCASE_CHARACTER = /\p{Lu}/u;
const NUMBER_CHARACTER = /\p{N}/u;
const LETTER_CHARACTER = /\p{L}/u;

const PRINTING_KEY_ROWS = [
  [
    "Backquote",
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Digit0",
    "Minus",
    "Equal",
  ],
  [
    "KeyQ",
    "KeyW",
    "KeyE",
    "KeyR",
    "KeyT",
    "KeyY",
    "KeyU",
    "KeyI",
    "KeyO",
    "KeyP",
    "BracketLeft",
    "BracketRight",
    "Backslash",
  ],
  [
    "KeyA",
    "KeyS",
    "KeyD",
    "KeyF",
    "KeyG",
    "KeyH",
    "KeyJ",
    "KeyK",
    "KeyL",
    "Semicolon",
    "Quote",
  ],
  [
    "KeyZ",
    "KeyX",
    "KeyC",
    "KeyV",
    "KeyB",
    "KeyN",
    "KeyM",
    "Comma",
    "Period",
    "Slash",
  ],
] as const;

const FALLBACK_PRINTING_POSES: PrintingElementPose[] = [
  { rotate: -6, tilt: -2 },
  { rotate: 5, tilt: 1 },
  { rotate: -3, tilt: 3 },
  { rotate: 8, tilt: -1 },
  { rotate: 2, tilt: -4 },
  { rotate: -8, tilt: 1 },
];
const PRINTING_ROW_TILTS = [-4, -1, 1, 4] as const;
const TYPEWRITER_LINE_APERTURE_MIN = 22;
const TYPEWRITER_LINE_APERTURE_MAX = 58;
const TYPEWRITER_CHASSIS_TOP_OFFSET = 13;
export const TYPEWRITER_CHASSIS_EDGE = 19;

/**
 * Anchor the printing line from the bottom chrome instead of a viewport ratio.
 * The workspace status bar sits outside the editor viewport, so only the
 * chassis offset and its intended enamel edge belong in this measurement.
 */
export function typewriterStrikeBottomClearance(lineAperture: number): number {
  const aperture = Number.isFinite(lineAperture)
    ? Math.max(
        TYPEWRITER_LINE_APERTURE_MIN,
        Math.min(TYPEWRITER_LINE_APERTURE_MAX, lineAperture),
      )
    : TYPEWRITER_LINE_APERTURE_MIN;
  return aperture / 2 + TYPEWRITER_CHASSIS_TOP_OFFSET + TYPEWRITER_CHASSIS_EDGE;
}

/** Printable keys turn and tilt the single element; spacing and controls do not. */
export function isPrintingKey(input: PrintingKeyInput): boolean {
  if (input.metaKey || input.ctrlKey || input.altKey) return false;
  return input.key === "Process" || (input.key.length === 1 && input.key !== " ");
}

/**
 * Suggest a restrained two-axis character selection motion. Physical key codes
 * keep the pose stable through Korean IME composition without making the
 * compact element visually lurch between characters.
 */
export function printingElementPoseForCode(
  code: string,
  sequence: number,
): PrintingElementPose {
  for (let rowIndex = 0; rowIndex < PRINTING_KEY_ROWS.length; rowIndex += 1) {
    const row = PRINTING_KEY_ROWS[rowIndex];
    const keyIndex = row.indexOf(code as never);
    if (keyIndex < 0) continue;
    return {
      rotate: Math.round((keyIndex / (row.length - 1) * 2 - 1) * 9),
      tilt: PRINTING_ROW_TILTS[rowIndex],
    };
  }
  return FALLBACK_PRINTING_POSES[
    Math.abs(sequence) % FALLBACK_PRINTING_POSES.length
  ];
}

/** Longer carrier travel gets a longer, but still brisk, powered return. */
export function printCarrierReturnDuration(offset: number): number {
  if (!Number.isFinite(offset)) return 180;
  return Math.max(180, Math.min(300, Math.round(170 + Math.abs(offset) * 0.28)));
}

function roundedMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Size a low horizontal printing face from the rendered type. Its top edge
 * sits just below the font's em box, while the compact element underneath only
 * grows enough to keep headings and body copy visually connected to the same
 * insertion point.
 */
export function printingCursorMetrics(
  fontSize: number,
  pageScale: number,
): PrintingCursorMetrics {
  const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
  const safeScale = Number.isFinite(pageScale) && pageScale > 0 ? pageScale : 1;
  const renderedFontSize = safeFontSize * safeScale;
  const strikeWidth = Math.max(10, Math.min(17, renderedFontSize * 0.52));
  const strikeHeight = Math.max(3, Math.min(4, renderedFontSize * 0.13));
  const strikeTopOffset = Math.max(
    6,
    Math.min(22, renderedFontSize * 0.5 + 1.5),
  );
  const elementWidth = Math.max(14, Math.min(19, strikeWidth + 2.5));
  const elementHeight = Math.max(13, Math.min(17, elementWidth * 0.88));

  return {
    strikeWidth: roundedMetric(strikeWidth),
    strikeHeight: roundedMetric(strikeHeight),
    strikeTopOffset: roundedMetric(strikeTopOffset),
    elementWidth: roundedMetric(elementWidth),
    elementHeight: roundedMetric(elementHeight),
  };
}

function contextualGraphemes(text: string): string[] {
  if (!text) return [];
  if (!PRINTING_SAMPLE_SEGMENTER) return Array.from(text);
  return Array.from(
    PRINTING_SAMPLE_SEGMENTER.segment(text),
    ({ segment }) => segment,
  );
}

function representativeForPrintingGrapheme(
  grapheme: string,
): string | null {
  if (EXTENDED_PICTOGRAPHIC.test(grapheme)) return grapheme;
  if (HANGUL_CHARACTER.test(grapheme)) return "가";
  if (HAN_CHARACTER.test(grapheme)) return "漢";
  if (HIRAGANA_CHARACTER.test(grapheme)) return "あ";
  if (KATAKANA_CHARACTER.test(grapheme)) return "ア";
  if (LATIN_CHARACTER.test(grapheme)) {
    return UPPERCASE_CHARACTER.test(grapheme) ? "H" : "n";
  }
  if (NUMBER_CHARACTER.test(grapheme)) return "0";
  if (LETTER_CHARACTER.test(grapheme)) return grapheme;
  return null;
}

/**
 * Choose a stable type-cell sample from the nearest substantive character.
 * Whitespace and punctuation do not shrink an empty next cell, while scripts
 * with broadly fixed glyph widths use one representative glyph for stability.
 */
export function representativePrintingGrapheme(
  context: string,
): string | null {
  const candidates = contextualGraphemes(context);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const representative = representativeForPrintingGrapheme(candidates[index]);
    if (representative) return representative;
  }
  return null;
}

/**
 * Browser layout supplies the real glyph width. This script-aware estimate is
 * only the fail-open path for environments that cannot measure hidden text.
 */
export function approximatePrintingGraphemeAdvance(
  grapheme: string,
  fontSize: number,
): number {
  const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
  let ratio = 0.55;
  if (
    HANGUL_CHARACTER.test(grapheme) ||
    HAN_CHARACTER.test(grapheme) ||
    HIRAGANA_CHARACTER.test(grapheme) ||
    KATAKANA_CHARACTER.test(grapheme)
  ) {
    ratio = 0.88;
  } else if (EXTENDED_PICTOGRAPHIC.test(grapheme)) {
    ratio = 1;
  } else if (
    LATIN_CHARACTER.test(grapheme) &&
    UPPERCASE_CHARACTER.test(grapheme)
  ) {
    ratio = 0.68;
  } else if (LATIN_CHARACTER.test(grapheme)) {
    ratio = 0.56;
  } else if (NUMBER_CHARACTER.test(grapheme)) {
    ratio = 0.6;
  } else if (LETTER_CHARACTER.test(grapheme)) {
    ratio = 0.72;
  }
  return safeFontSize * ratio;
}

/**
 * Use the visible grapheme when one exists. When no glyph can anchor the
 * printing point, center it in the measured type cell immediately before or
 * after the editor's insertion boundary.
 */
export function resolvePrintingCellCenter({
  caretLeft,
  glyphLeft,
  glyphRight,
  fallbackAdvance,
  direction = "ltr",
  fallbackSide = "after",
}: PrintingCellCenterInput): number | null {
  if (!Number.isFinite(caretLeft)) return null;
  if (
    typeof glyphLeft === "number" &&
    typeof glyphRight === "number" &&
    Number.isFinite(glyphLeft) &&
    Number.isFinite(glyphRight) &&
    glyphRight > glyphLeft
  ) {
    return (glyphLeft + glyphRight) / 2;
  }
  const advance =
    Number.isFinite(fallbackAdvance) && fallbackAdvance > 0
      ? fallbackAdvance
      : 0;
  const forward = direction === "rtl" ? -1 : 1;
  const side = fallbackSide === "before" ? -1 : 1;
  return caretLeft + forward * side * advance / 2;
}

/**
 * Place the moving print carrier under the resolved character center while the
 * A4 sheet stays fixed in horizontal screen space.
 */
export function resolvePrintCarrierOffset({
  printPointLeft,
  paperLeft,
  paperWidth,
}: PrintCarrierOffsetInput): number | null {
  if (
    ![printPointLeft, paperLeft, paperWidth].every(Number.isFinite) ||
    paperWidth <= 0
  ) {
    return null;
  }
  return printPointLeft - (paperLeft + paperWidth / 2);
}

/** Align the fixed platen assembly with the paper's visual center. */
export function resolvePaperMachineOrigin({
  paperLeft,
  paperWidth,
  machineLeft,
  machineWidth,
}: PaperMachineOriginInput): number | null {
  if (
    ![paperLeft, paperWidth, machineLeft, machineWidth].every(Number.isFinite) ||
    paperWidth <= 0 ||
    machineWidth <= 0
  ) {
    return null;
  }
  const paperCenter = paperLeft + paperWidth / 2;
  const machineCenter = machineLeft + machineWidth / 2;
  return paperCenter - machineCenter;
}

/** Reserve only the space occupied by a non-overlay vertical scrollbar. */
export function resolveScrollbarGutter(
  offsetWidth: number,
  clientWidth: number,
): number {
  if (![offsetWidth, clientWidth].every(Number.isFinite)) return 0;
  return Math.max(0, offsetWidth - clientWidth);
}
