// render 系テンプレートのプレビュー用サンプルレス（報告書 27 §4.4 / 決定 8）。
// 「該当」「非該当」「長文（2,048 字超）」の 3 種を、利用者が入力したタグ・単語から組み立てる。
// 長文は既知の制約 L-4（本文 2,048 字を超えると変換されない）を画面上で示すために使う。

import { MAX_RENDER_TEXT_CHARS } from "../plugin-host/render-rules";

export type RenderSampleKey = "hit" | "miss" | "long";

export interface RenderSample {
  key: RenderSampleKey;
  label: string;
  body: string;
  /** 長文サンプルだけに付く注意（L-4）。 */
  note?: string;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** 変換対象の文字を含み、かつ上限を超える長文サンプル。 */
function longSample(token: string): string {
  const head = `（長文の例）${"あ".repeat(24)}`;
  const need = Math.max(MAX_RENDER_TEXT_CHARS + 16 - head.length - token.length, 0);
  const unit = "これは長いレスの例です。";
  const filler = unit.repeat(Math.ceil(need / unit.length)).slice(0, need);
  return `${head}${filler}${token}`;
}

/**
 * テンプレートと検証済みの入力値からサンプルを作る。render 系以外は空配列。
 */
export function buildRenderSamples(
  templateId: string,
  values: Record<string, unknown>,
): RenderSample[] {
  switch (templateId) {
    case "spoiler": {
      const open = asText(values.openTag, "[sp]");
      const close = asText(values.closeTag, "[/sp]");
      const hit = `今日の試合、${open}主人公は実は生きていた${close}。まだ隠しておきたい。`;
      return [
        { key: "hit", label: "該当（タグで囲んだ部分）", body: hit },
        {
          key: "miss",
          label: "非該当（タグで囲んでいない）",
          body: `${open} の開始タグだけを書いた、ネタバレなしの雑談です。`,
        },
        {
          key: "long",
          label: "長文（2,048 字超）",
          body: longSample(`${open}長いレスのネタバレ${close}`),
          note: "長いレス（2,048 字超）には表示ルールが適用されません（既知の制約 L-4）。",
        },
      ];
    }
    case "ng-word-mask": {
      const words = Array.isArray(values.words) ? values.words.map(String) : [];
      const word = words[0] ?? "NGワード";
      const second = words[1] ?? word;
      return [
        {
          key: "hit",
          label: "該当（伏せたい単語を含む）",
          body: `このスレでは${word}と${second}を伏せ字にします。${word}は表示だけ置換されます。`,
        },
        {
          key: "miss",
          label: "非該当（単語を含まない）",
          body: "伏せたい単語を含まない、ふつうの雑談レスです。",
        },
        {
          key: "long",
          label: "長文（2,048 字超）",
          body: longSample(`${word}は長いレスの後半に出てきます。`),
          note: "長いレス（2,048 字超）には表示ルールが適用されません（既知の制約 L-4）。",
        },
      ];
    }
    case "keyword-deco": {
      const keyword = asText(values.keyword, "重要");
      return [
        {
          key: "hit",
          label: "該当（キーワードを含む）",
          body: `${keyword}なお知らせです。${keyword}の部分だけ装飾されます。`,
        },
        {
          key: "miss",
          label: "非該当（キーワードを含まない）",
          body: "キーワードを含まない、ふつうの雑談レスです。",
        },
        {
          key: "long",
          label: "長文（2,048 字超）",
          body: longSample(`${keyword}は長いレスの後半に出てきます。`),
          note: "長いレス（2,048 字超）には表示ルールが適用されません（既知の制約 L-4）。",
        },
      ];
    }
    default:
      return [];
  }
}