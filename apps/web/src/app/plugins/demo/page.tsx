"use client";

// スレ表示へのプラグイン反映デモ
// WP2 のスレ画面が `<PluginSlot>` と `applyPostRenderRules` を組み込む前でも、
// 実際のホスト実装（sandbox iframe + 宣言的レンダー規則）が動くことを確認できる。

import { useEffect, useMemo, useState } from "react";
import type { PluginActiveInstall } from "shared";
import {
  PluginRenderStyles,
  PluginSlot,
  applyPostRenderRules,
  pluginApi,
  SAMPLE_POSTS,
} from "@/features/plugin-host";
import { Badge, Card, Notice, PluginShell, errorText, useQueryParam, ui } from "../_shared";

export default function PluginDemoPage() {
  const boardIdParam = useQueryParam("boardId");
  const boardId = boardIdParam ? Number.parseInt(boardIdParam, 10) : undefined;
  const [installs, setInstalls] = useState<PluginActiveInstall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await pluginApi.active({
          boardId: Number.isInteger(boardId) ? boardId : undefined,
          threadId: 1001,
        });
        if (!cancelled) setInstalls(response.items);
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const renderRuleSets = useMemo(
    () =>
      installs
        .filter((install) => !install.stopped)
        .map((install) => install.manifest.render?.post ?? [])
        .filter((rules) => rules.length > 0),
    [installs],
  );

  const activeNames = installs.filter((install) => !install.stopped).map((install) => install.name);

  return (
    <PluginShell
      title="スレ表示デモ（プラグイン反映）"
      description="インストール済みプラグインによる投稿表示変換とスロット描画を、実際のホスト実装で確認できます。"
      actions={
        <a href="/plugins/" className="oc-btn">
          プラグインを導入
        </a>
      }
    >
      <PluginRenderStyles />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notices.length > 0 ? (
        <Notice tone="ok">{notices.join("\n")}</Notice>
      ) : null}

      <Card title="実行中のプラグイン">
        {activeNames.length > 0 ? (
          <div className="oc-row">
            {activeNames.map((name) => (
              <Badge key={name} tone="ok">
                {name}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="oc-muted oc-small">
            有効なプラグインがありません。`/plugins/` から公式サンプル（spoiler / dice / gallery）を個人用に導入してください。
          </p>
        )}
        <p className="oc-muted oc-small">
          宣言的レンダー規則: {renderRuleSets.reduce((total, rules) => total + rules.length, 0)} 件 / スロット描画:{" "}
          {installs.length} インストール
        </p>
        {boardId ? <p className="oc-muted oc-small">板スコープ解決: boardId={boardId}</p> : null}
      </Card>

      <Card title="スレッド表示（サンプル）">
        <PluginSlot
          name="thread-head"
          boardId={Number.isInteger(boardId) ? boardId : undefined}
          threadId={1001}
          data={{ threadId: 1001, boardId: 1, boardSlug: "demo" }}
          onNotify={(message, level) => setNotices((prev) => [`[${level}] ${message}`, ...prev].slice(0, 5))}
        />

        <div className="oc-surface" style={{ marginTop: 8 }}>
          <div style={{ color: "var(--oc-title)", fontWeight: 600, marginBottom: 6 }}>【速報】テストスレッド</div>
          {SAMPLE_POSTS.map((post) => {
            const rules = renderRuleSets.flat();
            const rendered = applyPostRenderRules(post.body, rules);
            const transformed = rendered.matched;
            return (
              <article
                key={post.num}
                style={{ borderTop: "1px solid var(--oc-border)", padding: "6px 0", fontSize: 13 }}
                data-post-num={post.num}
              >
                <div style={{ ...ui.row, alignItems: "baseline" }}>
                  <strong style={{ color: "var(--oc-name)" }}>{post.num}</strong>
                  <span>{post.name}</span>
                  {transformed ? <Badge tone="ok">表示変換</Badge> : null}
                </div>
                {transformed ? (
                  // applyPostRenderRules の出力はすべてエスケープ済み（キャプチャ・テンプレート含む）
                  <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap" }}>{post.body}</div>
                )}
                <PluginSlot
                  name="thread-post-inline"
                  boardId={Number.isInteger(boardId) ? boardId : undefined}
                  threadId={1001}
                  postId={post.id}
                  data={{ post }}
                  onNotify={(message, level) =>
                    setNotices((prev) => [`[${level}] ${message}`, ...prev].slice(0, 5))
                  }
                />
                <PluginSlot
                  name="thread-post-footer"
                  boardId={Number.isInteger(boardId) ? boardId : undefined}
                  threadId={1001}
                  postId={post.id}
                  data={{ post }}
                  onNotify={(message, level) =>
                    setNotices((prev) => [`[${level}] ${message}`, ...prev].slice(0, 5))
                  }
                />
              </article>
            );
          })}
        </div>
        <p className="oc-note">
          このページは WP2 のスレ画面と同じコンポーネント（`&lt;PluginSlot&gt;` / `applyPostRenderRules`）を使っています。
          スレ画面本体（/b/&lt;slug&gt;/t/&lt;id&gt;）にも組み込み済みのため、実スレでも同じ変換が適用されます。
        </p>
      </Card>
    </PluginShell>
  );
}