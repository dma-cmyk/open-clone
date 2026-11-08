// plugin-host の公開 API。WP2 はここから import する。
// - `<PluginSlot>`: スロットへのプラグイン実行（sandbox iframe）
// - `<PluginRenderStyles>`: 投稿表示変換の装飾 CSS
// - `applyPostRenderRules`: 宣言的レンダー規則（レス本文を安全な HTML へ）
// - `publishPluginEvent` / `subscribePluginEvents`: リアルタイムイベント連携
// - `pluginApi`: レジストリ API クライアント（/plugins 配下の UI もこれを使う）

export { PluginSlot, type PluginSlotProps } from "./slot";
export { resolveDeclaredSlot, SLOT_ALIASES } from "./slots";
export { PluginPreview, type PluginPreviewProps } from "./preview";
export { PluginRenderStyles } from "./styles";
export {
  applyPostRenderRules,
  applyAllPostRenderRules,
  splitPostRenderRules,
  escapeHtml,
  PLUGIN_RENDER_CSS,
  type PostRenderResult,
  type PostRenderSegment,
} from "./render-rules";
export {
  PLUGIN_IFRAME_SANDBOX,
  buildSandboxCsp,
} from "./csp";
export {
  PLUGIN_BOOTSTRAP_SCRIPT,
  buildPluginSrcdoc,
  escapeHtmlText,
} from "./bootstrap";
export {
  authorizeRpc,
  createPluginBridge,
  createRpcDispatcher,
  sanitizeDraftPatch,
  type BridgeHandlers,
  type PluginBridge,
  type PluginBridgeOptions,
  type RpcDecision,
  type RpcHostContext,
} from "./bridge";
export {
  publishPluginEvent,
  subscribePluginEvents,
  type PluginRuntimeEvent,
  type PluginRuntimePost,
  type PluginRuntimeThread,
} from "./events";
export {
  pluginApi,
  PluginApiError,
  loadActiveInstalls,
  invalidateActiveInstalls,
  type PluginCreateInput,
  type PluginInstallInput,
  type PluginListParams,
  type PluginStateScope,
  type PluginVersionInput,
} from "./api";
export { SAMPLE_BOARD, SAMPLE_POSTS, SAMPLE_THREAD } from "./sample";
export { usePluginPostRenderRules, type PluginRulesParams } from "./hooks";
