// テンプレート → エディタの受け渡し（報告書 27 §4.6 方式 B / 29 決定 7）。
//
// 静的エクスポートではルート間で未保存のフォーム状態を URL だけで渡せない（長すぎる・漏れる）。
// 画面で生成した `{ manifest, code }` を sessionStorage に 1 件だけ置き、`/plugins/new?from=template`
// が一度だけ読んで消す。方式 A（`?template=<id>` で既定値から始める）はエディタ側が生成する。

import { pluginManifestSchema, type PluginManifest } from "shared";

export const TEMPLATE_DRAFT_STORAGE_KEY = "oc.templateDraft";

export interface TemplateDraft {
  templateId: string;
  /** 生成に使った検証済みの入力値（エディタのヒント表示・将来の再生成用）。 */
  values: Record<string, unknown>;
  manifest: PluginManifest;
  code: string;
}

/** エディタへ渡す（上書き可。sessionStorage が使えない環境では黙って諦める）。 */
export function saveTemplateDraft(draft: TemplateDraft): boolean {
  try {
    window.sessionStorage.setItem(TEMPLATE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** 保存済みの下書きを取り出して削除する（`/plugins/new?from=template` が 1 回だけ呼ぶ）。 */
export function takeTemplateDraft(): TemplateDraft | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(TEMPLATE_DRAFT_STORAGE_KEY);
    window.sessionStorage.removeItem(TEMPLATE_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.templateId !== "string" || typeof record.code !== "string") return null;
    const manifest = pluginManifestSchema.safeParse(record.manifest);
    if (!manifest.success) return null;
    const values =
      record.values && typeof record.values === "object" && !Array.isArray(record.values)
        ? (record.values as Record<string, unknown>)
        : {};
    return { templateId: record.templateId, values, manifest: manifest.data, code: record.code };
  } catch {
    return null;
  }
}