// アップローダアダプタのインターフェース（DESIGN §9.1）。
// 変更するときはアダプタ実装と WORKPACKAGES §3.4 の契約も合わせて更新する。

/** アップロード要求（prepare の入力） */
export interface UploadRequest {
  /** ファイルの MIME タイプ */
  contentType: string;
  /** バイト数（事前検証用） */
  size: number;
  /** 元ファイル名（拡張子推定用） */
  filename: string;
  /** 要求元の板（板設定の上書き判定用。サイト全体なら null） */
  boardId: number | null;
}

/** direct モード: ブラウザが外部サービスへ直接送信するための計画 */
export interface DirectPlan {
  mode: "direct";
  /** 送信先 URL */
  url: string;
  /** HTTP メソッド */
  method: "POST" | "PUT";
  /** 付与すべきヘッダ */
  headers?: Record<string, string>;
  /** multipart フィールド（form-data の場合） */
  formFields?: Record<string, string>;
  /** ファイルを入れるフィールド名 */
  fileField?: string;
}

/** proxy-stream モード: Worker が stream 中継するための計画 */
export interface ProxyPlan {
  mode: "proxy-stream";
  /** Worker の中継エンドポイント（/v1/uploads/proxy へのパス） */
  proxyPath: string;
}

export type UploadPlan = DirectPlan | ProxyPlan;

/** direct モード完了後の外部サービス応答（finalize の入力） */
export interface DirectResult {
  /** 外部サービスが返した生の応答テキスト/JSON */
  response: unknown;
}

/** 添付の確定メタデータ（D1 attachments 行に保存するのはこれだけ。本体は保存しない） */
export interface AttachmentMeta {
  /** 外部 URL（表示・DL に使用） */
  externalUrl: string;
  /** 削除用 URL/トークン（サービスが返す場合のみ） */
  deleteUrl?: string;
  contentType: string;
  size: number;
  /** サービス固有情報（hash 等） */
  meta?: Record<string, unknown>;
}

/** アダプタの実行コンテキスト（秘密情報・DB への入口は Worker 側が注入） */
export interface AdapterContext {
  /** adapter 設定（uploader_adapters.config。秘密変数の参照名のみ含む） */
  config: Record<string, unknown>;
  /** 環境変数/secret の取得（Worker のみ実体を持つ） */
  getSecret(name: string): string | undefined;
}

/**
 * アダプタ本体。`mode: 'direct'` はブラウザ直送、`'proxy-stream'` は Worker 中継。
 * いずれの場合も Cloudflare 側にファイル本体を保存してはならない（要件 §3）。
 */
export interface UploaderAdapter {
  /** 'catbox' | 'cloudinary' | 'gist' | 'github' | 'mock' | ... */
  readonly id: string;
  readonly mode: "direct" | "proxy-stream";
  readonly limits: { maxBytes: number; types: readonly string[] };
  /** 署名/preset/ヘッダの発行。 */
  prepare(req: UploadRequest, ctx: AdapterContext): Promise<UploadPlan>;
  /** 外部サービス応答 → AttachmentMeta 正規化。 */
  finalize(res: Response | DirectResult, ctx: AdapterContext): Promise<AttachmentMeta>;
  /** リンク死活確認（cron の WP4 handler から呼ぶ）。 */
  verify?(url: string, ctx: AdapterContext): Promise<boolean>;
}
