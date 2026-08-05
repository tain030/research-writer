export type PlatenDirection = -1 | 0 | 1;

export interface PlatenScrollInput {
  previousTop: number;
  nextTop: number;
  linePitch: number;
  platenDiameter: number;
  elapsedMs?: number;
}

export interface PlatenScrollFrame {
  angleDeg: number;
  surfaceOffsetPx: number;
  direction: PlatenDirection;
  detentIndex: number;
  detentCrossings: number;
  intensity: number;
}

export const TYPEWRITER_PLATEN_DIAMETER = 20;
export const TYPEWRITER_BODY_LINE_HEIGHT = 10.75 * (96 / 72) * 1.85;

const DEFAULT_FRAME_MS = 1000 / 60;
const MIN_LINE_PITCH = 12;
const MAX_LINE_PITCH = 48;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveModulo(value: number, divisor: number): number {
  return (value % divisor + divisor) % divisor;
}

/**
 * Keep the platen detent independent from headings and other variable-height
 * blocks. A manual typewriter indexes one fixed body-line pitch at a time.
 */
export function typewriterPlatenLinePitch(pageScale: number): number {
  const scale = positiveFinite(pageScale, 1);
  return clamp(TYPEWRITER_BODY_LINE_HEIGHT * scale, MIN_LINE_PITCH, MAX_LINE_PITCH);
}

/**
 * Resolve the visible platen state from absolute paper travel. Deriving the
 * angle from scrollTop avoids cumulative floating-point drift after long or
 * programmatic scrolls while still exposing direction and velocity feedback.
 */
export function resolvePlatenScrollFrame({
  previousTop,
  nextTop,
  linePitch,
  platenDiameter,
  elapsedMs = DEFAULT_FRAME_MS,
}: PlatenScrollInput): PlatenScrollFrame {
  const previous = Number.isFinite(previousTop) ? Math.max(0, previousTop) : 0;
  const next = Number.isFinite(nextTop) ? Math.max(0, nextTop) : previous;
  const pitch = positiveFinite(linePitch, TYPEWRITER_BODY_LINE_HEIGHT);
  const diameter = positiveFinite(platenDiameter, TYPEWRITER_PLATEN_DIAMETER);
  const frameMs = positiveFinite(elapsedMs, DEFAULT_FRAME_MS);
  const circumference = Math.PI * diameter;
  const delta = next - previous;
  const direction: PlatenDirection = delta === 0 ? 0 : delta > 0 ? 1 : -1;
  const previousDetent = Math.floor(previous / pitch);
  const detentIndex = Math.floor(next / pitch);
  const velocity = Math.abs(delta) / frameMs;

  return {
    angleDeg: positiveModulo(next / circumference * 360, 360),
    surfaceOffsetPx: positiveModulo(next, circumference),
    direction,
    detentIndex,
    detentCrossings: Math.abs(detentIndex - previousDetent),
    intensity: direction === 0 ? 0 : clamp(velocity / 1.35, 0.12, 1),
  };
}
