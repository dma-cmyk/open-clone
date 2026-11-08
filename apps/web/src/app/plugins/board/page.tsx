"use client";

// 板用プラグインの管理 UI（板管理人向け）
// 静的エクスポート制約（DESIGN §A-2）のため `/b/[slug]/plugins` ではなく
// `/plugins/board/?slug=<板スラッグ>` で板を指定する（板ページからリンクする）。

import { useCallback, useEffect, useState } from "react";
import { pluginApi } from "@/features/plugin-host";
import {
  Badge,
  Card,
  Field,
  Notice,
  PluginShell,
  errorText,
  formatTime,
  useQueryParam,
  ui,
} from "../_shared";

interface BoardInfo {
  id: number;
  slug: string;
  name: string;
}

interface BoardInstall {
  id: string;
  pluginId: string;
  name: string;
  scope: string;
  scopeRef: string;
  version: string;
  pinned: boolean;
  enabled: boolean;
  pluginStatus: string;
  manifest: { summary: string; slots: string[]; permissions: string[] };
  installedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export default function BoardPluginsPage() {
  const slugParam = useQueryParam("slug");
  const boardIdParam = useQueryParam("boardId");

  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [manualBoardId, setManualBoardId] = useState("");
  const [installs, setInstalls] = useState<BoardInstall[]>([]);
  const [pluginRef, setPluginRef] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const boardId = board?.id ?? (boardIdParam ? Number.parseInt(boardIdParam, 10) : null);

  // slug → 板情報（WP1 の /v1/boards/:slug を利用。未実装時は板 ID を手入力）
  useEffect(() => {
    if (!slugParam) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/boards/${encodeURIComponent(slugParam)}`, {
          credentials: "include",
        });
        const json: unknown = await response.json().catch(() => null);
        if (!response.ok || !json || typeof json !== "object") throw new Error(`板の取得に失敗しました（HTTP ${response.status}）`);
        const envelope = json as { ok?: boolean; data?: unknown };
        if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object") {
          throw new Error("板 API の応答が不正です");
        }
        const data = envelope.data as { id?: unknown; slug?: unknown; name?: unknown };
        if (typeof data.id !== "number") throw new Error("板 ID を取得できませんでした");
        if (!cancelled) {
          setBoard({
            id: data.id,
            slug: typeof data.slug === "string" ? data.slug : slugParam,
            name: typeof data.name === "string" ? data.name : slugParam,
          });
        }
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slugParam]);

  const load = useCallback(async () => {
    if (!boardId || !Number.isInteger(boardId)) {
      setInstalls([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await pluginApi.installed("board", boardId);
      setInstalls(response.items);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<string>): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <PluginShell
      title="板のプラグイン設定"
      description="板管理人は自板にプラグインを導入・停止できます（板用スコープ）。"
      actions={
        <a href="/plugins/" className="oc-btn">
          レジストリへ
        </a>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      <Card title="対象の板">
        {board ? (
          <p>
            <strong>{board.name}</strong>（slug: {board.slug} / ID: {board.id}）
          </p>
        ) : (
          <>
            <p className="oc-muted oc-small">
              板のスラッグ指定（?slug=）で板 API から解決します。解決できない場合は板 ID を入力してください。
            </p>
            <div style={{ ...ui.row, alignItems: "flex-end" }}>
              <div style={{ width: 160 }}>
                <Field label="板 ID">
                  <input
                    className="oc-input"
                    value={manualBoardId}
                    onChange={(event) => setManualBoardId(event.target.value)}
                  />
                </Field>
              </div>
              <button
                type="button"
                className="oc-btn"
                onClick={() => {
                  const id = Number.parseInt(manualBoardId, 10);
                  if (Number.isInteger(id) && id > 0) {
                    setBoard({ id, slug: slugParam ?? String(id), name: `板 ${id}` });
                  }
                }}
              >
                この板で設定する
              </button>
            </div>
          </>
        )}
      </Card>

      {boardId ? (
        <>
          <Card title="プラグインを導入">
            <div style={{ ...ui.row, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <Field label="プラグイン ID または名前">
                  <input
                    className="oc-input"
                    value={pluginRef}
                    placeholder="例: dice"
                    onChange={(event) => setPluginRef(event.target.value)}
                  />
                </Field>
              </div>
              <button
                type="button"
                className="oc-btn oc-btn-primary"
                disabled={!pluginRef.trim()}
                onClick={() =>
                  void run(async () => {
                    const result = await pluginApi.install(pluginRef.trim(), {
                      scope: "board",
                      boardId,
                    });
                    return `「${pluginRef.trim()}」を板に導入しました（v${result.install.version}）`;
                  })
                }
              >
                導入
              </button>
            </div>
            <p className="oc-muted oc-small">
              板用の導入には板管理人（admin）権限が必要です。導入操作は承認として記録されます。
            </p>
          </Card>

          <Card title={`この板のプラグイン（${installs.length}）`}>
            {loading ? <p className="oc-muted oc-small">読み込み中…</p> : null}
            {!loading && installs.length === 0 ? (
              <p className="oc-muted oc-small">この板に導入されたプラグインはありません。</p>
            ) : null}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {installs.map((install) => (
                <li key={install.id} style={{ borderTop: "1px solid #eee", padding: "8px 0" }}>
                  <div className="oc-row">
                    <a href={`/plugins/view/?id=${encodeURIComponent(install.pluginId)}`} style={{ fontWeight: 600 }}>
                      {install.name}
                    </a>
                    <Badge>v{install.version}</Badge>
                    <Badge tone={install.enabled ? "ok" : "danger"}>{install.enabled ? "有効" : "停止中"}</Badge>
                    {install.pluginStatus === "disabled" ? <Badge tone="danger">サイト全体で停止中</Badge> : null}
                    <span className="oc-muted oc-small">更新 {formatTime(install.updatedAt)}</span>
                  </div>
                  <div className="oc-muted oc-small">{install.manifest.summary}</div>
                  <div style={{ ...ui.row, marginTop: 4 }}>
                    <button
                      type="button"
                      className="oc-btn"
                      onClick={() =>
                        void run(async () => {
                          await pluginApi.disable(install.pluginId, {
                            reason: "板管理人による停止",
                            boardId,
                          });
                          return `「${install.name}」をこの板で停止しました`;
                        })
                      }
                    >
                      この板で停止
                    </button>
                    <button
                      type="button"
                      className="oc-btn oc-btn-danger"
                      onClick={() =>
                        void run(async () => {
                          await pluginApi.uninstall(install.pluginId, { scope: "board", boardId });
                          return `「${install.name}」を板から削除しました`;
                        })
                      }
                    >
                      アンインストール
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : (
        <Card title="板を指定してください">
          <p className="oc-muted oc-small">`/plugins/board/?slug=news` のように板スラッグを付けてアクセスしてください。</p>
        </Card>
      )}
    </PluginShell>
  );
}