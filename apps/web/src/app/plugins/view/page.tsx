"use client";

// プラグイン詳細（公開・導入・更新・通報・停止・審査・GitHub 発行）

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginDetail, PluginInstallInfo, PluginReviewInfo, PluginScope } from "shared";
import { pluginApi } from "@/features/plugin-host";
import { parseTemplateOrigin } from "@/features/plugin-templates";
import {
  Badge,
  Card,
  Field,
  Notice,
  PluginShell,
  STATUS_LABEL,
  StatusBadge,
  errorText,
  formatTime,
  useQueryParam,
  ui,
} from "../_shared";

const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

interface BoardOption {
  id: number;
  slug: string;
  name: string;
}

export default function PluginViewPage() {
  const id = useQueryParam("id");
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [pendingReview, setPendingReview] = useState<PluginReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // B13: 未ログインかどうか（0 件を確定値として出さないための判定）
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  // B12: 板の選択（数値 ID の手入力ではなく名前と slug から選ぶ）
  const [boards, setBoards] = useState<BoardOption[]>([]);
  const [boardId, setBoardId] = useState("1");
  // B11: リンクのコピー状態
  const [copied, setCopied] = useState(false);
  // B11/M1: コピー失敗時の手動コピー用 URL（成功時に消える）
  const [copyUrl, setCopyUrl] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const [publishScopes, setPublishScopes] = useState<PluginScope[]>(["personal"]);
  const [reportReason, setReportReason] = useState("broken");
  const [reportDetail, setReportDetail] = useState("");
  const [repoTarget, setRepoTarget] = useState("");
  const [reviewNote, setReviewNote] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await pluginApi.detail(id);
      setDetail(loaded);
      setPublishScopes(loaded.manifest.scope);
      if (loaded.latestVersion) {
        try {
          setCode(await pluginApi.fetchCode(loaded.id, loaded.latestVersion));
        } catch {
          setCode(null);
        }
      }
      if (loaded.viewer.canReview && loaded.status === "pending") {
        try {
          const queue = await pluginApi.reviews({ status: "pending", scope: "site", limit: 100 });
          setPendingReview(queue.items.find((item) => item.pluginId === loaded.id) ?? null);
        } catch {
          setPendingReview(null);
        }
      } else {
        setPendingReview(null);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // B13: ログイン状態（作成・公開・板用/サイト導入の案内を出し分ける）。
  // B14: 個人用導入はログイン不要なので、ここで止めない。
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/v1/auth/session", { credentials: "include" });
        const json = (await response.json().catch(() => null)) as { ok?: boolean; data?: { authenticated?: boolean } } | null;
        setLoggedIn(Boolean(json?.ok && json.data?.authenticated));
      } catch {
        setLoggedIn(null);
      }
    })();
  }, []);

  // B12/R3: 板用インストールの対象は板 ID の数値入力ではなく板の選択にする。
  // API の板一覧は 1 回 200 件までのため、検索語（q）でサーバー検索できるようにする。
  // これで 200 件より古い管理対象板も名前・slug から探して選べる。
  const [boardQuery, setBoardQuery] = useState("");
  const [boardSearchState, setBoardSearchState] = useState<"loading" | "ready" | "error">("loading");
  const boardQuerySeq = useRef(0);

  async function searchBoards(query: string): Promise<void> {
    const seq = boardQuerySeq.current + 1;
    boardQuerySeq.current = seq;
    setBoardSearchState("loading");
    try {
      const search = new URLSearchParams({ limit: "200" });
      if (query.trim()) search.set("q", query.trim());
      const response = await fetch(`/api/v1/boards?${search.toString()}`, { credentials: "include" });
      const json = (await response.json().catch(() => null)) as {
        ok?: boolean;
        data?: { items?: Array<{ id?: unknown; slug?: unknown; name?: unknown }> };
      } | null;
      if (boardQuerySeq.current !== seq) return; // 古い応答は捨てる
      const items = json?.ok ? (json.data?.items ?? []) : [];
      const options = items
        .filter(
          (item): item is { id: number; slug: string; name: string } =>
            typeof item.id === "number" && typeof item.slug === "string" && typeof item.name === "string",
        )
        .map((item) => ({ id: item.id, slug: item.slug, name: item.name }));
      setBoards(options);
      // 選択中の板が結果に残っていれば維持し、なければ先頭を選ぶ
      setBoardId((prev) =>
        options.some((option) => String(option.id) === prev) || options.length === 0
          ? prev
          : String(options[0]!.id),
      );
      setBoardSearchState("ready");
    } catch {
      if (boardQuerySeq.current !== seq) return;
      setBoards([]);
      setBoardSearchState("error");
    }
  }

  useEffect(() => {
    void searchBoards("");
  }, []);
  async function run(action: () => Promise<string>, reload = true): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      setNotice(message);
      if (reload) await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const plugin = detail;
  // 作成元（report27 §5.4 / 29 決定 4）: changelog 先頭の `[template:<id>]` を解析するだけ。
  const templateOrigin = parseTemplateOrigin(
    plugin?.versions.find((version) => version.version === plugin.latestVersion)?.changelog,
  );
  const parsedBoardId = Number.parseInt(boardId, 10);
  const boardIdValid = Number.isInteger(parsedBoardId) && parsedBoardId > 0;
  // R1/R1-N: 作者以外の導入の件数（API の 409 判定と同じ規則・NULL 安全）。
  // 削除ボタンが押せるのは作者・管理者（canEdit）で、その視点では全導入が見える。
  // 「作者本人」は scope=personal・作者ID あり・installedBy が非 NULL で一致するものだけ。
  // owner=NULL（公式）は誰の導入も本人にならないため全て保護対象。
  const ownerId = plugin?.owner?.id ?? null;
  const foreignInstalls =
    plugin?.installs.filter(
      (install) =>
        !(
          install.scope === "personal" &&
          ownerId !== null &&
          install.installedBy !== null &&
          install.installedBy === ownerId
        ),
    ).length ?? 0;

  return (
    <PluginShell
      title={plugin ? plugin.name : "プラグイン詳細"}
      description={plugin?.summary ?? "読み込み中…"}
      actions={
        <>
          {/* B11: 共有リンク（URL コピー）UI（M1: 失敗時は手動コピー用の URL を出す） */}
          <button
            type="button"
            className="oc-btn"
            disabled={copied}
            onClick={() => {
              const url = `${window.location.origin}/plugins/view/?id=${encodeURIComponent(id ?? "")}`;
              void (async () => {
                let success = false;
                try {
                  await navigator.clipboard.writeText(url);
                  success = true;
                } catch {
                  // クリップボード拒否時は入力欄フォールバック（非対応ブラウザ対策）。
                  // execCommand の戻り値も見る（M1: 失敗を成功扱いにしない）。
                  const input = document.createElement("input");
                  input.value = url;
                  document.body.appendChild(input);
                  input.select();
                  success = document.execCommand("copy");
                  input.remove();
                }
                if (success) {
                  setCopyUrl(null);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2500);
                } else {
                  setCopyUrl(url);
                }
              })();
            }}
          >
            {copied ? "コピーしました" : copyUrl ? "コピーできませんでした" : "リンクをコピー"}
          </button>
          {copyUrl ? (
            <input
              className="oc-input oc-input-sm"
              readOnly
              value={copyUrl}
              aria-label="コピーできなかった場合の手動コピー用 URL"
              style={{ maxWidth: 240, fontSize: 11 }}
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
          <a href="/plugins/" className="oc-btn">
            一覧へ
          </a>
          {plugin?.viewer.canEdit ? (
            <>
              <a href={`/plugins/new/?id=${encodeURIComponent(plugin.id)}`} className="oc-btn">
                プレビュー（sandbox）
              </a>
              <a
                href={`/plugins/new/?id=${encodeURIComponent(plugin.id)}`}
                className="oc-btn oc-btn-primary"
              >
                新バージョンを作成
              </a>
            </>
          ) : null}
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {loading ? <p className="oc-muted oc-small">読み込み中…</p> : null}
      {!loading && !plugin && !error ? <Notice tone="warn">プラグインが見つかりません。</Notice> : null}

      {plugin ? (
        <>
          <Card title="基本情報">
            <div className="oc-row">
              <StatusBadge status={plugin.status} />
              <Badge>v{plugin.latestVersion ?? "-"}</Badge>
              <Badge>{STATUS_LABEL[plugin.visibility] ?? plugin.visibility}</Badge>
              <Badge>導入 {plugin.installCount}</Badge>
              <Badge>通報 {plugin.reportCount}</Badge>
              {plugin.source !== "local" ? <Badge>{plugin.source}</Badge> : null}
              {plugin.flagged ? <Badge tone="danger">要確認（通報あり）</Badge> : null}
              {templateOrigin ? <Badge>作成元: テンプレート {templateOrigin.label}</Badge> : null}
            </div>
            <p style={{ whiteSpace: "pre-wrap" }}>{plugin.description || plugin.summary}</p>
            <table style={{ fontSize: 12, color: "#444", borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ paddingRight: 12 }}>所有者</td>
                  <td>{plugin.owner ? plugin.owner.name : "(サイト)"}</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: 12 }}>スコープ</td>
                  <td>{plugin.scopes.join(", ")}</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: 12 }}>権限</td>
                  <td>{plugin.permissions.length > 0 ? plugin.permissions.join(", ") : "なし"}</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: 12 }}>スロット</td>
                  <td>{plugin.slots.length > 0 ? plugin.slots.join(", ") : "なし"}</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: 12 }}>作成 / 更新</td>
                  <td>
                    {formatTime(plugin.createdAt)} / {formatTime(plugin.updatedAt)}
                  </td>
                </tr>
                {plugin.sourceRef ? (
                  <tr>
                    <td style={{ paddingRight: 12 }}>取得元</td>
                    <td style={{ wordBreak: "break-all" }}>{plugin.sourceRef}</td>
                  </tr>
                ) : null}
                {templateOrigin ? (
                  <tr>
                    <td style={{ paddingRight: 12 }}>作成元</td>
                    <td>テンプレート「{templateOrigin.label}」（{templateOrigin.templateId}）</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>

          <Card title="インストール">
            <div style={{ ...ui.row, marginBottom: 8 }}>
              <button
                type="button"
                className="oc-btn oc-btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await pluginApi.install(plugin.id, { scope: "personal" });
                    return `個人用にインストールしました（v${result.install.version}）`;
                  })
                }
              >
                個人用にインストール
              </button>
              <span className="oc-muted oc-small">
                このブラウザにだけ適用されます（審査不要・ログインなしで使えます）
              </span>
            </div>

            <div style={{ ...ui.row, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px", maxWidth: 360 }}>
                <Field
                  label="板を探す"
                  hint="板名・slug の一部で絞り込み（200 件より古い板も見つかります）"
                >
                  <input
                    className="oc-input"
                    value={boardQuery}
                    placeholder="例: news / 雑談"
                    aria-label="板の検索語"
                    onChange={(event) => {
                      setBoardQuery(event.target.value);
                      void searchBoards(event.target.value);
                    }}
                  />
                </Field>
              </div>
              <div style={{ flex: "1 1 260px", maxWidth: 360 }}>
                <Field label="板を選ぶ" hint="板管理人（admin）のみ実行できます">
                  {boardSearchState === "loading" ? (
                    <select className="oc-input" disabled aria-label="板用インストールの対象板">
                      <option value="">板を読み込み中…</option>
                    </select>
                  ) : boardSearchState === "error" ? (
                    <select className="oc-input" disabled aria-label="板用インストールの対象板">
                      <option value="">板の取得に失敗しました。検索語を変えてください</option>
                    </select>
                  ) : boards.length === 0 ? (
                    <select className="oc-input" disabled aria-label="板用インストールの対象板">
                      <option value="">検索に一致する板がありません</option>
                    </select>
                  ) : (
                    <select
                      className="oc-input"
                      value={boardId}
                      onChange={(event) => setBoardId(event.target.value)}
                      aria-label="板用インストールの対象板"
                    >
                      {boards.map((board) => (
                        <option key={board.id} value={String(board.id)}>
                          {board.name}（/b/{board.slug}）
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <button
                type="button"
                className="oc-btn"
                disabled={busy || !boardIdValid || boardSearchState !== "ready" || boards.length === 0}
                onClick={() =>
                  void run(async () => {
                    const board = boards.find((item) => String(item.id) === boardId);
                    const result = await pluginApi.install(plugin.id, {
                      scope: "board",
                      boardId: parsedBoardId,
                    });
                    return `${board ? `板「${board.name}」` : `板 ${parsedBoardId}`} にインストールしました（v${result.install.version}）`;
                  })
                }
              >
                板用にインストール
              </button>
              {loggedIn === false ? (
                <span className="oc-muted oc-small">
                  <a href="/account/login">ログイン</a>すると板用インストールができます
                </span>
              ) : null}
            </div>

            <div style={{ ...ui.row, marginTop: 8 }}>
              <button
                type="button"
                className="oc-btn"
                disabled={busy || !plugin.viewer.isAdmin}
                onClick={() =>
                  void run(async () => {
                    const result = await pluginApi.install(plugin.id, { scope: "site" });
                    return `サイト全体にインストールしました（v${result.install.version}）`;
                  })
                }
              >
                サイト全体にインストール
              </button>
              <span className="oc-muted oc-small">owner / 特別管理人のみ・サイト審査の承認が必要です</span>
            </div>

            {plugin.status === "disabled" ? (
              <Notice tone="warn">
                このプラグインは全体停止（キルスイッチ）中です。個人用にインストールしても、停止が解除されるまで効果はありません。
              </Notice>
            ) : null}

            {plugin.installs.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <h3 style={{ fontSize: 13, margin: "0 0 4px" }}>導入状況</h3>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {plugin.installs.map((install) => (
                    <InstallRow
                      key={install.id}
                      install={install}
                      pluginStatus={plugin.status}
                      busy={busy}
                      onUpdate={() =>
                        void run(async () => {
                          const result = await pluginApi.update(plugin.id, {
                            scope: install.scope,
                            boardId: install.scope === "board" ? Number(install.scopeRef) : undefined,
                          });
                          return result.updated ? `v${result.install.version} に更新しました` : "最新です";
                        })
                      }
                      onUninstall={() =>
                        void run(async () => {
                          await pluginApi.uninstall(plugin.id, {
                            scope: install.scope,
                            boardId: install.scope === "board" ? Number(install.scopeRef) : undefined,
                          });
                          return "アンインストールしました（導入を削除）";
                        })
                      }
                      onToggle={() =>
                        void run(async () => {
                          // B6: 無効化は導入を残して enabled=0 にする（アンインストールとは別操作）
                          const input = {
                            scope: install.scope,
                            boardId: install.scope === "board" ? Number(install.scopeRef) : undefined,
                          };
                          if (install.enabled) {
                            await pluginApi.disableInstall(plugin.id, input);
                            return "無効化しました（導入は残ります。「有効化」で戻せます）";
                          }
                          await pluginApi.enableInstall(plugin.id, input);
                          return "有効化しました";
                        })
                      }
                    />
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          {plugin.viewer.canEdit ? (
            <Card title="公開・審査">
              <div className="oc-row">
                {(["personal", "board", "site"] as PluginScope[]).map((scope) => (
                  <label key={scope} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={publishScopes.includes(scope)}
                      onChange={() =>
                        setPublishScopes((prev) =>
                          prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope],
                        )
                      }
                    />
                    {scope === "personal" ? "個人用" : scope === "board" ? "板用" : "サイト全体"}
                  </label>
                ))}
                <button
                  type="button"
                  className="oc-btn oc-btn-primary"
                  disabled={busy || publishScopes.length === 0}
                  onClick={() =>
                    void run(async () => {
                      const result = await pluginApi.publish(plugin.id, {
                        scopes: publishScopes,
                        visibility: "public",
                      });
                      return result.needsReview
                        ? "公開申請しました（サイト審査の承認待ち）"
                        : "公開しました";
                    })
                  }
                >
                  公開申請
                </button>
              </div>
              <p className="oc-muted oc-small">
                個人用/板用のみなら即時公開。site を含むと審査キューに入り、owner / 特別管理人の承認後に公開されます。
              </p>
              <div className="oc-row">
                <button
                  type="button"
                  className="oc-btn oc-btn-sm"
                  disabled={busy || !code}
                  onClick={() =>
                    void run(async () => {
                      if (!code) return "コードを読み込めませんでした";
                      const result = await pluginApi.previewCheck(code, plugin.manifest);
                      return result.checks.allowed
                        ? `静的検査: 問題ありません（リスク ${result.checks.riskScore}）`
                        : `静的検査: 不合格 — ${result.checks.reasons.join(" / ")}`;
                    }, false)
                  }
                >
                  静的検査を再実行
                </button>
                <span className="oc-muted oc-small">
                  保存済みの最新コードを検査します（AI が作った下書きの確認用）
                </span>
              </div>

              {plugin.status === "pending" && pendingReview ? (
                <div className="oc-card" style={{ background: "#fffdf2" }}>
                  <div className="oc-row">
                    <Badge tone="warn">審査待ち</Badge>
                    <Badge>リスク: {RISK_LABEL[pendingReview.riskLevel ?? "low"]}</Badge>
                    <Badge>v{pendingReview.version}</Badge>
                  </div>
                  {pendingReview.staticResult ? (
                    <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 12 }}>
                      {pendingReview.staticResult.reasons.map((reason, index) => (
                        <li key={index}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  {plugin.viewer.isAdmin ? (
                    <div style={{ ...ui.row, alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <Field label="審査メモ">
                          <input
                            className="oc-input"
                            value={reviewNote}
                            onChange={(event) => setReviewNote(event.target.value)}
                          />
                        </Field>
                      </div>
                      <button
                        type="button"
                        className="oc-btn oc-btn-primary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await pluginApi.decideReview(plugin.id, {
                              decision: "approve",
                              note: reviewNote || undefined,
                              scope: "site",
                            });
                            return "承認しました（公開されました）";
                          })
                        }
                      >
                        承認
                      </button>
                      <button
                        type="button"
                        className="oc-btn oc-btn-danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await pluginApi.decideReview(plugin.id, {
                              decision: "reject",
                              note: reviewNote || undefined,
                              scope: "site",
                            });
                            return "却下しました";
                          })
                        }
                      >
                        却下
                      </button>
                    </div>
                  ) : (
                    <p className="oc-muted oc-small">サイト管理者の承認待ちです。</p>
                  )}
                </div>
              ) : null}

              <div style={{ ...ui.row, marginTop: 8 }}>
                <button
                  type="button"
                  className="oc-btn oc-btn-danger"
                  disabled={busy || plugin.status === "disabled"}
                  onClick={() =>
                    void run(async () => {
                      await pluginApi.disable(plugin.id, { reason: "所有者による停止" });
                      return "プラグインを停止しました（実行中のホストは kill を受けます）";
                    })
                  }
                >
                  停止（キルスイッチ）
                </button>
                <button
                  type="button"
                  className="oc-btn"
                  disabled={busy || plugin.status !== "disabled"}
                  onClick={() =>
                    void run(async () => {
                      await pluginApi.enable(plugin.id);
                      return "停止を解除しました";
                    })
                  }
                >
                  停止解除
                </button>
                <button
                  type="button"
                  className="oc-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const fork = await pluginApi.fork(plugin.id);
                      window.location.href = `/plugins/view/?id=${encodeURIComponent(fork.id)}`;
                      return "fork しました";
                    }, false)
                  }
                >
                  fork して複製
                </button>
                {/* B4: 削除は停止（キルスイッチ）とは別処理。確認ダイアログを挟む。 */}
                <button
                  type="button"
                  className="oc-btn oc-btn-danger"
                  disabled={busy}
                  onClick={() => setDeleteConfirm(true)}
                >
                  削除（レジストリから消す）
                </button>
              </div>

              {deleteConfirm ? (
                <div
                  className="oc-panel"
                  style={{ background: "#fff4f4", marginTop: 8 }}
                  role="alertdialog"
                  aria-label="プラグインの削除確認"
                >
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                    「{plugin.name}」を削除{foreignInstalls > 0 ? "できません" : "します"}。
                  </div>
                  {foreignInstalls > 0 ? (
                    <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                      このプラグインには作者以外の導入が {foreignInstalls}{" "}
                      件あります。削除すると導入している利用者にも影響するため、削除はできません。
                      <br />
                      代わりに「停止（キルスイッチ）」を使ってください（導入は残ったまま効果だけ止まります）。
                    </div>
                  ) : (
                    <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 12 }}>
                      <li>すべての導入（個人・板・サイト全体）から外れます</li>
                      <li>バージョン・審査記録・共有データも削除されます</li>
                      <li>削除したプラグインを元に戻すことはできません（もう一度作り直す必要があります）</li>
                    </ul>
                  )}
                  <div className="oc-row">
                    <button
                      type="button"
                      className="oc-btn oc-btn-danger"
                      disabled={busy || foreignInstalls > 0}
                      onClick={() =>
                        void run(async () => {
                          await pluginApi.remove(plugin.id);
                          window.location.href = "/plugins/";
                          return "削除しました";
                        }, false)
                      }
                    >
                      削除する
                    </button>
                    <button type="button" className="oc-btn" disabled={busy} onClick={() => setDeleteConfirm(false)}>
                      やめる
                    </button>
                  </div>
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card title="GitHub / Gist（任意）">
            <div className="oc-row">
              <button
                type="button"
                className="oc-btn"
                disabled={busy || !plugin.viewer.canEdit}
                onClick={() =>
                  void run(async () => {
                    const result = await pluginApi.exportGist(plugin.id, { public: true });
                    return `Gist に発行しました: ${result.htmlUrl}`;
                  })
                }
              >
                公開 Gist に発行
              </button>
              <button
                type="button"
                className="oc-btn"
                disabled={busy || !plugin.viewer.canEdit || plugin.source === "local"}
                onClick={() =>
                  void run(async () => {
                    const result = await pluginApi.sync(plugin.id);
                    return result.updated ? `v${result.version} を取り込みました（下書き）` : "最新です";
                  })
                }
              >
                取得元から同期
              </button>
            </div>
            <div style={{ ...ui.row, alignItems: "flex-end", marginTop: 8 }}>
              <div style={{ flex: 1 }}>
                <Field label="リポジトリへ push（owner/repo）">
                  <input
                    className="oc-input"
                    value={repoTarget}
                    placeholder="dma-cmyk/open-clone-plugins"
                    onChange={(event) => setRepoTarget(event.target.value)}
                  />
                </Field>
              </div>
              <button
                type="button"
                className="oc-btn"
                disabled={busy || !plugin.viewer.canEdit || !repoTarget.includes("/")}
                onClick={() =>
                  void run(async () => {
                    const [owner, repo] = repoTarget.split("/");
                    const result = await pluginApi.exportRepo(plugin.id, {
                      owner: owner ?? "",
                      repo: repo ?? "",
                      path: plugin.name,
                    });
                    return `push しました: ${result.written.join(", ")}`;
                  })
                }
              >
                リポジトリへ push
              </button>
            </div>
            <p className="oc-muted oc-small">
              GitHub 未連携の場合はエラーになりますが、サイト内の公開・検索・導入・更新は GitHub なしで完結します。
            </p>
          </Card>

          <Card title="通報">
            <div style={{ ...ui.row, alignItems: "flex-end" }}>
              <div style={{ width: 160 }}>
                <Field label="理由">
                  <select
                    className="oc-input"
                    value={reportReason}
                    onChange={(event) => setReportReason(event.target.value)}
                  >
                    <option value="malicious">悪意のあるコード</option>
                    <option value="spam">スパム</option>
                    <option value="broken">動作しない</option>
                    <option value="inappropriate">不適切</option>
                    <option value="other">その他</option>
                  </select>
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="詳細（任意）">
                  <input
                    className="oc-input"
                    value={reportDetail}
                    onChange={(event) => setReportDetail(event.target.value)}
                  />
                </Field>
              </div>
              <button
                type="button"
                className="oc-btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await pluginApi.report(plugin.id, {
                      reason: reportReason,
                      detail: reportDetail || undefined,
                    });
                    return "通報しました。運営が確認します";
                  })
                }
              >
                通報する
              </button>
            </div>
          </Card>

          <Card title="バージョン">
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {plugin.versions.map((version) => (
                <li key={version.version} style={{ borderTop: "1px solid #eee", padding: "6px 0" }}>
                  <div className="oc-row">
                    <strong>v{version.version}</strong>
                    <Badge tone={version.status === "approved" ? "ok" : version.status === "rejected" ? "danger" : "warn"}>
                      {STATUS_LABEL[version.status] ?? version.status}
                    </Badge>
                    <span className="oc-muted oc-small">{formatTime(version.createdAt)}</span>
                    <span className="oc-muted oc-small" style={{ fontFamily: "var(--oc-mono)" }}>
                      {version.codeHash.slice(0, 12)}
                    </span>
                  </div>
                  {version.changelog ? <div style={{ fontSize: 12 }}>{version.changelog}</div> : null}
                </li>
              ))}
              {plugin.versions.length === 0 ? <li className="oc-muted oc-small">公開済みバージョンはありません</li> : null}
            </ul>
          </Card>

          {code ? (
            <Card title="コード（最新）">
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "#555" }}>
                  {plugin.name} {plugin.latestVersion} のコードを表示
                </summary>
                <pre style={ui.code}>{code}</pre>
              </details>
            </Card>
          ) : null}
        </>
      ) : null}
    </PluginShell>
  );
}

function InstallRow(props: {
  install: PluginInstallInfo;
  /** プラグイン本体のレジストリ状態（B5: 全体停止中表示に使う） */
  pluginStatus: string;
  busy: boolean;
  onUpdate: () => void;
  onUninstall: () => void;
  onToggle: () => void;
}) {
  const { install } = props;
  const globallyDisabled = props.pluginStatus === "disabled";
  return (
    <li style={{ borderTop: "1px solid #eee", padding: "6px 0" }}>
      <div className="oc-row">
        <Badge>
          {install.scope === "personal"
            ? "個人用"
            : install.scope === "board"
              ? `板用 (${install.scopeRef})`
              : "サイト全体"}
        </Badge>
        <span>v{install.version}</span>
        {install.pinned ? <Badge tone="warn">固定</Badge> : null}
        {globallyDisabled ? (
          <Badge tone="danger">停止中（効果なし）</Badge>
        ) : (
          <Badge tone={install.enabled ? "ok" : "danger"}>{install.enabled ? "有効" : "無効"}</Badge>
        )}
        <button type="button" className="oc-btn" disabled={props.busy} onClick={props.onUpdate}>
          更新
        </button>
        <button type="button" className="oc-btn" disabled={props.busy} onClick={props.onToggle}>
          {/* B6/R2: 導入単位の有効・無効トグル。ラベルは常に実際の操作と一致させる。 */}
          {install.enabled ? "無効化" : "有効化"}
        </button>
        <button type="button" className="oc-btn oc-btn-danger" disabled={props.busy} onClick={props.onUninstall}>
          アンインストール
        </button>
      </div>
      {globallyDisabled ? (
        <div className="oc-muted oc-small">
          プラグイン全体が停止（キルスイッチ）中のため、この導入は
          {install.enabled
            ? "有効化されていますが効果がありません。停止が解除されれば自動的に効き始めます。"
            : "無効化されています。停止が解除されても自動では戻りません。必要に応じて「有効化」を押してください。"}
        </div>
      ) : null}
    </li>
  );
}