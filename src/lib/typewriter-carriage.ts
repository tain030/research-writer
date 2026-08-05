export interface CarriageTargetInput {
  renderedShift: number;
  caretLeft: number;
  strikePoint: number;
}

export interface CarriageOriginInput {
  paperLeft: number;
  paperWidth: number;
  renderedShift: number;
  machineLeft: number;
  machineWidth: number;
}

export interface TypebarKeyInput {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

const TYPEBAR_KEY_ROWS = [
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

const FALLBACK_TYPEBAR_ORIGINS = [-0.72, 0.58, -0.34, 0.83, 0.16, -0.9];
const TYPEWRITER_LINE_APERTURE_MIN = 22;
const TYPEWRITER_LINE_APERTURE_MAX = 58;
const TYPEWRITER_CHASSIS_TOP_OFFSET = 13;
export const TYPEWRITER_CHASSIS_EDGE = 18;

/**
 * Anchor the strike point from the bottom chrome instead of a viewport ratio.
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
  return (
    aperture / 2 +
    TYPEWRITER_CHASSIS_TOP_OFFSET +
    TYPEWRITER_CHASSIS_EDGE
  );
}

/** A printable physical key raises a typebar; spacing and controls do not. */
export function isTypebarKey(input: TypebarKeyInput): boolean {
  if (input.metaKey || input.ctrlKey || input.altKey) return false;
  return input.key === "Process" || input.key.length === 1 && input.key !== " ";
}

/**
 * Give each physical key a stable place in the semicircular type basket.
 * Korean IME key events retain their physical `code`, even when `key` is
 * reported as `Process`.
 */
export function typebarOriginForCode(code: string, sequence: number): number {
  for (const row of TYPEBAR_KEY_ROWS) {
    const index = row.indexOf(code as never);
    if (index < 0) continue;
    return index / (row.length - 1) * 2 - 1;
  }
  return FALLBACK_TYPEBAR_ORIGINS[
    Math.abs(sequence) % FALLBACK_TYPEBAR_ORIGINS.length
  ];
}

/** Longer carriage travel gets a longer, but still brisk, manual return. */
export function carriageReturnDuration(shift: number): number {
  if (!Number.isFinite(shift)) return 180;
  return Math.max(180, Math.min(300, Math.round(170 + Math.abs(shift) * 0.28)));
}

/**
 * Read the horizontal translation from the matrix returned by getComputedStyle.
 * The rendered value matters while a CSS transition is between two targets.
 */
export function renderedTranslateX(transform: string): number | null {
  const normalized = transform.trim();
  if (!normalized || normalized === "none") return 0;

  const matrix = /^matrix\(([^)]+)\)$/u.exec(normalized);
  if (matrix) {
    const values = matrix[1].split(",").map((value) => Number(value.trim()));
    return values.length === 6 && values.every(Number.isFinite)
      ? values[4]
      : null;
  }

  const matrix3d = /^matrix3d\(([^)]+)\)$/u.exec(normalized);
  if (matrix3d) {
    const values = matrix3d[1]
      .split(",")
      .map((value) => Number(value.trim()));
    return values.length === 16 && values.every(Number.isFinite)
      ? values[12]
      : null;
  }

  return null;
}

/**
 * Resolve the next absolute paper position from what is actually on screen.
 * Using a previously requested target here would double-apply corrections when
 * the paper is still moving toward that target.
 */
export function resolveCarriageTarget({
  renderedShift,
  caretLeft,
  strikePoint,
}: CarriageTargetInput): number | null {
  if (![renderedShift, caretLeft, strikePoint].every(Number.isFinite)) {
    return null;
  }
  return renderedShift + strikePoint - caretLeft;
}

/**
 * Align the moving carriage artwork with the paper's unshifted visual center.
 * The paper is centered by its scroll layout (which can include a scrollbar),
 * while the machine is centered by the editor shell. Removing the currently
 * rendered translation keeps this origin stable during a carriage animation.
 */
export function resolveCarriageOrigin({
  paperLeft,
  paperWidth,
  renderedShift,
  machineLeft,
  machineWidth,
}: CarriageOriginInput): number | null {
  if (
    ![
      paperLeft,
      paperWidth,
      renderedShift,
      machineLeft,
      machineWidth,
    ].every(Number.isFinite) ||
    paperWidth <= 0 ||
    machineWidth <= 0
  ) {
    return null;
  }
  const paperOrigin = paperLeft + paperWidth / 2 - renderedShift;
  const machineCenter = machineLeft + machineWidth / 2;
  return paperOrigin - machineCenter;
}

/** Reserve only the space occupied by a non-overlay vertical scrollbar. */
export function resolveScrollbarGutter(
  offsetWidth: number,
  clientWidth: number,
): number {
  if (![offsetWidth, clientWidth].every(Number.isFinite)) return 0;
  return Math.max(0, offsetWidth - clientWidth);
}
