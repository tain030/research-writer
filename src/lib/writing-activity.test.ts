// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  writingActivity,
  writingInputFromBeforeInput,
  writingInputFromKeydown,
} from "./writing-activity";

describe("writing activity classification", () => {
  it("counts only positive progress from direct keyboard input", () => {
    expect(
      writingActivity("", "연구", "paper", {
        kind: "character",
        origin: "keyboard",
      }),
    ).toMatchObject({
      insertedText: "연구",
      wordDelta: 1,
      sentenceDelta: 0,
      paragraphDelta: 0,
    });

    expect(
      writingActivity("연구", "연구.", "paper", {
        kind: "character",
        origin: "keyboard",
      }),
    ).toMatchObject({ sentenceDelta: 1, wordDelta: 0 });

    expect(
      writingActivity("연구 문장", "연구 문장\n\n", "paper", {
        kind: "enter",
        origin: "keyboard",
      }),
    ).toMatchObject({ paragraphDelta: 1 });
  });

  it("does not count pasted, accepted, or programmatic content", () => {
    expect(
      writingActivity("", "붙여넣기", "source", {
        kind: "paste",
        origin: "paste",
      }).wordDelta,
    ).toBe(0);
    expect(
      writingActivity("연구", "연구 제안", "paper", {
        kind: "other",
        origin: "autocomplete",
      }).wordDelta,
    ).toBe(0);
    expect(writingActivity("", "AI", "paper", null).origin).toBe(
      "programmatic",
    );
  });

  it("classifies browser input events used by both editors", () => {
    expect(
      writingInputFromBeforeInput(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: " ",
        }),
      ),
    ).toEqual({ kind: "space", origin: "keyboard", text: " " });
    expect(
      writingInputFromBeforeInput(
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
        }),
      ),
    ).toEqual({ kind: "backspace", origin: "keyboard" });
    expect(
      writingInputFromBeforeInput(
        new InputEvent("beforeinput", { inputType: "insertFromPaste" }),
      ),
    ).toEqual({ kind: "paste", origin: "paste" });
    expect(
      writingInputFromKeydown(new KeyboardEvent("keydown", { key: "Enter" })),
    ).toEqual({ kind: "enter", origin: "keyboard" });
    expect(
      writingInputFromKeydown(
        new KeyboardEvent("keydown", { key: "b", ctrlKey: true }),
      ),
    ).toBeNull();
  });
});
