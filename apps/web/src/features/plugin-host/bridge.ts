// ホスト側ブリッジ（DESIGN §7.1）。
// - iframe の postMessage を検証（event.source / nonce / envelope）
// - manifest 権限に基づく RPC 許可判定（未宣言は PERMISSION_DENIED）
// - データ・storage・net・github・AI の各 RPC を API へ中継
// 純粋な権限判定とディスパッチャを export し、ユニットテスト可能にする。

import {
  PLUGIN_RPC_VERSION,
  pluginRpcRequestSchema,
  rpcPermissionFor,
  type PluginDraft,
  type PluginDraftPatch,
  type PluginManifest,
  type PluginPermission,
  type PluginRpcRequest,
  type PluginRpcResponse,
  type PluginScope,
} from "shared";
import { pluginApi, PluginApiError } from "./api";

export interface BridgeHandlers {
  onResize?(height: number): void;
  onTitle?(title: string): void;
  onNotify?(message: string, level: string): void;
  onUploadRequest?(): Promise<{ started: boolean; url?: string }>;
  /**
   * ai:complete を呼ぶ前の利用者同意。未指定なら拒否（権限だけでは外部送信しない）。
   * 実装はモーダル/confirm を出し、同意した場合だけ true を返す。
   */
  onAiConsent?(): Promise<boolean>;
  onLog?(args: string[]): void;
  onEventSubscribe?(topics: string[]): void;
}

export interface RpcHostContext {
  pluginId: string;
  version: string;
  manifest: PluginManifest;
  permissions: readonly PluginPermission[];
  scope: PluginScope;
  boardId?: number;
  threadId?: number;
  handlers: BridgeHandlers;
  /** プレビュー用のメソッド上書き（data.* をサンプルデータにする等） */
  overrides?: Record<string, (params: unknown) => Promise<unknown>>;
  /** true なら外部通信・API 呼び出しを行わない（エディタのプレビュー） */
  preview?: boolean;
}

export type RpcDecision =
  | { allowed: true; permission: PluginPermission | null }
  | { allowed: false; reason: string };

/** manifest 権限とメソッドから RPC の可否を決める（純粋関数）。 */
export function authorizeRpc(permissions: readonly PluginPermission[], method: string): RpcDecision {
  const required = rpcPermissionFor(method);
  if (required === undefined) {
    return { allowed: false, reason: `未知のメソッドです: ${method}` };
  }
  if (required === null) {
    return { allowed: true, permission: null };
  }
  if (!permissions.includes(required)) {
    return { allowed: false, reason: `権限 ${required} が宣言されていません` };
  }
  return { allowed: true, permission: required };
}

function errorResponse(id: string | number | null, code: string, message: string): PluginRpcResponse {
  return { v: PLUGIN_RPC_VERSION, id, ok: false, error: { code, message } };
}

function readString(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || !(key in params)) return undefined;
  const value: unknown = Reflect.get(params, key);
  return typeof value === "string" ? value : undefined;
}

function readNumber(params: unknown, key: string): number | undefined {
  if (!params || typeof params !== "object" || !(key in params)) return undefined;
  const value: unknown = Reflect.get(params, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(params: unknown, key: string): string[] {
  if (!params || typeof params !== "object" || !(key in params)) return [];
  const value: unknown = Reflect.get(params, key);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function requireString(params: unknown, key: string): string {
  const value = readString(params, key);
  if (value === undefined) throw new PluginApiError(400, "VALIDATION", `${key} が必要です`);
  return value;
}

/** プラグインの RPC を処理するディスパッチャを作る。 */
export function createRpcDispatcher(
  ctx: RpcHostContext,
): (request: PluginRpcRequest) => Promise<PluginRpcResponse> {
  const previewStore = new Map<string, string>();
  const scope = { scope: ctx.scope, boardId: ctx.boardId };

  async function handle(method: string, params: unknown): Promise<unknown> {
    const override = ctx.overrides?.[method];
    if (override) return override(params);

    switch (method) {
      case "handshake":
        return { ok: true };

      case "ui.resize": {
        const height = readNumber(params, "height");
        if (height !== undefined) ctx.handlers.onResize?.(Math.max(0, Math.min(height, 4000)));
        return null;
      }

      case "ui.setTitle": {
        const title = readString(params, "title");
        if (title) ctx.handlers.onTitle?.(title.slice(0, 200));
        return null;
      }

      case "log": {
        ctx.handlers.onLog?.(readStringArray(params, "args"));
        return null;
      }

      case "storage.get": {
        const key = requireString(params, "key");
        if (ctx.preview) return previewStore.get(key) ?? null;
        const result = await pluginApi.state.get(ctx.pluginId, scope, key);
        return result.value;
      }

      case "storage.set": {
        const key = requireString(params, "key");
        const value = requireString(params, "value");
        if (ctx.preview) {
          previewStore.set(key, value);
          return null;
        }
        await pluginApi.state.set(ctx.pluginId, scope, key, value);
        return null;
      }

      case "storage.delete": {
        const key = requireString(params, "key");
        if (ctx.preview) {
          previewStore.delete(key);
          return null;
        }
        await pluginApi.state.delete(ctx.pluginId, scope, key);
        return null;
      }

      case "storage.list": {
        if (ctx.preview) return Object.fromEntries(previewStore);
        const result = await pluginApi.state.list(ctx.pluginId, scope);
        return result.items;
      }

      case "data.thread.get": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューではスレ API を呼べません");
        const threadId = readNumber(params, "threadId") ?? ctx.threadId;
        if (threadId === undefined) throw new PluginApiError(400, "VALIDATION", "threadId が必要です");
        return pluginApi.threadGet(threadId);
      }

      case "data.posts.list": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューではスレ API を呼べません");
        const threadId = readNumber(params, "threadId") ?? ctx.threadId;
        if (threadId === undefined) throw new PluginApiError(400, "VALIDATION", "threadId が必要です");
        return pluginApi.postsList(threadId);
      }

      case "data.board.get": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューでは板 API を呼べません");
        const slug = readString(params, "slug");
        const boardId = readNumber(params, "boardId") ?? ctx.boardId;
        return pluginApi.boardGet({ slug, boardId });
      }

      case "data.post.create": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューでは投稿できません");
        const body = requireString(params, "body");
        return pluginApi.createPost({
          boardId: readNumber(params, "boardId") ?? ctx.boardId,
          threadId: readNumber(params, "threadId") ?? ctx.threadId ?? null,
          name: readString(params, "name"),
          mail: readString(params, "mail"),
          body,
        });
      }

      case "net.fetch": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューでは外部通信できません");
        const url = requireString(params, "url");
        const method = readString(params, "method") ?? "GET";
        const headers: Record<string, string> = {};
        if (params && typeof params === "object" && "headers" in params) {
          const raw: unknown = Reflect.get(params, "headers");
          if (raw && typeof raw === "object") {
            for (const [key, value] of Object.entries(raw)) {
              if (typeof value === "string") headers[key] = value;
            }
          }
        }
        return pluginApi.netFetch({
          pluginId: ctx.pluginId,
          version: ctx.version,
          scope: ctx.scope,
          boardId: ctx.boardId,
          url,
          method,
          headers,
          body: readString(params, "body"),
        });
      }

      case "upload.start": {
        if (!ctx.handlers.onUploadRequest) return { started: false };
        return ctx.handlers.onUploadRequest();
      }

      case "github.gist": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューでは GitHub 連携できません");
        return pluginApi.githubGist({
          filename: requireString(params, "filename"),
          content: requireString(params, "content"),
          description: readString(params, "description"),
          public: params && typeof params === "object" ? Reflect.get(params, "public") === true : false,
        });
      }

      case "github.repo": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューでは GitHub 連携できません");
        return pluginApi.githubPush({
          owner: requireString(params, "owner"),
          repo: requireString(params, "repo"),
          path: requireString(params, "path"),
          content: requireString(params, "content"),
          message: readString(params, "message"),
        });
      }

      case "events.subscribe": {
        ctx.handlers.onEventSubscribe?.(readStringArray(params, "topics"));
        return null;
      }

      case "notify": {
        const message = requireString(params, "message");
        ctx.handlers.onNotify?.(message.slice(0, 500), readString(params, "level") ?? "info");
        return null;
      }

      case "ai.complete": {
        if (ctx.preview) throw new PluginApiError(400, "PREVIEW", "プレビューでは AI 連携できません");
        const prompt = requireString(params, "prompt");
        const options: { system?: string; maxTokens?: number } = {};
        if (params && typeof params === "object" && "options" in params) {
          const raw: unknown = Reflect.get(params, "options");
          if (raw && typeof raw === "object") {
            const system: unknown = Reflect.get(raw, "system");
            const maxTokens: unknown = Reflect.get(raw, "maxTokens");
            if (typeof system === "string") options.system = system;
            if (typeof maxTokens === "number") options.maxTokens = maxTokens;
          }
        }
        // 権限宣言だけでは外部送信しない。利用者の明示同意（ホスト UI）を必須にする。
        if (!ctx.handlers.onAiConsent) {
          throw new PluginApiError(403, "CONSENT_REQUIRED", "AI 連携には利用者の同意が必要です");
        }
        if (!(await ctx.handlers.onAiConsent())) {
          throw new PluginApiError(403, "CONSENT_DENIED", "AI 連携が拒否されました");
        }
        return pluginApi.aiComplete({
          pluginId: ctx.pluginId,
          version: ctx.version,
          scope: ctx.scope,
          boardId: ctx.boardId,
          threadId: ctx.threadId,
          prompt,
          ...options,
          consent: true,
        });
      }

      default:
        throw new PluginApiError(400, "UNKNOWN_METHOD", `未知のメソッドです: ${method}`);
    }
  }

  return async function dispatch(request: PluginRpcRequest): Promise<PluginRpcResponse> {
    const decision = authorizeRpc(ctx.permissions, request.method);
    if (!decision.allowed) {
      return errorResponse(request.id, "PERMISSION_DENIED", decision.reason);
    }
    try {
      const result = await handle(request.method, request.params);
      return { v: PLUGIN_RPC_VERSION, id: request.id, ok: true, result };
    } catch (error) {
      if (error instanceof PluginApiError) {
        return errorResponse(request.id, error.code, error.message);
      }
      return errorResponse(
        request.id,
        "RPC_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

// ─── iframe ライフサイクル ────────────────────────────────────────

export interface PluginBridgeOptions extends RpcHostContext {
  iframe: HTMLIFrameElement;
  nonce?: string;
  onKill?(reason: string): void;
  onReady?(): void;
  onError?(message: string): void;
}

export interface PluginBridge {
  readonly ready: Promise<void>;
  /** iframe の load 後に init を送る（通常は自動） */
  start(): void;
  invoke(slot: string, data: unknown): void;
  sendEvent(type: string, event: unknown): void;
  beforePost(draft: PluginDraft): Promise<PluginDraftPatch | null>;
  kill(reason: string): void;
  destroy(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** window.setTimeout のハンドル（ブラウザ専用モジュール） */
  timer: number;
}

/** ホスト→プラグインの呼び出し（beforePost）の応答を検証する。 */
export function sanitizeDraftPatch(value: unknown): PluginDraftPatch | null {
  if (!value || typeof value !== "object") return null;
  const patch: PluginDraftPatch = {};
  for (const key of ["name", "mail", "body"] as const) {
    if (key in value) {
      const field: unknown = Reflect.get(value, key);
      if (typeof field === "string") patch[key] = field;
    }
  }
  if ("cancel" in value && Reflect.get(value, "cancel") === true) patch.cancel = true;
  return patch;
}

export function createPluginBridge(options: PluginBridgeOptions): PluginBridge {
  const nonce = options.nonce ?? crypto.randomUUID();
  const dispatch = createRpcDispatcher(options);
  const pending = new Map<number, PendingRequest>();
  const ready = Promise.withResolvers<void>();
  let readySettled = false;
  let seq = 0;
  let destroyed = false;

  const target = (): Window | null => options.iframe.contentWindow;

  function post(message: unknown): void {
    // sandbox="allow-scripts" の iframe は不透明オリジン（"null"）だが、postMessage の
    // targetOrigin に "null" は指定できない（有効な URL ではない）。防御は受信側の
    // event.source 同一性 + event.origin === "null" 検証で行う（L-4 / M-2）。
    target()?.postMessage(message, "*");
  }

  function settleReady(): void {
    if (readySettled) return;
    readySettled = true;
    ready.resolve();
    options.onReady?.();
  }

  function rejectAll(reason: string): void {
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function onMessage(event: MessageEvent): void {
    if (destroyed) return;
    // sandbox iframe の不透明オリジンは "null"。source の同一性に加えて origin も固定する
    // （defense-in-depth / M-2）。親ページ自身のメッセージは source が一致しないので弾かれる。
    if (event.origin !== "null") return;
    if (event.source !== target()) return;
    const raw: unknown = event.data;
    if (!raw || typeof raw !== "object") return;

    // ホスト→プラグイン要求への応答
    if ("ok" in raw && typeof Reflect.get(raw, "ok") === "boolean") {
      const id: unknown = Reflect.get(raw, "id");
      if (typeof id !== "number") return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      window.clearTimeout(entry.timer);
      if (Reflect.get(raw, "ok") === true) {
        entry.resolve(Reflect.get(raw, "result"));
      } else {
        const error: unknown = Reflect.get(raw, "error");
        const message =
          error && typeof error === "object" && typeof Reflect.get(error, "message") === "string"
            ? String(Reflect.get(error, "message"))
            : "プラグインでエラーが発生しました";
        entry.reject(new Error(message));
      }
      return;
    }

    const parsed = pluginRpcRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    const request = parsed.data;

    if (request.method === "handshake") {
      const received = readString(request.params, "nonce");
      if (received !== nonce) {
        options.onError?.("nonce が一致しません");
        kill("handshake-failed");
        return;
      }
      settleReady();
      post({ v: PLUGIN_RPC_VERSION, id: request.id, ok: true, result: { ok: true } });
      return;
    }

    void dispatch(request).then((response) => post(response));
  }

  function request(method: string, params: unknown, timeoutMs = 3000): Promise<unknown> {
    const id = ++seq;
    const deferred = Promise.withResolvers<unknown>();
    const timer = window.setTimeout(() => {
      if (pending.delete(id)) deferred.reject(new Error(`プラグイン応答がタイムアウトしました: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timer });
    post({ v: PLUGIN_RPC_VERSION, id, method, params });
    return deferred.promise;
  }

  function start(): void {
    if (destroyed) return;
    post({
      v: PLUGIN_RPC_VERSION,
      method: "init",
      params: {
        nonce,
        pluginId: options.pluginId,
        version: options.version,
        manifest: options.manifest,
        permissions: options.permissions,
        scope: options.scope,
        context: {
          pluginId: options.pluginId,
          version: options.version,
          scope: options.scope,
          boardId: options.boardId,
          threadId: options.threadId,
          path: typeof location === "undefined" ? undefined : location.pathname,
          account: null,
        },
      },
    });
  }

  function kill(reason: string): void {
    post({ v: PLUGIN_RPC_VERSION, method: "kill", params: { reason } });
    rejectAll("プラグインは停止されました");
    options.onKill?.(reason);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener("message", onMessage);
    rejectAll("ブリッジを破棄しました");
  }

  window.addEventListener("message", onMessage);
  options.iframe.addEventListener("load", start, { once: true });

  return {
    ready: ready.promise,
    start,
    invoke(slot: string, data: unknown): void {
      post({ v: PLUGIN_RPC_VERSION, method: "invoke", params: { slot, data } });
    },
    sendEvent(type: string, event: unknown): void {
      post({ v: PLUGIN_RPC_VERSION, method: "event", params: { type, event } });
    },
    async beforePost(draft: PluginDraft): Promise<PluginDraftPatch | null> {
      const result = await request("beforePost", { draft }, 3000);
      return sanitizeDraftPatch(result);
    },
    kill,
    destroy,
  };
}