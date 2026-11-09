"use client";

// エディタ用のその場プレビュー。
// 保存前のコードを sandbox iframe で実行する。preview=true のため API 呼び出しは行わず、
// data.* はサンプルデータ、storage はメモリ内で完結する。

import { useEffect, useRef, useState } from "react";
import type { PluginManifest, PluginSlotName } from "shared";
import { createPluginBridge } from "./bridge";
import { buildPluginSrcdoc } from "./bootstrap";
import { buildSandboxCsp, PLUGIN_IFRAME_SANDBOX } from "./csp";
import { SAMPLE_BOARD, SAMPLE_POSTS, SAMPLE_THREAD } from "./sample";

export interface PluginPreviewProps {
  manifest: PluginManifest | null;
  code: string;
  /** この値が変わるたびに再実行する（「プレビュー実行」ボタンで ++） */
  runId: number;
  slot?: PluginSlotName;
  data?: unknown;
  onNotify?: (message: string, level: string) => void;
  onLog?: (args: string[]) => void;
  minHeight?: number;
}

type PreviewStatus = "idle" | "running" | "ready" | "error";

export function PluginPreview(props: PluginPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(props.minHeight ?? 64);

  useEffect(() => {
    const current = latest.current;
    const container = containerRef.current;
    if (!container) return;
    if (!current.manifest) {
      setStatus("error");
      setError("manifest が不正です");
      return;
    }
    if (!current.code.trim()) {
      setStatus("error");
      setError("コードが空です");
      return;
    }

    setStatus("running");
    setError(null);
    let cancelled = false;
    const minHeight = current.minHeight ?? 64;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", PLUGIN_IFRAME_SANDBOX);
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", "プラグイン プレビュー");
    // 中身がボタン 1 つだけの slot（定型レス等）でも、resize が来る前から見えるよう
    // iframe 自体にも最低の高さを持たせる（UI Low-1）。容器側の minHeight だけでは
    // iframe が height:0 のまま中身が見えない。
    iframe.style.cssText = `width:100%;border:0;display:block;height:${minHeight}px;background:transparent;overflow:hidden;`;
    container.appendChild(iframe);

    const bridge = createPluginBridge({
      iframe,
      pluginId: `preview-${current.manifest.name}`,
      version: current.manifest.version,
      manifest: current.manifest,
      permissions: current.manifest.permissions,
      scope: "personal",
      preview: true,
      overrides: {
        "data.thread.get": async () => SAMPLE_THREAD,
        "data.posts.list": async () => SAMPLE_POSTS,
        "data.board.get": async () => SAMPLE_BOARD,
      },
      handlers: {
        onResize(value) {
          iframe.style.height = `${Math.max(minHeight, value)}px`;
          setHeight(Math.max(minHeight, value));
        },
        onNotify(message, level) {
          current.onNotify?.(message, level);
        },
        onLog(args) {
          current.onLog?.(args);
        },
      },
      onError(message) {
        setError(message);
        setStatus("error");
      },
    });

    bridge.ready
      .then(() => {
        if (cancelled) return;
        setStatus("ready");
        bridge.invoke(current.slot ?? "thread-post-inline", {
          data: current.data ?? { post: SAMPLE_POSTS[1] },
          preview: true,
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "プレビューに失敗しました");
      });

    iframe.srcdoc = buildPluginSrcdoc({
      manifest: current.manifest,
      code: current.code,
      csp: buildSandboxCsp(current.manifest),
    });

    return () => {
      cancelled = true;
      bridge.destroy();
      iframe.remove();
    };
  }, [props.runId]);

  return (
    <div className="oc-plugin-preview">
      <div ref={containerRef} style={{ minHeight: props.minHeight ?? 64 }} />
      <div className="oc-note" style={{ padding: "2px 4px" }}>
        {status === "idle" ? "「プレビュー実行」で sandbox 内でコードを実行します。" : null}
        {status === "running" ? "プレビュー実行中…" : null}
        {status === "ready" ? `プレビュー実行完了（高さ ${height}px）` : null}
        {status === "error" && error ? <span style={{ color: "var(--oc-danger)" }}>{error}</span> : null}
      </div>
    </div>
  );
}