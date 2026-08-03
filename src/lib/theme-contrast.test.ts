import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("../app.css", import.meta.url),
  "utf8",
);

function cssBlock(selector: string): string {
  const selectorStart = stylesheet.indexOf(selector);
  expect(
    selectorStart,
    `Missing ${selector} in stylesheet (${stylesheet.length} characters): ${stylesheet.slice(0, 80)}`,
  ).toBeGreaterThanOrEqual(0);
  const blockStart = stylesheet.indexOf("{", selectorStart);
  let depth = 0;
  for (let index = blockStart; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === "{") depth += 1;
    if (stylesheet[index] === "}") depth -= 1;
    if (depth === 0) return stylesheet.slice(blockStart + 1, index);
  }
  throw new Error(`CSS block is not closed: ${selector}`);
}

function hexToken(block: string, token: string): string {
  const value = block.match(
    new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`),
  )?.[1];
  if (!value) throw new Error(`Missing hexadecimal CSS token: ${token}`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4,
    );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("editorial theme accessibility", () => {
  it.each([
    [":root {", ["chrome", "panel", "surface-raised"]],
    [':root[data-theme="dark"] {', ["chrome", "panel", "surface-raised"]],
    [
      ':root[data-theme="system"] {',
      ["chrome", "panel", "surface-raised"],
    ],
  ])("keeps text tokens readable in %s", (selector, backgroundTokens) => {
    const block = cssBlock(selector);
    for (const foregroundToken of ["ink", "ink-muted", "ink-faint", "accent"]) {
      for (const backgroundToken of backgroundTokens) {
        expect(
          contrast(
            hexToken(block, foregroundToken),
            hexToken(block, backgroundToken),
          ),
          `${foregroundToken} on ${backgroundToken}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each([
    ":root {",
    ':root[data-theme="dark"] {',
    ':root[data-theme="system"] {',
  ])(
    "keeps semantic controls readable in %s",
    (selector) => {
      const block = cssBlock(selector);
      for (const foregroundToken of ["control-fg", "control-fg-muted"]) {
        for (const backgroundToken of ["control-bg", "control-bg-hover"]) {
          expect(
            contrast(
              hexToken(block, foregroundToken),
              hexToken(block, backgroundToken),
            ),
            `${foregroundToken} on ${backgroundToken}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(
        contrast(
          hexToken(block, "control-on-accent"),
          hexToken(block, "accent"),
        ),
        "control-on-accent on accent",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(
          hexToken(block, "control-on-warning"),
          hexToken(block, "warning"),
        ),
        "control-on-warning on warning",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(
          hexToken(block, "control-border"),
          hexToken(block, "control-bg"),
        ),
        "control-border on control-bg",
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it("resets native button chrome before applying semantic variants", () => {
    const button = cssBlock("button {");
    expect(button).toContain("appearance: none");
    expect(button).toContain("background: transparent");
    expect(button).toContain("color: var(--control-fg)");
  });

  it("keeps informative microcopy at twelve pixels or larger", () => {
    const root = cssBlock(":root {");
    const size = Number(root.match(/--type-micro:\s*(\d+)px/)?.[1]);
    expect(size).toBeGreaterThanOrEqual(12);
  });

  it("uses one lightweight deterministic paper texture", () => {
    const texture = readFileSync(
      new URL("../../static/textures/hanji-grain.svg", import.meta.url),
      "utf8",
    );
    expect(texture).toContain("feTurbulence");
    expect(new TextEncoder().encode(texture).byteLength).toBeLessThan(4_096);
  });
});
