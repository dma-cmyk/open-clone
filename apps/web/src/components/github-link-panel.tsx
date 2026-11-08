"use client";

// GitHub 連携パネル（任意連携。OAuth App Web flow + PKCE / fine-grained PAT / 解除）。
// WP6 の `app/account/github/page.tsx` が `<GithubLinkPanel />` として差し込む。props なしで動作する。
// トークンは API 側で AES-256-GCM 暗号化して D1 に保存され、ブラウザには一切返らない。

import type { GithubLinkStatus } from "shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

class GithubPanelError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GithubPanelError";
    this.status = status;
    this.code = code;
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
    });
  } catch (cause) {
    throw new GithubPanelError(0, "NETWORK", cause instanceof Error ? cause.message : "ネットワークエラー");
  }
  let json: Envelope | null = null;
  try {
    json = (await response.json()) as Envelope;
  } catch {
    json = null;
  }
  if (!json || typeof json.ok !== "boolean") {
    throw new GithubPanelError(response.status, "INVALID_RESPONSE", `API 応答が不正です（HTTP ${response.status}）`);
  }
  if (!json.ok) {
    throw new GithubPanelError(response.status, json.code ?? "UNKNOWN", json.message ?? "エラーが発生しました");
  }
  return json.data as T;
}

function formatReset(reset: number): string {
  if (!Number.isFinite(reset) || reset <= 0) return "-";
  const date = new Date(reset * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatLinkedAt(seconds: number | null): string {
  if (!seconds) return "-";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return "処理に失敗しました";
}

const SCOPES_NOTE = "必要な権限は gist（Gist の作成・更新）と public_repo（公開リポジトリへのコミット）だけです。";

export interface GithubLinkPanelProps {
  className?: string;
  /** 連携状態が変わったときに通知する（WP6 側の表示更新用） */
  onStatusChange?: (status: GithubLinkStatus) => void;
}

export function GithubLinkPanel({ className, onStatusChange }: GithubLinkPanelProps) {
  const [status, setStatus] = useState<GithubLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"oauth" | "pat" | "unlink" | "callback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pat, setPat] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const startedRef = useRef(false);

  const applyStatus = useCallback(
    (next: GithubLinkStatus) => {
      setStatus(next);
      onStatusChange?.(next);
    },
    [onStatusChange],
  );

  const refresh = useCallback(async () => {
    try {
      applyStatus(await call<GithubLinkStatus>("GET", "/github/link"));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  const completeOAuth = useCallback(
    async (code: string, state: string) => {
      setBusy("callback");
      setError(null);
      try {
        const next = await call<GithubLinkStatus>("POST", "/github/oauth/callback", { code, state });
        applyStatus(next);
        setNotice("GitHub アカウントを連携しました。");
      } catch (cause) {
        setError(`連携を完了できませんでした: ${messageOf(cause)}`);
      } finally {
        setBusy(null);
        setLoading(false);
      }
    },
    [applyStatus],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");
    const description = params.get("error_description");
    if (oauthError) {
      setError(
        oauthError === "access_denied"
          ? "GitHub 側で連携がキャンセルされました。"
          : `GitHub が連携を拒否しました（${oauthError}${description ? `: ${description}` : ""}）`,
      );
      window.history.replaceState({}, "", window.location.pathname);
      void refresh();
      return;
    }
    if (code && state) {
      window.history.replaceState({}, "", window.location.pathname);
      void completeOAuth(code, state);
      return;
    }
    void refresh();
  }, [completeOAuth, refresh]);

  const startOAuth = async () => {
    setBusy("oauth");
    setError(null);
    try {
      const data = await call<{ authorizeUrl: string }>("GET", "/github/oauth/start");
      window.location.assign(data.authorizeUrl);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(null);
    }
  };

  const submitPat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = pat.trim();
    if (token.length < 20) {
      setError("トークンの形式が正しくありません（20 文字以上）。");
      return;
    }
    setBusy("pat");
    setError(null);
    try {
      applyStatus(await call<GithubLinkStatus>("POST", "/github/link/pat", { token }));
      setPat("");
      setNotice("fine-grained PAT で連携しました。");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const unlink = async () => {
    setBusy("unlink");
    setError(null);
    try {
      applyStatus(await call<GithubLinkStatus>("DELETE", "/github/link"));
      setNotice("GitHub 連携を解除しました。保存済みの Gist / リポジトリは GitHub 側に残ります。");
      setConfirmUnlink(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className={className ?? "oc-card"}>
        <div className="oc-loading">GitHub 連携状態を確認中…</div>
      </div>
    );
  }

  const rate = status?.rate ?? null;
  const rateLow = rate !== null && rate.remaining <= 10;

  return (
    <div className={className ?? "oc-stack"} style={{ gap: 10 }}>
      {error ? (
        <div className="oc-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="oc-ok" role="status">
          {notice}
        </div>
      ) : null}

      {status?.linked ? (
        <div className="oc-card">
          <div className="oc-row-between">
            <div className="oc-inline" style={{ gap: 8, alignItems: "center" }}>
              {status.avatarUrl ? (
                        <img
                  src={status.avatarUrl}
                  alt=""
                  width={36}
                  height={36}
                  style={{ borderRadius: "50%", border: "1px solid var(--oc-border)" }}
                />
              ) : null}
              <div className="oc-stack" style={{ gap: 2 }}>
                <strong>
                  <a href={`https://github.com/${status.login ?? ""}`} target="_blank" rel="noreferrer noopener">
                    @{status.login ?? "unknown"}
                  </a>
                </strong>
                <span className="oc-note">
                  連携方式: {status.method === "pat" ? "fine-grained PAT" : "OAuth App（PKCE）"}／連携日時:{" "}
                  {formatLinkedAt(status.linkedAt)}
                </span>
              </div>
            </div>
            <span className="oc-badge oc-badge-green">連携中</span>
          </div>

          <div className="oc-mt oc-note">
            権限:{" "}
            {status.scopes.length > 0 ? (
              status.scopes.map((scope) => (
                <span key={scope} className="oc-badge oc-badge-gray" style={{ marginRight: 4 }}>
                  {scope}
                </span>
              ))
            ) : (
              <span>未確認（fine-grained PAT は権限一覧を返しません）</span>
            )}
          </div>

          <div className="oc-mt">
            <div className="oc-row-between">
              <span className="oc-note">API レート残</span>
              <span className="oc-note">
                {rate ? (
                  <>
                    {rate.remaining} / {rate.limit}（{formatReset(rate.reset)} に回復）
                  </>
                ) : (
                  "未取得"
                )}
              </span>
            </div>
            {rate ? (
              <div style={{ height: 4, background: "var(--oc-border)", marginTop: 3 }} aria-hidden>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, Math.round((rate.remaining / Math.max(1, rate.limit)) * 100))}%`,
                    background: rateLow ? "var(--oc-danger)" : "var(--oc-accent)",
                  }}
                />
              </div>
            ) : null}
            {rateLow ? (
              <div className="oc-warn-box oc-mt">
                レート残が少ないため、Gist / リポジトリ操作は一時停止されます（設計上の安全マージン 10 リクエスト）。
              </div>
            ) : null}
          </div>

          <div className="oc-mt oc-row" style={{ gap: 6 }}>
            <button
              type="button"
              className="oc-btn oc-btn-sm"
              onClick={() => void refresh()}
              disabled={busy !== null}
            >
              状態を再取得
            </button>
            {confirmUnlink ? (
              <>
                <button type="button" className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => void unlink()} disabled={busy !== null}>
                  {busy === "unlink" ? "解除中…" : "本当に解除する"}
                </button>
                <button type="button" className="oc-btn oc-btn-sm" onClick={() => setConfirmUnlink(false)} disabled={busy !== null}>
                  やめる
                </button>
              </>
            ) : (
              <button type="button" className="oc-btn oc-btn-sm" onClick={() => setConfirmUnlink(true)} disabled={busy !== null}>
                連携解除
              </button>
            )}
          </div>
          {confirmUnlink ? (
            <div className="oc-warn-box oc-mt">
              解除すると Gist / リポジトリへの保存ができなくなります（保存済みのデータは GitHub 側に残ります）。
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="oc-card">
            <div className="oc-panel-title">GitHub OAuth で連携</div>
            <p className="oc-note" style={{ marginTop: 4 }}>
              ブラウザで GitHub の認可画面を開き、{SCOPES_NOTE}
              トークンは暗号化して保存され、画面には表示されません。
            </p>
            {status && !status.oauthAvailable ? (
              <div className="oc-warn-box">
                このサーバーでは GitHub OAuth App が未設定のため、下の fine-grained PAT で連携してください。
              </div>
            ) : null}
            <button
              type="button"
              className="oc-btn oc-btn-primary oc-mt"
              onClick={() => void startOAuth()}
              disabled={busy !== null || (status !== null && !status.oauthAvailable)}
            >
              {busy === "oauth" ? "GitHub へ移動中…" : "GitHub で連携する"}
            </button>
            <p className="oc-note oc-mt">
              連携は任意です。連携しなくても、掲示板への投稿・閲覧・アップロード（Catbox 等）は全て利用できます。
            </p>
          </div>

          <details className="oc-card">
            <summary style={{ cursor: "pointer" }}>fine-grained PAT を持ち込んで連携する</summary>
            <div className="oc-mt oc-note">
              <ol style={{ margin: "4px 0 8px 18px", padding: 0 }}>
                <li>
                  GitHub の{" "}
                  <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer noopener">
                    新しい fine-grained token
                  </a>{" "}
                  を開く
                </li>
                <li>
                  リポジトリの Contents に <b>Read and write</b>、アカウント権限の Gists に <b>Read and write</b> を付与
                </li>
                <li>発行されたトークンを下に貼り付けて登録（このサイト以外では使えません）</li>
              </ol>
              <form onSubmit={(event) => void submitPat(event)} className="oc-row" style={{ gap: 6, flexWrap: "wrap" }}>
                <input
                  type="password"
                  className="oc-input"
                  value={pat}
                  onChange={(event) => setPat(event.target.value)}
                  placeholder="github_pat_… または ghp_…"
                  autoComplete="off"
                  spellCheck={false}
                  style={{ minWidth: 260, flex: "1 1 260px" }}
                  disabled={busy !== null}
                />
                <button type="submit" className="oc-btn oc-btn-primary" disabled={busy !== null || pat.trim().length < 20}>
                  {busy === "pat" ? "確認中…" : "登録"}
                </button>
              </form>
              <p style={{ marginTop: 6 }}>
                トークンは AES-256-GCM で暗号化して D1 に保存し、GitHub への操作（Gist 作成・リポジトリへのコミット）以外には使いません。
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export default GithubLinkPanel;