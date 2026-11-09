// テンプレート生成物が既存の静的検査（runStaticChecks）を通ることを検証する。
// 生成器は shared、検査器は api の既存実装（複製しない）。報告書 28 §8.0 / 27 §7.0。

import { describe, expect, it } from "vitest";
import {
  PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES,
  PLUGIN_TEMPLATES,
  generateFromTemplate,
  type PluginTemplateDefinition,
} from "shared";
import { runStaticChecks } from "../src/services/plugins/static-checks";

function templateOf(id: string): PluginTemplateDefinition {
  const template = PLUGIN_TEMPLATES.find((entry) => entry.id === id);
  if (!template) throw new Error(`unknown template: ${id}`);
  return template;
}

function representativeParams(id: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const parameter of templateOf(id).parameters) {
    if (parameter.default !== undefined) params[parameter.key] = parameter.default;
  }
  if (id === "ng-word-mask") params.words = ["単語", "NG"];
  if (id === "quick-reply") params.body = "テスト投稿です";
  return params;
}

function generateOk(id: string, params: Record<string, unknown>) {
  const result = generateFromTemplate(id, params);
  if (!result.ok) throw new Error(`generate failed: ${JSON.stringify(result.fieldErrors)}`);
  return result;
}

const BOUNDARIES: Array<[string, Record<string, unknown>]> = [
  ["spoiler", { openTag: "1234567890", closeTag: "abcdefghij" }],
  ["ng-word-mask", { words: Array.from({ length: 50 }, (_, index) => `w${index}`), mask: "x".repeat(20) }],
  ["keyword-deco", { keyword: "k".repeat(30), deco: "spoiler", ignoreCase: true }],
  [
    "dice-button",
    {
      slot: "thread-bottom",
      label: "L".repeat(20),
      sides: 100,
      count: 10,
      messages: Array.from({ length: 10 }, (_, index) => `${index + 1}:ok`).join("\n"),
    },
  ],
  ["counter", { label: "c".repeat(20), start: 999_999, step: 100, storageKey: "k".repeat(40) }],
  ["thread-info", { fields: ["title", "count", "board"], prefix: "p".repeat(8) }],
  [
    "quick-reply",
    {
      buttonLabel: "b".repeat(20),
      body: "あ".repeat(2000),
      postName: "n".repeat(100),
      confirmText: "c".repeat(60),
    },
  ],
];

const INJECTION_STRINGS = [
  "'); eval('x'); //",
  "*/ alert(1) /*",
  "</script><script>alert(1)</script>",
  "`${alert(1)}`",
  ".*+?()[]{}|\\^$",
  "\u2028\u2029\u0000",
  "'; api.storage.set('x','y'); //",
];

describe("テンプレート生成物 × runStaticChecks", () => {
  for (const template of PLUGIN_TEMPLATES) {
    it(`${template.id}: 代表パラメータの生成物が allowed=true`, async () => {
      const result = generateOk(template.id, representativeParams(template.id));
      const checks = await runStaticChecks(result.code, result.manifest);
      expect(checks.allowed, checks.reasons.join(" / ")).toBe(true);
      expect(new TextEncoder().encode(result.code).byteLength).toBeLessThanOrEqual(
        PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES,
      );
    });
  }

  for (const [id, override] of BOUNDARIES) {
    it(`${id}: 境界パラメータの生成物が allowed=true`, async () => {
      const result = generateOk(id, { ...representativeParams(id), ...override });
      const checks = await runStaticChecks(result.code, result.manifest);
      expect(checks.allowed, checks.reasons.join(" / ")).toBe(true);
    });
  }

  for (const id of ["dice-button", "counter", "thread-info", "quick-reply"]) {
    it(`${id}: 注入を狙う入力でも allowed=true`, async () => {
      for (const injected of INJECTION_STRINGS) {
        const params = { ...representativeParams(id) };
        if (id === "dice-button" || id === "counter") params.label = injected.slice(0, 20);
        if (id === "thread-info") params.prefix = injected.slice(0, 8);
        if (id === "quick-reply") {
          params.body = injected;
          params.postName = injected.slice(0, 100);
          params.confirmText = injected.slice(0, 60);
        }
        const result = generateOk(id, params);
        const checks = await runStaticChecks(result.code, result.manifest);
        expect(checks.allowed, `${id}/${injected}: ${checks.reasons.join(" / ")}`).toBe(true);
      }
    });
  }
});