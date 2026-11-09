"use client";

// プラグインレジストリ（一覧・検索・導入・GitHub 取込）

import { useCallback, useEffect, useState } from "react";
import type { PluginActiveInstall, PluginScope, PluginSummary } from "shared";
import { pluginApi } from "@/features/plugin-host";
import {
  Badge,
  Card,
  Field,
  Notice,
  PluginShell,
  StatusBadge,
  errorText,
  formatTime,
  ui,
  useQueryParam,
} from "./_shared";

type Tab = "public" | "mine" | "installed";

export default function PluginsPage() {
  // `/account/plugin-tokens` の「AI が作った下書き」導線（報告書27 §5.4）は
  // `/plugins/?tab=mine` で mine タブを直接開く。
  const tabParameter = useQueryParam("tab");
  const [tab, setTab] = useState<Tab>("public");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"" | PluginScope>("");
  const [sort, setSort] = useState<"updated" | "popular" | "new">("updated");
  const [items, setItems] = useState<PluginSummary[]>([]);
  const [installed, setInstalled] = useState<PluginActiveInstall[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gist, setGist] = useState("");
  const [repo, setRepo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "installed") {
        const response = await pluginApi.active();
        setInstalled(response.items);
        setItems([]);
      } else {
        const page = await pluginApi.list({
          q: query || undefined,
          scope: scope || undefined,
          sort,
          limit: 50,
          mine: tab === "mine" ? true : undefined,
        });
        setItems(page.items);
        setInstalled([]);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [tab, query, scope, sort]);

  useEffect(() => {
    if (tabParameter === "mine" || tabParameter === "installed") setTab(tabParameter);
  }, [tabParameter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function installPersonal(plugin: PluginSummary) {
    setNotice(null);
    try {
      await pluginApi.install(plugin.id, { scope: "personal" });
      setNotice(`「${plugin.name}」を個人用にインストールしました（このブラウザに適用）`);
      await load();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function importGist() {
    setError(null);
    setNotice(null);
    try {
      const result = await pluginApi.importGist(gist.trim());
      setNotice(`Gist から「${result.name}」を取り込みました（下書き）`);
      setGist("");
      window.location.href = `/plugins/view/?id=${encodeURIComponent(result.id)}`;
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function importRepo() {
    setError(null);
    setNotice(null);
    try {
      const result = await pluginApi.importRepo(repo.trim());
      setNotice(`リポジトリから「${result.name}」を取り込みました（下書き）`);
      setRepo("");
      window.location.href = `/plugins/view/?id=${encodeURIComponent(result.id)}`;
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <PluginShell
      title="プラグイン"
      description="ユーザー製プラグインのレジストリ。作成・公開・検索・インストール・更新が GitHub 連携なしで完結します。"
      actions={
        <>
          <a href="/plugins/new/" className="oc-btn oc-btn-primary">
            プラグインを作成
          </a>
          <a href="/plugins/review/" className="oc-btn">
            審査キュー
          </a>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      <Card>
        <div style={{ ...ui.row, marginBottom: 8 }}>
          {(
            [
              ["public", "公開プラグイン"],
              ["mine", "自分のプラグイン"],
              ["installed", "導入済み"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={tab === key ? "oc-btn oc-btn-primary" : "oc-btn"}
            >
              {label}
            </button>
          ))}
        </div>

        {tab !== "installed" ? (
          <div style={{ ...ui.row, alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 240px" }}>
              <Field label="検索">
                <input
                  className="oc-input"
                  value={query}
                  placeholder="名前・説明で検索"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void load();
                  }}
                />
              </Field>
            </div>
            <div style={{ flex: "0 0 140px" }}>
              <Field label="スコープ">
                <select
                  className="oc-input"
                  value={scope}
                  onChange={(event) => setScope(event.target.value as "" | PluginScope)}
                >
                  <option value="">すべて</option>
                  <option value="personal">個人用</option>
                  <option value="board">板用</option>
                  <option value="site">サイト全体</option>
                </select>
              </Field>
            </div>
            <div style={{ flex: "0 0 140px" }}>
              <Field label="並び順">
                <select
                  className="oc-input"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as "updated" | "popular" | "new")}
                >
                  <option value="updated">更新順</option>
                  <option value="popular">人気順</option>
                  <option value="new">新着順</option>
                </select>
              </Field>
            </div>
            <button type="button" className="oc-btn oc-btn-primary" onClick={() => void load()}>
              検索
            </button>
          </div>
        ) : null}
      </Card>

      {loading ? <p className="oc-muted oc-small">読み込み中…</p> : null}

      {tab === "installed" ? (
        <Card title={`導入済み（${installed.length}）`}>
          {installed.length === 0 ? (
            <p className="oc-muted oc-small">導入済みのプラグインはありません。</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {installed.map((item) => (
                <li key={item.installId} style={{ borderTop: "1px solid #eee", padding: "8px 0" }}>
                  <div className="oc-row">
                    <a href={`/plugins/view/?id=${encodeURIComponent(item.pluginId)}`} style={{ fontWeight: 600 }}>
                      {item.name}
                    </a>
                    <Badge>{item.scope === "personal" ? "個人用" : item.scope === "board" ? `板用 (${item.scopeRef})` : "サイト全体"}</Badge>
                    <Badge>v{item.version}</Badge>
                    {item.stopped ? <Badge tone="danger">停止中</Badge> : <Badge tone="ok">有効</Badge>}
                  </div>
                  <div className="oc-muted oc-small">{item.manifest.summary}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card title={`${tab === "mine" ? "自分のプラグイン" : "公開プラグイン"}（${items.length}）`}>
          {items.length === 0 && !loading ? (
            <p className="oc-muted oc-small">
              該当するプラグインがありません。
              {tab === "mine" ? "「プラグインを作成」から最初のプラグインを作れます。" : null}
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {items.map((plugin) => (
                <li key={plugin.id} style={{ borderTop: "1px solid #eee", padding: "10px 0" }}>
                  <div style={{ ...ui.row, justifyContent: "space-between" }}>
                    <div>
                      <a
                        href={`/plugins/view/?id=${encodeURIComponent(plugin.id)}`}
                        style={{ fontWeight: 600, fontSize: 15 }}
                      >
                        {plugin.name}
                      </a>{" "}
                      <StatusBadge status={plugin.status} />
                      {plugin.flagged ? <Badge tone="danger">通報あり</Badge> : null}
                      {plugin.source !== "local" ? <Badge>{plugin.source}</Badge> : null}
                    </div>
                    <div className="oc-row">
                      <button type="button" className="oc-btn" onClick={() => void installPersonal(plugin)}>
                        個人用に導入
                      </button>
                    </div>
                  </div>
                  <div style={{ margin: "2px 0" }}>{plugin.summary}</div>
                  <div className="oc-muted oc-small">
                    v{plugin.latestVersion ?? "-"} / 導入 {plugin.installCount} / 更新 {formatTime(plugin.updatedAt)}
                    {plugin.scopes.length > 0 ? ` / ${plugin.scopes.join(", ")}` : ""}
                    {plugin.permissions.length > 0 ? ` / 権限: ${plugin.permissions.join(", ")}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="GitHub / Gist から取り込む（任意）">
        <p className="oc-muted oc-small">
          公開 Gist または公開リポジトリ（manifest.json + plugin.js）から下書きとして取り込めます。
          GitHub を使わなくても、このサイト内で作成・公開・共有できます。
        </p>
        <div style={{ ...ui.row, alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 320px" }}>
            <Field label="Gist URL / ID">
              <input
                className="oc-input"
                value={gist}
                placeholder="https://gist.github.com/user/abcdef123456"
                onChange={(event) => setGist(event.target.value)}
              />
            </Field>
          </div>
          <button type="button" className="oc-btn" onClick={() => void importGist()} disabled={!gist.trim()}>
            Gist から取り込む
          </button>
        </div>
        <div style={{ ...ui.row, alignItems: "flex-end", marginTop: 8 }}>
          <div style={{ flex: "1 1 320px" }}>
            <Field label="リポジトリ（owner/repo または URL）">
              <input
                className="oc-input"
                value={repo}
                placeholder="dma-cmyk/open-clone-plugin-example"
                onChange={(event) => setRepo(event.target.value)}
              />
            </Field>
          </div>
          <button type="button" className="oc-btn" onClick={() => void importRepo()} disabled={!repo.trim()}>
            リポジトリから取り込む
          </button>
        </div>
      </Card>
    </PluginShell>
  );
}