// サンドボックス iframe の CSP 生成（DESIGN §7.1）。
// 既定は全禁止。net:fetch を宣言したプラグインだけ、manifest.connectAllowlist のオリジンを
// img-src に追加する（通信自体はホストのプロキシ経由で、connect-src は常に 'none'）。

import type { PluginManifest } from "shared";

/** manifest から CSP 文字列を作る。 */
export function buildSandboxCsp(manifest: Pick<PluginManifest, "permissions" | "connectAllowlist">): string {
  const allowlist = manifest.permissions.includes("net:fetch")
    ? manifest.connectAllowlist
        .map((entry) => {
          try {
            return new URL(entry).origin;
          } catch {
            return null;
          }
        })
        .filter((origin): origin is string => origin !== null)
    : [];

  const directives = [
    "default-src 'none'",
    // ブートストラップ（インライン）とプラグイン本体（Blob URL）のみ許可
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${allowlist.length > 0 ? ` ${allowlist.join(" ")}` : ""}`,
    "font-src data:",
    "media-src data: blob:",
    // 外部通信は必ずホストの net:fetch プロキシ経由（iframe から直接は不可）
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

/** iframe の sandbox 属性。allow-same-origin は絶対に付けない（不透明オリジン）。 */
export const PLUGIN_IFRAME_SANDBOX = "allow-scripts";