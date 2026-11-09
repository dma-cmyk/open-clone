"use client";

// プラグイン作成トークン（`/account/plugin-tokens`）。
// 発行（step-up 必須・平文は 1 回だけ）/ 一覧 / 失効 / 全失効 / 接続手順 / 注意書き。
// 画面・文言は報告書27 §5.2〜5.6、API は報告書28 §4.6 が正本。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  PLUGIN_TOKEN_MAX_PER_ACCOUNT,
  PLUGIN_TOKEN_TTL_DAYS,
  type PluginAuthorTokenCreateResponse,
  type PluginAuthorTokenSummary,
  type TotpStatus,
} from "shared";
import { ApiRequestError, api, errorMessage } from "../../../features/account/api";
import {
  createPluginToken,
  listPluginTokens,
  revokeAllPluginTokens,
  revokePluginToken,
} from "../../../features/account/plugin-tokens-api";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

/** API の公開オリジン（決定9）。未設定なら vercel.json のプロキシ先と同じ。 */
const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_ORIGIN ?? "https://open-clone-api.dma-cmyk.workers.dev"
).replace(/\/$/, "");
const MCP_URL = `${API_ORIGIN}/mcp-plugin`;
const MCP_LEGACY_URL = `${API_ORIGIN}/mcp-plugin/legacy`;

type GuideTab = "claude" | "chatgpt" | "generic" | "verify";

const GUIDE_TABS: { key: GuideTab; label: string }[] = [
  { key: "claude", label: "Claude Code" },
  { key: "chatgpt", label: "ChatGPT" },
  { key: "generic", label: "その他の MCP クライアント" },
  { key: "verify", label: "動作確認" },
];

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="oc-btn oc-btn-sm"
      onClick={() => {
        navigator.clipboard
          ?.writeText(props.text)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? "コピーしました" : (props.label ?? "コピー")}
    </button>
  );
}

function CodeBlock(props: { text: string; label?: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div className="oc-row-between">
        <span className="oc-small oc-muted">{props.label ?? "コマンド"}</span>
        <CopyButton text={props.text} />
      </div>
      <pre
        style={{
          background: "#1e1e1e",
          color: "#e6e6e6",
          padding: 10,
          borderRadius: "var(--oc-radius)",
          fontSize: 12,
          fontFamily: "var(--oc-mono)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: "4px 0 0",
        }}
      >
        {props.text}
      </pre>
    </div>
  );
}

export default function PluginTokensPage() {
  const { state, loading } = useSession();
  const [totp, setTotp] = useState<TotpStatus | null>(null);
  const [tokens, setTokens] = useState<PluginAuthorTokenSummary[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<PluginAuthorTokenCreateResponse | null>(null);
  const [guideTab, setGuideTab] = useState<GuideTab>("claude");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gate = useStepUp(setError);

  const loadTokens = useCallback(async () => {
    setTokens(await listPluginTokens());
  }, []);

  useEffect(() => {
    if (!state?.authenticated) return;
    api<{ totp: TotpStatus }>("GET", "/accounts/me")
      .then((data) => setTotp(data.totp))
      .catch((err) => setError(errorMessage(err)));
    loadTokens().catch((err) => setError(errorMessage(err)));
  }, [state, loadTokens]);

  if (loading) return <div className="oc-loading">読み込み中…</div>;
  if (!state?.authenticated) {
    return (
      <div className="oc-warn-box">
        ログインが必要です。<Link href="/account/login">ログイン</Link>
      </div>
    );
  }

  const totpEnabled = totp?.enabled === true;

  const issue = async () => {
    setError(null);
    setMessage(null);
    await gate.run(async () => {
      setBusy(true);
      try {
        const data = await createPluginToken(name.trim() || undefined);
        setCreated(data);
        setName("");
        setGuideTab("claude");
        await loadTokens();
      } catch (err) {
        // 報告書27 §5.2 の文言（上限・頻度超過）
        if (err instanceof ApiRequestError && err.status === 409) {
          setError(`トークンが上限（${PLUGIN_TOKEN_MAX_PER_ACCOUNT} 本）です。不要なものを失効してから発行してください。`);
          return;
        }
        if (err instanceof ApiRequestError && err.status === 429) {
          setError("発行が多すぎます。しばらくしてからお試しください。");
          return;
        }
        throw err;
      } finally {
        setBusy(false);
      }
    });
  };

  const revoke = async (token: PluginAuthorTokenSummary) => {
    if (!window.confirm(`「${token.name}」を失効しますか？この操作は取り消せません。`)) return;
    setError(null);
    setMessage(null);
    try {
      await revokePluginToken(token.id);
      setMessage(`「${token.name}」を失効しました。`);
      await loadTokens();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const revokeAll = async () => {
    if (!window.confirm("すべてのプラグイン作成トークンを失効しますか？他の端末のトークンも全て無効になります。")) {
      return;
    }
    setError(null);
    setMessage(null);
    await gate.run(async () => {
      setBusy(true);
      try {
        const result = await revokeAllPluginTokens();
        setMessage(`${result.revoked} 本のトークンを失効しました。`);
        await loadTokens();
      } finally {
        setBusy(false);
      }
    });
  };

  const tokenForGuide = created?.token ?? "ocp_xxxxxxxx";
  const claudeCommand = `claude mcp add --transport http open-clone-plugins \\\n  ${MCP_LEGACY_URL} \\\n  --header "Authorization: Bearer ${tokenForGuide}"`;
  const genericJson = JSON.stringify(
    {
      mcpServers: {
        "open-clone-plugins": {
          type: "http",
          url: MCP_LEGACY_URL,
          headers: { Authorization: `Bearer ${tokenForGuide}` },
        },
      },
    },
    null,
    2,
  );

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="oc-stack">
      {gate.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>プラグイン作成トークン</h1>
      <p className="oc-small" style={{ margin: 0 }}>
        自分の AI（Claude Code など）から、自分専用のプラグインを作らせるための鍵です。
        このトークンでできるのは<strong>あなたのプラグインの作成〜個人導入まで</strong>
        です。投稿や他人のプラグイン操作はできません。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      {totp !== null && !totpEnabled ? (
        <div className="oc-warn-box">
          トークン発行には二段階認証（TOTP）が必要です。先に設定してください。
          <div style={{ marginTop: 6 }}>
            <Link className="oc-btn oc-btn-sm" href="/account/totp">
              TOTP を設定する
            </Link>
          </div>
        </div>
      ) : null}

      <section className="oc-card">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>トークンを発行する</h2>
        <ul className="oc-small" style={{ margin: "0 0 8px", paddingLeft: 20 }}>
          <li>
            できること: 自分の下書きの作成・版追加・取得・一覧、静的チェック、personal/board 公開、
            site 公開の<strong>申請</strong>（審査止まり）、personal への導入
          </li>
          <li>できないこと: 投稿、板/サイトへの導入、審査の承認、他人のプラグイン操作、トークン発行そのもの</li>
        </ul>
        <div className="oc-field" style={{ maxWidth: 420 }}>
          <label className="oc-label" htmlFor="token-name">
            識別名（任意）
          </label>
          <input
            id="token-name"
            className="oc-input"
            value={name}
            maxLength={100}
            placeholder="例: 自宅の Claude Code"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="oc-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="oc-btn oc-btn-primary"
            disabled={busy || !totpEnabled}
            onClick={() => void issue()}
          >
            {busy ? "発行中…" : "発行する"}
          </button>
          <span className="oc-muted oc-small">
            同時に有効なのは {PLUGIN_TOKEN_MAX_PER_ACCOUNT} 本まで・有効期限は {PLUGIN_TOKEN_TTL_DAYS} 日です。
          </span>
        </div>

        {created ? (
          <div className="oc-warn-box" style={{ marginTop: 10 }}>
            <div className="oc-row-between">
              <strong>このトークンは再表示できません。今すぐコピーして安全な場所に保存してください。</strong>
              <CopyButton text={created.token} />
            </div>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "6px 0" }}>{created.token}</pre>
            <div className="oc-small">
              識別名: {created.name} / 期限: {formatDate(created.expiresAt)}
            </div>
            <div className="oc-row" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="oc-btn oc-btn-sm"
                onClick={() => {
                  setCreated(null);
                  setMessage("トークンを閉じました（一覧には prefix のみ表示されます）。");
                }}
              >
                保存したので閉じる
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="oc-card">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>接続手順</h2>
        <p className="oc-small oc-muted" style={{ marginTop: 0 }}>
          API ベース URL: <code>{API_ORIGIN}</code>
        </p>
        <div className="oc-row" style={{ marginBottom: 8 }}>
          {GUIDE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={guideTab === tab.key ? "oc-btn oc-btn-sm oc-btn-primary" : "oc-btn oc-btn-sm"}
              onClick={() => setGuideTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {guideTab === "claude" ? (
          <div>
            <CodeBlock text={claudeCommand} label="ターミナルで実行" />
            <p className="oc-small" style={{ margin: "6px 0 0" }}>
              <code>ocp_xxxxxxxx</code> をこの画面の値に置き換えてターミナルで実行します。
              2026-07-28 対応のクライアントなら末尾を <code>/mcp-plugin</code> に変えられます。
            </p>
          </div>
        ) : null}

        {guideTab === "chatgpt" ? (
          <div className="oc-warn-box">
            <strong>現在は未対応です。</strong>
            <p className="oc-small" style={{ margin: "6px 0 0" }}>
              ChatGPT のカスタムコネクタで Bearer ヘッダーによる MCP 認証が使えることを確認できていないため、
              このサイトでは ChatGPT の接続手順を案内していません。Claude Code など、
              Bearer ヘッダーを設定できる MCP クライアントをご利用ください。
            </p>
          </div>
        ) : null}

        {guideTab === "generic" ? (
          <div>
            <CodeBlock text={genericJson} label="MCP クライアントの設定（JSON）" />
            <p className="oc-small" style={{ margin: "6px 0 0" }}>
              <code>type: &quot;http&quot;</code> と <code>Authorization</code> ヘッダーを設定できる
              MCP クライアントで利用できます。URL は 2026-07-28 対応なら <code>{MCP_URL}</code> でも構いません。
            </p>
          </div>
        ) : null}

        {guideTab === "verify" ? (
          <div className="oc-stack">
            <p className="oc-small" style={{ margin: 0 }}>
              接続できたら、AI に「テンプレート一覧を見せて」（<code>authoring.list_templates</code>）と
              伝えてください。一覧が返れば接続成功です。
            </p>
            <ul className="oc-small" style={{ margin: 0, paddingLeft: 20 }}>
              <li>401: トークンの値が違う / 失効済み / 期限切れ</li>
              <li>403: Origin が許可されていない、またはアカウント停止中</li>
              <li>429: 回数の上限（30 回/分・日次上限）</li>
            </ul>
            <div>
              <div className="oc-row-between">
                <span className="oc-small oc-muted">AI に頼むときのプロンプト例</span>
                <CopyButton
                  text={
                    "おーぷんクローンのプラグインを作りたいです。まず authoring.list_templates でテンプレート一覧を取得し、" +
                    "ネタバレ伏せプラグインを authoring.create_draft で下書き作成してください。" +
                    "作成前に必ず authoring.check で静的検査を通し、不合格なら直してください。" +
                    "site 公開は人間の審査が必要なことを承知しています。"
                  }
                />
              </div>
              <pre
                style={{
                  background: "var(--oc-surface)",
                  border: "1px solid var(--oc-border)",
                  padding: 8,
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  margin: "4px 0 0",
                }}
              >
                おーぷんクローンのプラグインを作りたいです。まず authoring.list_templates でテンプレート一覧を取得し、
                ネタバレ伏せプラグインを authoring.create_draft で下書き作成してください。作成前に必ず
                authoring.check で静的検査を通し、不合格なら直してください。site 公開は人間の審査が必要なことを
                承知しています。
              </pre>
            </div>
          </div>
        ) : null}
      </section>

      <section className="oc-card">
        <div className="oc-row-between">
          <h2 style={{ fontSize: 15, margin: 0 }}>発行済みのトークン</h2>
          <button
            type="button"
            className="oc-btn oc-btn-sm oc-btn-danger"
            disabled={busy || tokens.length === 0}
            onClick={() => void revokeAll()}
          >
            すべて失効
          </button>
        </div>
        <p className="oc-small oc-muted" style={{ margin: "4px 0 0" }}>
          他の端末のトークンも全て無効になります（TOTP 再認証が必要です）。
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>識別名</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>prefix</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>作成日</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>期限</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>最終使用</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>状態</th>
              <th style={{ borderBottom: "1px solid var(--oc-border)", padding: 4 }} />
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => {
              const expired = token.expired === true || token.expiresAt <= now;
              const soon = !expired && token.expiresAt - now <= 7 * 86_400;
              const revoked = token.status === "revoked";
              return (
                <tr key={token.id}>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{token.name}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", fontFamily: "var(--oc-mono)" }}>
                    {token.prefix}…
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    {formatDate(token.createdAt)}
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    {formatDate(token.expiresAt)}
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    {token.lastUsedAt ? formatDate(token.lastUsedAt) : "未使用"}
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    {revoked ? (
                      <span className="oc-badge oc-badge-gray">失効済み</span>
                    ) : expired ? (
                      <span className="oc-badge oc-badge-red">期限切れ</span>
                    ) : soon ? (
                      <span className="oc-badge oc-badge-yellow">まもなく失効</span>
                    ) : (
                      <span className="oc-badge oc-badge-green">有効</span>
                    )}
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", textAlign: "right" }}>
                    {revoked ? null : (
                      <button
                        type="button"
                        className="oc-btn oc-btn-sm oc-btn-danger"
                        onClick={() => void revoke(token)}
                      >
                        失効
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {tokens.length === 0 ? (
              <tr>
                <td colSpan={7} className="oc-empty">
                  まだトークンがありません。上の［発行する］で作成してください。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="oc-card">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>AI が作った下書きの確認</h2>
        <p className="oc-small" style={{ marginTop: 0 }}>
          AI が作成した下書きは「自分のプラグイン」に表示されます。コード・静的検査・プレビューを確認してから、
          自分用に導入・公開してください。サイト全体への公開は必ず人間の審査待ちになります。
        </p>
        <Link className="oc-btn oc-btn-sm" href="/plugins/?tab=mine">
          自分のプラグイン（下書き）を開く
        </Link>
      </section>

      <section className="oc-card oc-small">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>トークンの取り扱い</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            トークン（<code>ocp_...</code>）は<strong>あなた自身のパスワードと同じ</strong>です。
            この画面で 1 回しか表示されません。
          </li>
          <li>
            AI の設定ファイルやチャットに貼り付けたトークンは、その AI 事業者の環境に保存されます。
            信頼できるツールにだけ設定してください。
          </li>
          <li>
            <strong>漏らした/漏れたかもしれない場合</strong>: すぐにこの画面で［失効］（または［すべて失効］）してください。
            失効するとそのトークンは即座に使えなくなります。被害が疑われる場合はパスワード変更と［すべて失効］を
            併用してください。
          </li>
          <li>
            トークンは<strong>{PLUGIN_TOKEN_TTL_DAYS} 日で自動的に失効</strong>します。期限が切れたら再発行してください。
          </li>
          <li>
            このトークンでできるのは<strong>あなたのプラグインの作成〜個人導入まで</strong>です。
            投稿・板/サイト導入・審査・他人のプラグイン操作はできません。site 公開は必ず人間の審査を通ります。
          </li>
          <li>
            心当たりのない「最終使用」日時や、見覚えのないプラグインが mine に増えていたら、
            トークンの失効と管理者への通報を検討してください。
          </li>
        </ul>
      </section>
    </div>
  );
}