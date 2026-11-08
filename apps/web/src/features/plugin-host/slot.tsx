"use client";

// `<PluginSlot>` — ページに適用されるプラグインを sandbox iframe で実行する。
// WP2 のレイアウト/スレ画面はこのコンポーネントを import するだけで良い。
// プラグイン未導入・API 未実装・停止済みでもスレ表示を壊さない（失敗時は何も描画しない）。

import { useEffect, useRef, useState } from "react";
import type { PluginActiveInstall, PluginSlotName } from "shared";
import { loadActiveInstalls, pluginApi, PluginApiError } from "./api";
import { type PluginBridge, createPluginBridge } from "./bridge";
import { buildSandboxCsp, PLUGIN_IFRAME_SANDBOX } from "./csp";
import { buildPluginSrcdoc } from "./bootstrap";
import { subscribePluginEvents } from "./events";
import { resolveDeclaredSlot } from "./slots";
import { PluginUploadDialog, type PluginUploadResult } from "./upload-dialog";

export interface PluginSlotProps {
  /** スロット名（manifest.slots と一致するものだけが実行される） */
  name: PluginSlotName;
  /** 板スコープのプラグインを解決するための板 ID */
  boardId?: number;
  boardSlug?: string;
  threadId?: number;
  postId?: number;
  /** スロット固有データ（レス単体なら { post } など） */
  data?: unknown;
  className?: string;
  /** 停止（キル）反映のための再取得間隔。0 で無効 */
  refreshIntervalMs?: number;
  onNotify?: (message: string, level: string) => void;
}

interface ResolvedInstall {
  install: PluginActiveInstall;
  /** プラグインが宣言したスロット名（invoke のキー） */
  pluginSlot: PluginSlotName;
}

export function PluginSlot(props: PluginSlotProps) {
  const [installs, setInstalls] = useState<ResolvedInstall[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await loadActiveInstalls({
          boardId: props.boardId,
          boardSlug: props.boardSlug,
          threadId: props.threadId,
        });
        if (cancelled) return;
        const resolved: ResolvedInstall[] = [];
        for (const install of response.items) {
          const pluginSlot = resolveDeclaredSlot(install.manifest.slots, props.name);
          if (pluginSlot) resolved.push({ install, pluginSlot });
        }
        setInstalls(resolved);
      } catch {
        // 未ログイン・API 未実装・ネットワーク失敗時はスロットを空にする
        if (!cancelled) setInstalls([]);
      }
    };
    void load();
    if (props.refreshIntervalMs === 0) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(load, props.refreshIntervalMs ?? 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.boardId, props.boardSlug, props.threadId, props.name, props.refreshIntervalMs]);

  if (installs.length === 0) return null;

  return (
    <div className={`oc-plugin-slot oc-plugin-slot-${props.name} ${props.className ?? ""}`} data-plugin-slot={props.name}>
      {installs.map(({ install, pluginSlot }) => (
        <PluginFrame
          key={`${install.installId}:${install.version}:${pluginSlot}`}
          install={install}
          slot={pluginSlot}
          boardId={props.boardId}
          threadId={props.threadId}
          postId={props.postId}
          data={props.data}
          onNotify={props.onNotify}
        />
      ))}
    </div>
  );
}

interface PluginFrameProps {
  install: PluginActiveInstall;
  slot: PluginSlotName;
  boardId?: number;
  threadId?: number;
  postId?: number;
  data?: unknown;
  onNotify?: (message: string, level: string) => void;
}

/** 同じデータでの再 invoke（DOM 重複の原因）を避けるための比較キー。 */
function invokeKey(data: unknown, postId: number | undefined): string | null {
  try {
    return JSON.stringify({ data, postId });
  } catch {
    return null;
  }
}

function PluginFrame(props: PluginFrameProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<PluginBridge | null>(null);
  const readyRef = useRef(false);
  const postIdRef = useRef(props.postId);
  postIdRef.current = props.postId;
  const lastPayloadRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadRequest, setUploadRequest] = useState<{ resolve: (result: PluginUploadResult) => void } | null>(null);
  const uploadPendingRef = useRef(false);

  const { install, slot } = props;
  const dataRef = useRef(props.data);
  dataRef.current = props.data;

  useEffect(() => {
    if (install.stopped) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setError(null);

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", PLUGIN_IFRAME_SANDBOX);
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("title", `${install.name} プラグイン`);
    iframe.style.cssText = "width:100%;border:0;display:block;height:0;background:transparent;overflow:hidden;";
    container.appendChild(iframe);

    const bridge = createPluginBridge({
      iframe,
      pluginId: install.pluginId,
      version: install.version,
      manifest: install.manifest,
      permissions: install.manifest.permissions,
      scope: install.scope,
      boardId: install.scope === "board" ? Number(install.scopeRef) : props.boardId,
      threadId: props.threadId,
      handlers: {
        onResize(height) {
          iframe.style.height = `${Math.max(0, height)}px`;
        },
        onNotify(message, level) {
          props.onNotify?.(message, level);
        },
        onLog(args) {
          console.debug(`[plugin:${install.name}]`, ...args);
        },
        onUploadRequest() {
          // 同時に複数の upload.start が来ても 1 つだけダイアログを開く。
          if (uploadPendingRef.current) return Promise.resolve({ started: false });
          uploadPendingRef.current = true;
          const { promise, resolve } = Promise.withResolvers<PluginUploadResult>();
          setUploadRequest({ resolve });
          return promise;
        },
        async onAiConsent() {
          if (typeof window === "undefined") return false;
          const key = `oc.pluginAiConsent.${install.pluginId}`;
          try {
            if (window.sessionStorage.getItem(key) === "1") return true;
          } catch {
            // sessionStorage 不可（プライベートモード等）の場合は都度確認する
          }
          const allowed = window.confirm(
            `プラグイン「${install.name}」が AI 連携を要求しています。入力内容はサイトの AI 接続先へ送信されます。許可しますか？`,
          );
          if (allowed) {
            try {
              window.sessionStorage.setItem(key, "1");
            } catch {
              // 保存できなくても同意自体は有効
            }
          }
          return allowed;
        },
        onEventSubscribe(topics) {
          if (!topics.includes("post") && !topics.includes("thread")) return;
          unsubscribe ??= subscribePluginEvents((event) => {
            bridgeRef.current?.sendEvent(event.type, event);
          });
        },
      },
      onError(message) {
        setError(message);
      },
    });
    bridgeRef.current = bridge;
    readyRef.current = false;
    lastPayloadRef.current = null;

    bridge.ready
      .then(() => {
        if (cancelled) return;
        readyRef.current = true;
        lastPayloadRef.current = invokeKey(dataRef.current, postIdRef.current);
        bridge.invoke(slot, { data: dataRef.current, postId: postIdRef.current ?? null });
      })
      .catch(() => {
        if (!cancelled) setError("プラグインの初期化に失敗しました");
      });

    pluginApi
      .fetchCode(install.pluginId, install.version)
      .then((code) => {
        if (cancelled) return;
        iframe.srcdoc = buildPluginSrcdoc({
          manifest: install.manifest,
          code,
          csp: buildSandboxCsp(install.manifest),
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof PluginApiError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : "コードの取得に失敗しました",
        );
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      readyRef.current = false;
      bridge.destroy();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
      iframe.remove();
    };
    // インストール/バージョン/スロットが変わったときだけ再マウントする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [install.installId, install.version, install.stopped, install.pluginId, install.name, slot]);

  // スロットデータの更新（新着レスなど）は再マウントせず invoke で通知する
  useEffect(() => {
    if (!readyRef.current) return;
    const key = invokeKey(props.data, props.postId);
    if (key !== null && key === lastPayloadRef.current) return;
    lastPayloadRef.current = key;
    bridgeRef.current?.invoke(slot, { data: props.data, postId: props.postId ?? null });
  }, [props.data, props.postId, slot]);

  return (
    <div data-plugin-id={install.pluginId} data-plugin-version={install.version}>
      <div ref={containerRef} />
      {error ? (
        <div style={{ color: "#b00020", fontSize: 12, padding: "2px 4px" }} role="status">
          {install.name}: {error}
        </div>
      ) : null}
      {uploadRequest ? (
        <PluginUploadDialog
          open
          pluginName={install.name}
          boardId={props.boardId}
          onDone={(result) => {
            uploadPendingRef.current = false;
            uploadRequest.resolve(result);
            setUploadRequest(null);
          }}
        />
      ) : null}
    </div>
  );
}