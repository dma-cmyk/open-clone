// エディタの「サンプルを読み込む」用テンプレート。
//
// かつてはここに manifest/code を手書きで複製していたが、テンプレート定義は
// `packages/shared/src/plugin-templates-data.ts` が正本（report28 §6.1 / §8.2）。
// このファイルは shared の 7 テンプレートを **既定値で生成** してエディタの形へ射影するだけにし、
// 定義の二重管理をなくす。生成器（`generateFromTemplate`）を通すため、読み込んだサンプルも
// 保存時の静的検査と同じ形になる。
//
// `examples/plugins/` の gallery / gist-embed はフォーム化していない公式サンプルなので、
// ここには含めない（エディタへは従来どおり Gist/リポジトリ取込やコード貼り付けで持ち込める）。

import {
  PLUGIN_TEMPLATES as SHARED_TEMPLATES,
  generateFromTemplate,
  type PluginPostRenderRule,
  type PluginPermission,
  type PluginScope,
  type PluginSlotName,
  type PluginTemplateDefinition,
} from "shared";

export interface PluginTemplate {
  id: string;
  label: string;
  name: string;
  version: string;
  summary: string;
  description: string;
  scopes: PluginScope[];
  permissions: PluginPermission[];
  connectAllowlist: string[];
  slots: PluginSlotName[];
  render: PluginPostRenderRule[];
  code: string;
}

/**
 * 必須項目が既定値で空のテンプレートに、エディタで読み込める最小の初期値を補う。
 * フォーム経路（/plugins/templates）では利用者が必ず入力するため、この補完は使わない。
 */
const EDITOR_DEFAULTS: Record<string, Record<string, unknown>> = {
  // 公式サンプル（examples/plugins/spoiler）と同じ `[spoiler]` タグで読み込む
  // （デモのサンプルレスもこのタグを使う。フォーム経路の既定値 `[sp]` とは別）。
  spoiler: { openTag: "[spoiler]", closeTag: "[/spoiler]" },
  "ng-word-mask": { words: ["NGワード"] },
  "quick-reply": { body: "（ここに定型文を入力してください）" },
};

function toEditorTemplate(definition: PluginTemplateDefinition): PluginTemplate {
  const generated = generateFromTemplate(definition.id, EDITOR_DEFAULTS[definition.id] ?? {});
  if (!generated.ok) {
    const reason = generated.fieldErrors.map((error) => `${error.key}: ${error.message}`).join(", ");
    throw new Error(`テンプレート「${definition.id}」の既定値生成に失敗しました: ${reason}`);
  }
  const { manifest, code } = generated;
  return {
    id: definition.id,
    label: definition.label,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    description: manifest.description ?? definition.description,
    scopes: manifest.scope,
    permissions: manifest.permissions,
    connectAllowlist: manifest.connectAllowlist,
    slots: manifest.slots,
    render: manifest.render?.post ?? [],
    code,
  };
}

export const PLUGIN_TEMPLATES: PluginTemplate[] = SHARED_TEMPLATES.map(toEditorTemplate);