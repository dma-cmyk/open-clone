// `/v1/me/plugin-tokens` の薄いクライアント（報告書27 §7.2）。
// 発行・全失効はサーバ側で step-up 必須。呼び出し側は `useStepUp().run()` で包む。

import type { PluginAuthorTokenCreateResponse, PluginAuthorTokenSummary } from "shared";
import { api } from "./api";

export function listPluginTokens(): Promise<PluginAuthorTokenSummary[]> {
  return api<{ items: PluginAuthorTokenSummary[] }>("GET", "/me/plugin-tokens").then((data) => data.items);
}

export function createPluginToken(name?: string): Promise<PluginAuthorTokenCreateResponse> {
  return api<PluginAuthorTokenCreateResponse>("POST", "/me/plugin-tokens", name ? { name } : {});
}

export function revokePluginToken(id: string): Promise<{ ok: true; id: string }> {
  return api<{ ok: true; id: string }>("DELETE", `/me/plugin-tokens/${encodeURIComponent(id)}`);
}

export function revokeAllPluginTokens(): Promise<{ ok: true; revoked: number }> {
  return api<{ ok: true; revoked: number }>("POST", "/me/plugin-tokens/revoke-all", {});
}