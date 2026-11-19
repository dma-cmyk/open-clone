// 入力欄の Enter の扱い。日本語の変換中の Enter で送らない。

import { describe, expect, it } from "vitest";
import { shouldSendOnEnter } from "./enter-key";

describe("shouldSendOnEnter", () => {
  it("Enter で送る", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("Shift+Enter は送らない（改行）", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("変換中の Enter は送らない（Chrome は isComposing）", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("変換中の Enter は送らない（Safari は keyCode 229）", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });

  it("Enter 以外は送らない", () => {
    expect(shouldSendOnEnter({ key: "a", shiftKey: false })).toBe(false);
    expect(shouldSendOnEnter({ key: "Process", shiftKey: false, keyCode: 229 })).toBe(false);
  });
});