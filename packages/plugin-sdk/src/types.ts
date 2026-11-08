// プラグイン SDK の公開型。
// manifest・権限・RPC の型は shared/schemas/plugin.ts を正本とし、ここではプラグイン作者向けの
// API 面（api.ui / data / storage / net / upload / github / events / notify / ai）を定義する。

import type {
  PluginAiOptions,
  PluginBoard,
  PluginDraft,
  PluginDraftPatch,
  PluginEvent,
  PluginEventTopic,
  PluginGistInput,
  PluginManifestInput,
  PluginManifest,
  PluginNetFetchResult,
  PluginNotifyOptions,
  PluginPermission,
  PluginPost,
  PluginRepoFileInput,
  PluginScope,
  PluginSlotName,
  PluginThread,
  PluginUploadOptions,
} from "shared";

export type {
  PluginAiOptions,
  PluginBoard,
  PluginDraft,
  PluginDraftPatch,
  PluginEvent,
  PluginEventTopic,
  PluginGistInput,
  PluginNotifyOptions,
  PluginPost,
  PluginRepoFileInput,
  PluginThread,
  PluginUploadOptions,
};

/** ホストから渡される実行コンテキスト。 */
export interface PluginContext {
  pluginId: string;
  version: string;
  scope: PluginScope;
  /** 個人用はスコープ参照（アカウント ID / 端末）が入る */
  scopeRef?: string;
  boardId?: number;
  boardSlug?: string;
  threadId?: number;
  postId?: number;
  /** 現在のページパス（ホストが渡す） */
  path?: string;
  account: { id: string; name: string } | null;
  /** テーマ（"light" | "dark"） */
  theme?: string;
}

/**
 * プラグインが利用できる API。すべてホストの bridge 経由で実行され、
 * manifest で宣言していない権限のメソッドは `PERMISSION_DENIED` で失敗する。
 */
export interface PluginApi {
  readonly plugin: { id: string; version: string; manifest: PluginManifest };
  readonly context: PluginContext;
  readonly permissions: readonly PluginPermission[];

  ui: {
    /** iframe の高さをホストへ通知する（自動計測も行われる）。 */
    resize(height: number): Promise<void>;
    /** スロット領域のタイトル（読み上げ用）。 */
    setTitle(title: string): Promise<void>;
  };

  data: {
    thread(threadId?: number): Promise<PluginThread | null>;
    board(target?: { slug?: string; boardId?: number }): Promise<PluginBoard | null>;
    posts(threadId: number): Promise<PluginPost[]>;
    createPost(draft: PluginDraft): Promise<{ postId: number; num: number }>;
  };

  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<Record<string, string>>;
  };

  net: {
    fetch(input: {
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
      headers?: Record<string, string>;
      body?: string;
    }): Promise<PluginNetFetchResult>;
  };

  upload: {
    start(options?: PluginUploadOptions): Promise<{ started: boolean; url?: string }>;
  };

  github: {
    createGist(input: PluginGistInput): Promise<{ htmlUrl: string; id: string }>;
    pushFile(input: PluginRepoFileInput): Promise<{ url?: string }>;
  };

  events: {
    subscribe(topics: PluginEventTopic[]): Promise<void>;
  };

  notify: {
    show(message: string, options?: PluginNotifyOptions): Promise<void>;
  };

  ai: {
    complete(prompt: string, options?: PluginAiOptions): Promise<{ text: string; model?: string }>;
  };

  /** コンソール（ホストのデバッグログへ） */
  log(...args: unknown[]): void;
}

export interface PluginSlotHandlerArgs<TData = unknown> {
  slot: PluginSlotName;
  data: TData;
  api: PluginApi;
  /** iframe 内の描画ルート（ここへ DOM を書く）。文字列 return でも良い */
  root: HTMLElement;
}

export type PluginSlotHandler<TData = unknown> = (
  args: PluginSlotHandlerArgs<TData>,
) => void | string | Promise<void | string>;

export interface PluginHooks {
  /** 投稿前フック: 下書きを検査・変換できる（本文はプレーンテキストのみ） */
  beforePost?(draft: PluginDraft, api: PluginApi): PluginDraftPatch | void | Promise<PluginDraftPatch | void>;
  /** レス描画後に呼ばれる（表示変換は manifest.render.post の宣言的規則を推奨） */
  onPostRendered?(post: PluginPost, api: PluginApi): void | Promise<void>;
}

export interface PluginDefinition {
  /** 開発時のみ。ホストは D1 の manifest を正とする。 */
  manifest?: PluginManifestInput;
  activate?(api: PluginApi): void | Promise<void>;
  slots?: Partial<Record<PluginSlotName, PluginSlotHandler>>;
  hooks?: PluginHooks;
  events?: Partial<Record<PluginEventTopic, (event: PluginEvent, api: PluginApi) => void>>;
  onKill?(reason: string): void;
}

/** サンドボックス内のグローバル `register`（ホストが提供する）。 */
export interface PluginGlobalRegistry {
  register(definition: PluginDefinition): void;
  plugin: PluginApi;
}

declare global {
  /** エントリースクリプトから呼ぶエントリポイント（ホストのブートストラップが定義する）。 */
  function register(definition: PluginDefinition): void;
  /** 初期化後に利用可能になる API（window.plugin 相当）。 */
  var plugin: PluginApi;
}