// おーぷんクローン プラグイン SDK。
// 型・manifest スキーマ・権限は shared を再エクスポートし、作者向け API 型と definePlugin を提供する。

export * from "./types";
export * from "./define-plugin";

export {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERMISSION_RISK,
  PLUGIN_SCOPES,
  PLUGIN_SLOTS,
  PLUGIN_HOOKS,
  PLUGIN_STATUSES,
  PLUGIN_VISIBILITIES,
  PLUGIN_REPORT_REASONS,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_ENTRY_FILENAME,
  PLUGIN_RPC_PERMISSIONS,
  PLUGIN_RPC_VERSION,
  pluginManifestSchema,
  pluginPostRenderRuleSchema,
  normalizeManifest,
  manifestRiskLevel,
  rpcPermissionFor,
  type PluginManifest,
  type PluginManifestInput,
  type PluginPermission,
  type PluginPostRenderRule,
  type PluginScope,
  type PluginSlotName,
  type PluginHookName,
  type PluginStatus,
  type PluginVisibility,
  type PluginReportReason,
  type PluginNetFetchResult,
  type PluginRpcRequest,
  type PluginRpcResponse,
  type PluginHostMessage,
} from "shared";