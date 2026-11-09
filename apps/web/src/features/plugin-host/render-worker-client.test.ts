// Worker 実行クライアントの回帰テスト（報告書 24 第4回 M-4）。
// ブラウザ実行そのものは e2e（plugin/render-rules.spec.ts）で検証する。ここでは
// 「本番では静的判定を切れない」ことと、Worker 不在時の安全側フォールバックを確認する。

import { afterEach, describe, expect, it } from "vitest";
import {
  requestRenderSegments,
  resetRenderWorkerForTest,
  staticSafetyBypassAllowed,
} from "./render-worker-client";

afterEach(() => {
  resetRenderWorkerForTest();
});

describe("静的判定バイパス（テスト専用）", () => {
  it("本番ビルドでは localStorage のフラグがあっても無効", () => {
    expect(staticSafetyBypassAllowed("production", "1")).toBe(false);
    expect(staticSafetyBypassAllowed(undefined, "1")).toBe(false);
    expect(staticSafetyBypassAllowed("test", "1")).toBe(false);
  });

  it("開発ビルドではフラグがあるときだけ有効", () => {
    expect(staticSafetyBypassAllowed("development", "1")).toBe(true);
    expect(staticSafetyBypassAllowed("development", null)).toBe(false);
    expect(staticSafetyBypassAllowed("development", "0")).toBe(false);
  });
});

describe("Worker 不在時のフォールバック", () => {
  it("Worker が無い環境では変換せず null を返す（本文は通常表示）", async () => {
    const rule = { pattern: "1d6", flags: "g", template: "🎲", kind: "dice" as const };
    await expect(requestRenderSegments("1d6", [rule])).resolves.toBeNull();
  });

  it("規則が空なら null", async () => {
    await expect(requestRenderSegments("本文", [])).resolves.toBeNull();
  });
});