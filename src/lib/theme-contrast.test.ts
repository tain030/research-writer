import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("../app.css", import.meta.url),
  "utf8",
);
const paginatedEditor = readFileSync(
  new URL("./PaginatedEditor.svelte", import.meta.url),
  "utf8",
);

function sourceCssBlock(source: string, label: string, selector: string): string {
  const selectorStart = source.indexOf(selector);
  expect(
    selectorStart,
    `Missing ${selector} in ${label} (${source.length} characters): ${source.slice(0, 80)}`,
  ).toBeGreaterThanOrEqual(0);
  const blockStart = source.indexOf("{", selectorStart);
  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(blockStart + 1, index);
  }
  throw new Error(`CSS block is not closed: ${selector}`);
}

function cssBlock(selector: string): string {
  return sourceCssBlock(stylesheet, "stylesheet", selector);
}

function editorCssBlock(selector: string): string {
  return sourceCssBlock(paginatedEditor, "PaginatedEditor", selector);
}

function hexToken(block: string, token: string): string {
  const value = block.match(
    new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`),
  )?.[1];
  if (!value) throw new Error(`Missing hexadecimal CSS token: ${token}`);
  return value;
}

function customProperty(block: string, token: string): string {
  const value = block.match(
    new RegExp(`--${token}:\\s*([\\s\\S]*?);`),
  )?.[1];
  if (!value) throw new Error(`Missing CSS custom property: ${token}`);
  return value.replace(/\s+/gu, " ").trim();
}

function lossyWebpDimensions(bytes: Buffer): [number, number] {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  expect(bytes.toString("ascii", 12, 16)).toBe("VP8 ");
  const frameStart = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
  expect(frameStart).toBeGreaterThanOrEqual(0);
  return [
    bytes.readUInt16LE(frameStart + 3) & 0x3fff,
    bytes.readUInt16LE(frameStart + 5) & 0x3fff,
  ];
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

  it("uses neutral cotton bond throughout the typewriter paper path", () => {
    const root = cssBlock(":root {");
    const sheet = hexToken(root, "typewriter-sheet");
    expect(sheet).toBe("#f3f4f1");
    expect(hexToken(root, "typewriter-sheet-edge")).toBe("#aeb2ad");
    expect(customProperty(root, "typewriter-paper-texture")).toBe(
      'url("/textures/typewriter-bond.svg")',
    );
    expect(contrast("#28231f", sheet)).toBeGreaterThanOrEqual(7);

    const texture = readFileSync(
      new URL("../../static/textures/typewriter-bond.svg", import.meta.url),
      "utf8",
    );
    expect(texture.match(/<feTurbulence/g)).toHaveLength(2);
    expect(texture).toContain('seed="29"');
    expect(texture).toContain('seed="53"');
    expect(texture.match(/stitchTiles="stitch"/g)).toHaveLength(2);
    expect(texture).not.toContain("<image");
    expect(texture).not.toContain("href=");
    expect(new TextEncoder().encode(texture).byteLength).toBeLessThan(4_096);

    const paper = editorCssBlock(".writing-typewriter .paper-sheet {");
    expect(paper).toContain("background-color: var(--typewriter-sheet)");
    expect(paper).toContain("var(--typewriter-paper-texture)");
    expect(paper).not.toContain("var(--hanji-texture)");

    const wraps = Array.from(
      paginatedEditor.matchAll(
        /^  \.typewriter-paper-wrap \{([\s\S]*?)^  \}/gmu,
      ),
      (match) => match[1],
    );
    expect(wraps).toHaveLength(1);
    for (const wrap of wraps) {
      expect(wrap).toContain("var(--typewriter-sheet)");
      expect(wrap).not.toContain("var(--sheet)");
    }
  });

  it("uses a low horizontal strike face and recessed theme graphite element as the typewriter caret", () => {
    const yoke = editorCssBlock(".typewriter-element-yoke {");
    expect(yoke).toContain("var(--type-strike-top-offset)");
    expect(yoke).toContain("var(--type-strike-height)");

    const strikeFace = editorCssBlock(".typewriter-strike-face {");
    expect(strikeFace).toContain(
      "top: calc((var(--type-strike-height) + 0.5px) * -1)",
    );
    expect(strikeFace).toContain("left: 50%");
    expect(strikeFace).toContain("width: var(--type-strike-width)");
    expect(strikeFace).toContain("height: var(--type-strike-height)");
    expect(strikeFace).toContain("transform: translateX(-50%)");
    expect(strikeFace).toContain("border-radius: 999px");

    const inkLayer = editorCssBlock(
      ".writing-typewriter .paper-stack > .paper-editor-mount {",
    );
    expect(inkLayer).toContain("z-index: 7");

    const shell = editorCssBlock(".typewriter-element-shell {");
    expect(shell).toContain("var(--printing-element-rotate)");
    expect(shell).toContain("var(--printing-element-tilt)");
    expect(shell).toContain("var(--typewriter-element-top)");
    expect(shell).toContain("var(--typewriter-element-mid)");
    expect(shell).toContain("var(--typewriter-element-deep)");
    expect(shell).toContain("var(--typewriter-element-highlight)");
    expect(shell).toContain("ellipse at 50% 20%");
    expect(shell).toContain("linear-gradient(\n        180deg");
    expect(shell).toContain(
      "transform var(--print-carrier-step-duration) cubic-bezier(0.18, 0.78, 0.24, 1)",
    );
    expect(shell).not.toContain("steps(2, end)");
    expect(shell).not.toContain("ellipse at 35% 20%");
    expect(shell).not.toContain("repeating-linear-gradient");

    const ribbonGate = editorCssBlock(".typewriter-ribbon-gate {");
    expect(ribbonGate).toContain(
      "var(--type-strike-top-offset) + var(--type-strike-height) + 3.5px",
    );
    expect(ribbonGate).toContain("width: calc(var(--type-strike-width) + 8px)");
    expect(ribbonGate).not.toContain("border-top");
    expect(ribbonGate).not.toContain("background:");
    const ribbonSides = editorCssBlock(
      ".typewriter-ribbon-gate::before,",
    );
    expect(ribbonSides).toContain("width: 1px");
    expect(ribbonSides).toContain("height: 6px");

    const recessedCradle = editorCssBlock(
      ".typewriter-print-element::after {",
    );
    expect(recessedCradle).toContain("height: 46%");
    expect(recessedCradle).toContain("z-index: 3");

    const strikeMotion = editorCssBlock(
      "@keyframes selectric-element-strike {",
    );
    const ribbonMotion = editorCssBlock(
      "@keyframes selectric-ribbon-lift {",
    );
    const contactMotion = editorCssBlock(
      "@keyframes typewriter-strike-face-press {",
    );
    expect(strikeMotion).toContain("translateY(1.5px)");
    expect(strikeMotion).toContain("translateY(-6px)");
    expect(ribbonMotion).toContain("translateY(-4px)");
    expect(contactMotion).toContain("scaleX(1.08) scaleY(0.72)");
    expect(paginatedEditor).toContain("const TYPEBAR_STRIKE_MS = 210");

    const typewriterCaret = editorCssBlock(
      ".writing-typewriter .paper-editor-mount :global(.ProseMirror) {",
    );
    expect(typewriterCaret).toContain("caret-color: transparent");
    expect(paginatedEditor).not.toContain("mechanical-caret-active");
    const forcedColors = editorCssBlock("@media (forced-colors: active) {");
    expect(forcedColors).toContain("caret-color: CanvasText !important");
    expect(forcedColors).toContain(
      ".typewriter-print-carrier { display: none; }",
    );
    expect(paginatedEditor).not.toContain("typewriter-active-slug");
    expect(paginatedEditor).not.toContain("typewriter-element-glyph-belt");
    expect(paginatedEditor).not.toContain("typewriter-triangle-index");
  });

  it("balances blockquote rails around their first and last content", () => {
    const quote = editorCssBlock(
      ".paper-editor-mount :global(.ProseMirror blockquote),",
    );
    expect(quote).toContain("padding-block: 0.15em");
    expect(quote).toContain("padding-inline: 1.1em 0");

    const first = editorCssBlock(
      ".paper-editor-mount :global(.ProseMirror blockquote > :first-child),",
    );
    const last = editorCssBlock(
      ".paper-editor-mount :global(.ProseMirror blockquote > :last-child),",
    );
    expect(first).toContain("margin-top: 0");
    expect(last).toContain("margin-bottom: 0");
    expect(paginatedEditor).toContain(
      ".paper-measure-host :global(.ProseMirror blockquote > :last-child)",
    );
  });

  it("uses warm loden embossed leather behind the light walnut typewriter", () => {
    const light = cssBlock(":root {");
    const desk = customProperty(light, "typewriter-desk-surface");
    const bed = customProperty(light, "typewriter-bed-surface");
    const race = customProperty(light, "typewriter-race-surface");
    const support = customProperty(light, "typewriter-support-surface");

    expect(desk).toContain('url("/textures/leather-emboss.svg")');
    expect(desk).toContain("#b0a991");
    expect(desk).toContain("#9b947b");
    expect(desk).toContain("#87806a");
    expect(desk).toContain("rgba(54, 47, 37, 0.1)");
    expect(customProperty(light, "typewriter-desk-inset-bottom")).toBe(
      "rgba(47, 42, 33, 0.12)",
    );
    expect(desk).not.toContain(".webp");
    expect(desk).not.toContain("taupe-leather-grain");
    expect(desk).not.toContain("walnut-desk");
    expect(bed).toContain('url("/textures/walnut-typewriter-veneer.webp")');
    expect(bed).toContain("#a27b5a");
    expect(race).toContain("#e7e8e3");
    expect(support).toContain("#858a87");
    expect(customProperty(light, "typewriter-contact-shadow")).toBe(
      "rgba(22, 11, 8, 0.72)",
    );
    expect(customProperty(light, "typewriter-chassis-surface")).toContain(
      'url("/textures/walnut-typewriter-veneer.webp")',
    );
    expect(customProperty(light, "typewriter-chassis-surface")).toContain(
      "#947052",
    );
    expect(
      customProperty(light, "typewriter-chassis-deck-overlay"),
    ).toContain("rgba(255, 246, 232, 0.28)");
    expect(
      customProperty(light, "typewriter-chassis-front-overlay"),
    ).toContain("rgba(25, 13, 9, 0.28)");
    expect(customProperty(light, "typewriter-depth-edge")).toBe(
      "rgba(64, 37, 26, 0.48)",
    );
  });

  it("separates the dark warm-black typewriter from its blue slate leather mat", () => {
    const light = cssBlock(":root {");
    const dark = cssBlock(':root[data-theme="dark"] {');
    const desk = customProperty(dark, "typewriter-desk-surface");
    const bed = customProperty(dark, "typewriter-bed-surface");
    const race = customProperty(dark, "typewriter-race-surface");
    const support = customProperty(dark, "typewriter-support-surface");
    const chassis = customProperty(dark, "typewriter-chassis-surface");
    const endcap = customProperty(dark, "typewriter-endcap-surface");

    expect(desk).toContain('url("/textures/leather-emboss.svg")');
    expect(desk).toContain("#3b4852");
    expect(desk).toContain("#34414b");
    expect(desk).toContain("#2d3942");
    expect(desk).not.toContain(".webp");
    expect(bed).toContain("#302c28");
    expect(bed).toContain("#0c0d0e");
    expect(bed).not.toContain(".webp");
    expect(race).toContain("#d7d8d3");
    expect(support).toContain("#707572");
    expect(customProperty(dark, "typewriter-contact-shadow")).toBe(
      "rgba(0, 0, 0, 0.86)",
    );
    expect(chassis).toContain("#262421");
    expect(chassis).toContain("#181817");
    expect(chassis).toContain("#0c0d0e");
    expect(chassis).not.toContain("leather-emboss.svg");
    expect(chassis).not.toContain(".webp");
    expect(endcap).toContain("#2d2925");
    expect(
      customProperty(dark, "typewriter-chassis-deck-overlay"),
    ).toContain("rgba(244, 234, 219, 0.16)");
    expect(
      customProperty(dark, "typewriter-chassis-front-overlay"),
    ).toContain("rgba(0, 0, 0, 0.36)");
    expect(customProperty(dark, "typewriter-depth-edge")).toBe(
      "rgba(4, 6, 7, 0.74)",
    );
    expect(customProperty(dark, "typewriter-body")).toBe("#181817");
    expect(customProperty(dark, "typewriter-body-light")).toBe("#2d2925");
    expect(customProperty(dark, "typewriter-body-cast-shadow")).toBe(
      "rgba(3, 6, 8, 0.58)",
    );
    expect(customProperty(light, "typewriter-element-top")).toBe("#45433d");
    expect(customProperty(light, "typewriter-element-deep")).toBe("#111412");
    expect(customProperty(dark, "typewriter-element-top")).toBe("#3a3b37");
    expect(customProperty(dark, "typewriter-element-deep")).toBe("#0b0e0d");
    expect(desk).not.toBe(customProperty(light, "typewriter-desk-surface"));
  });

  it("ships a small deterministic seamless leather emboss texture", () => {
    const texture = readFileSync(
      new URL("../../static/textures/leather-emboss.svg", import.meta.url),
      "utf8",
    );

    expect(texture.match(/<feTurbulence/g)).toHaveLength(2);
    expect(texture).toContain('seed="41"');
    expect(texture).toContain('seed="73"');
    expect(texture.match(/stitchTiles="stitch"/g)).toHaveLength(2);
    expect(texture).toContain("feDiffuseLighting");
    expect(texture).toContain("feDistantLight");
    expect(texture).not.toContain("feSpecularLighting");
    expect(texture).not.toContain("<image");
    expect(texture).not.toContain("href=");
    expect(new TextEncoder().encode(texture).byteLength).toBeLessThan(4_096);
  });

  it.each([
    ["walnut-typewriter-veneer.webp", [1920, 160], 180_000],
  ] as const)(
    "ships optimized local typewriter material %s",
    (filename, dimensions, maxBytes) => {
      const texture = readFileSync(
        new URL(`../../static/textures/${filename}`, import.meta.url),
      );
      expect(lossyWebpDimensions(texture)).toEqual(dimensions);
      expect(texture.byteLength).toBeLessThan(maxBytes);
    },
  );

  it("keeps the background abstract and the typewriter veneer photographic", () => {
    const light = cssBlock(":root {");
    const desk = customProperty(light, "typewriter-desk-surface");
    const chassis = customProperty(light, "typewriter-chassis-surface");

    expect(desk).toContain("320px 320px repeat");
    expect(desk).not.toContain(".webp");
    expect(desk).not.toContain("cover no-repeat");
    expect(chassis).toContain("center / 960px 80px no-repeat");
    expect(desk).not.toContain("repeating-linear-gradient");
    expect(chassis).not.toContain("repeating-linear-gradient");
  });

  it("keeps explicit and system dark typewriter surfaces identical", () => {
    const explicitDark = cssBlock(':root[data-theme="dark"] {');
    const systemDark = cssBlock(':root[data-theme="system"] {');
    const tokens = [
      "typewriter-desk-surface",
      "typewriter-bed-surface",
      "typewriter-race-surface",
      "typewriter-support-surface",
      "typewriter-contact-shadow",
      "typewriter-chassis-surface",
      "typewriter-chassis-deck-overlay",
      "typewriter-chassis-front-overlay",
      "typewriter-depth-edge",
      "typewriter-endcap-surface",
      "typewriter-body",
      "typewriter-body-deep",
      "typewriter-body-light",
      "typewriter-body-border",
      "typewriter-desk-inset-top",
      "typewriter-desk-inset-bottom",
      "typewriter-body-inset-highlight",
      "typewriter-body-inset-shadow",
      "typewriter-body-cast-shadow",
      "typewriter-element-top",
      "typewriter-element-mid",
      "typewriter-element-deep",
      "typewriter-element-border",
      "typewriter-element-highlight",
      "typewriter-endcap-inset-highlight",
      "typewriter-endcap-inset-shadow",
      "typewriter-endcap-cast-shadow",
      "typewriter-endcap-seam",
    ];

    for (const token of tokens) {
      expect(customProperty(systemDark, token)).toBe(
        customProperty(explicitDark, token),
      );
    }
  });

  it("routes every large typewriter surface through theme tokens", () => {
    for (const token of [
      "typewriter-desk-surface",
      "typewriter-race-surface",
      "typewriter-support-surface",
      "typewriter-contact-shadow",
      "typewriter-chassis-surface",
      "typewriter-chassis-deck-overlay",
      "typewriter-chassis-front-overlay",
      "typewriter-depth-edge",
      "typewriter-endcap-surface",
      "typewriter-desk-inset-top",
      "typewriter-desk-inset-bottom",
      "typewriter-body-inset-highlight",
      "typewriter-body-inset-shadow",
      "typewriter-body-cast-shadow",
      "typewriter-element-top",
      "typewriter-element-mid",
      "typewriter-element-deep",
      "typewriter-element-border",
      "typewriter-element-highlight",
      "typewriter-endcap-inset-highlight",
      "typewriter-endcap-inset-shadow",
      "typewriter-endcap-cast-shadow",
    ]) {
      expect(paginatedEditor).toContain(`var(--${token})`);
    }
  });

  it("clips the paper without repainting the desk below the platen", () => {
    expect(paginatedEditor).not.toContain("typewriter-paper-shield");
    expect(paginatedEditor).toContain("--typewriter-paper-mask-start");
    expect(paginatedEditor).toContain("--typewriter-paper-mask-end");
    expect(paginatedEditor).toContain("-webkit-mask-image: linear-gradient");
    expect(paginatedEditor).toContain("-webkit-mask-image: none");
  });
});
