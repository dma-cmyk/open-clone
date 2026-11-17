"use client";

// `<PluginSlot>` — ページに適用されるプラグインを sandbox iframe で実行する。
// WP2 のレイアウト/スレ画面はこのコンポーネントを import するだけで良い。
// プラグイン未導入・API 未実装・停止済みでもスレ表示を壊さない（失敗時は何も描画しない）。

import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginActiveInstall, PluginSlotName } from "shared";
import { pluginApi, PluginApiError } from "./api";
import { useActiveInstalls } from "./active-installs";
import { type PluginBridge, createPluginBridge } from "./bridge";
import { buildSandboxCsp, PLUGIN_IFRAME_SANDBOX } from "./csp";
import { buildPluginSrcdoc } from "./bootstrap";
import { subscribePluginEvents } from "./events";
import { observeNearViewport } from "./lazy";
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
  /**
   * 画面に近づくまで sandbox iframe を作らない（レスごとのスロット用）。
   * レス数ぶん iframe を作らないための遅延起動。
   */
  lazy?: boolean;
  onNotify?: (message: string, level: string) => void;
}

interface ResolvedInstall {
  install: PluginActiveInstall;
  /** プラグインが宣言したスロット名（invoke のキー） */
  pluginSlot: PluginSlotName;
}

export function PluginSlot(props: PluginSlotProps) {
  // 取得はページ（板・スレ）単位で共有する。レスごとに API を呼ばない。
  const installs = useActiveInstalls({
    boardId: props.boardId,
    boardSlug: props.boardSlug,
    threadId: props.threadId,
  });
  const resolved = useMemo(() => {
    const list: ResolvedInstall[] = [];
    for (const install of installs) {
      const pluginSlot = resolveDeclaredSlot(install.manifest.slots, props.name);
      if (pluginSlot) list.push({ install, pluginSlot });
    }
    return list;
  }, [installs, props.name]);

  // 遅延起動: 画面（+400px）に近づくまで子を作らない。空の div はその監視点。
  const [nearView, setNearView] = useState(!props.lazy);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.lazy || nearView) return;
    const element = rootRef.current;
    if (!element) return;
    return observeNearViewport(element, () => setNearView(true));
  }, [props.lazy, nearView]);

  // そのスロットを宣言したプラグインが 1 つも無ければ DOM を増やさない。
  if (resolved.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={`oc-plugin-slot oc-plugin-slot-${props.name} ${props.className ?? ""}`}
      data-plugin-slot={props.name}
      data-plugin-post-id={props.postId}
      data-plugin-near={nearView ? "1" : "0"}
    >
      {nearView
        ? resolved.map(({ install, pluginSlot }) => (
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
          ))
        : null}
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