// プラグイン作成テンプレート（① コードを書かない経路）の web 側実装。
// 生成・検証の実体は shared（`generateFromTemplate` / `validateTemplateParams`）にあり、
// ここはフォーム・プレビュー・エディタ受け渡しの UI 部品だけを持つ。

export {
  PLUGIN_TEMPLATES,
  findPluginTemplate,
  parseTemplateOrigin,
  templateKindLabel,
  templatePermissionLabels,
  templateRiskBadge,
  type PluginTemplateDefinition,
} from "./registry";
export {
  describeGenerationError,
  formStateToParams,
  generateDraft,
  initialFormState,
  mapFieldErrors,
  templateChangelog,
  validateForm,
  type DraftResult,
  type FieldErrorMap,
  type FormState,
  type FormValidation,
  type FormValue,
} from "./form-model";
export { TemplateForm } from "./form";
export { RenderRulePreview, SlotTemplatePreview, TemplatePreview } from "./preview";
export { buildRenderSamples, type RenderSample } from "./samples";
export {
  TEMPLATE_DRAFT_STORAGE_KEY,
  saveTemplateDraft,
  takeTemplateDraft,
  type TemplateDraft,
} from "./draft";