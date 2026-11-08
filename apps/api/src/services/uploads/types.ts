// アップローダのサーバ側内部契約。
// 公開 IF は shared の `UploaderAdapter`（DESIGN §9.1）。ここでは Worker 固有の
// 「ストリーム中継」「外部削除」「URL ホスト検証」を追加した内部拡張を定義する。

import type {
  AdapterContext,
  AttachmentMeta,
  DirectPlan,
  DirectResult,
  ProxyPlan,
  UploadRequest,
  UploaderAdapter,
} from "shared";
import type { Env } from "../../lib/env";
import type { GithubConnection } from "../github/types";

/** proxy-stream の上流リクエスト。multipart 指定時は Worker が境界を組んでストリーム連結する。 */
export interface UpstreamTarget {
  url: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  /** 生ボディ送信時の Content-Type（multipart 指定時は無視） */
  contentType?: string;
  /** multipart/form-data で送る場合のフィールド。body は req.body をそのまま連結する。 */
  multipart?: {
    fields: Record<string, string>;
    fileField: string;
    filename: string;
    contentType: string;
  };
}

/** direct の応答解釈方法（ブラウザに返すので prepare の plan に含める）。 */
export type DirectResultType = "json" | "text";

export type ServerDirectPlan = DirectPlan & {
  resultType?: DirectResultType;
  maxBytes: number;
};
export type ServerProxyPlan = ProxyPlan & { maxBytes: number };
export type ServerUploadPlan = ServerDirectPlan | ServerProxyPlan;

/** アダプタ実行時に Worker が注入するリクエストスコープの情報。 */
export interface UploadRuntime {
  env: Env;
  db: D1Database;
  /** ログイン済みなら account id（未ログインは null） */
  accountId: string | null;
  /** HMAC(ID_SALT, device)。匿名の履歴・削除権限の判定に使う */
  deviceHash: string;
  /** 解決済み GitHub 連携（gist/github アダプタのみ。トークンはメモリ上だけ） */
  github?: GithubConnection | null;
  /** チケット情報（proxy / commit 時） */
  ticket?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    boardId: number | null;
    purpose: string | null;
  };
}

export interface ServerAdapterContext extends AdapterContext {
  runtime: UploadRuntime;
}

/**
 * サーバ実装用アダプタ。`prepare` の戻り値だけ shared の `UploadPlan` より具体的。
 * 追加アダプタは `registerUploaderAdapter()` で登録できる（プラグイン拡張点）。
 */
export interface ServerUploaderAdapter extends Omit<UploaderAdapter, "prepare" | "finalize"> {
  readonly label: string;
  /** 添付の保持期間（秒）。恒久は null */
  readonly retentionSeconds: number | null;
  /** 連携済み GitHub アカウントが必須か */
  readonly requiresGithub: boolean;
  /** commit 時に保存を許可する外部 URL のホスト（完全一致） */
  readonly allowedHosts: readonly string[];
  /** 設定依存の許可ホスト（宣言的アダプタ等）。あれば allowedHosts より優先。 */
  allowedHostsFor?(ctx: ServerAdapterContext): readonly string[];
  prepare(req: UploadRequest, ctx: ServerAdapterContext): Promise<ServerUploadPlan>;
  /** direct モード / proxy の上流応答をメタに変換する。handleProxy を持つアダプタでは不要。 */
  finalize?(res: Response | DirectResult, ctx: ServerAdapterContext): Promise<AttachmentMeta>;
  /** 設定が揃っていて使用可能か */
  isAvailable(ctx: ServerAdapterContext): boolean;
  /** 使用不可の理由（UI 表示用） */
  unavailableReason?(ctx: ServerAdapterContext): string;
  /** proxy-stream: ストリーム中継先。multipart を組む場合は multipart を指定 */
  upstream?(req: UploadRequest, ctx: ServerAdapterContext): UpstreamTarget | Promise<UpstreamTarget>;
  /**
   * proxy-stream: Worker がボディを読み切ってから外部 API を呼ぶアダプタ（Gist / GitHub Contents）。
   * 1MB 以下のテキスト専用（上限は limits.maxBytes で保証する）。
   */
  handleProxy?(
    request: Request,
    req: UploadRequest,
    ctx: ServerAdapterContext,
  ): Promise<AttachmentMeta>;
  /** 外部サービス側の削除（API が許す場合のみ。失敗しても D1 メタは削除する） */
  remove?(meta: AttachmentMeta, ctx: ServerAdapterContext): Promise<void>;
}

export const isServerUploaderAdapter = (value: unknown): value is ServerUploaderAdapter => {
  if (typeof value !== "object" || value === null) return false;
  const adapter = value as Partial<ServerUploaderAdapter>;
  return (
    typeof adapter.id === "string" &&
    (adapter.mode === "direct" || adapter.mode === "proxy-stream") &&
    typeof adapter.prepare === "function" &&
    (typeof adapter.finalize === "function" || typeof adapter.handleProxy === "function") &&
    Array.isArray(adapter.allowedHosts) &&
    typeof adapter.isAvailable === "function"
  );
};