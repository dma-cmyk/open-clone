"use client";

// プラグインエディタ（作成・版追加・その場プレビュー）
// CodeMirror でコードを編集し、sandbox iframe で即時実行、静的検査・保存・公開申請まで行う。

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { javascript } from "@codemirror/lang-javascript";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_SCOPES,
  PLUGIN_SLOTS,
  normalizeManifest,
  type PluginPermission,
  type PluginPostRenderRule,
  type PluginScope,
  type PluginSlotName,
  type PluginStaticCheckResult,
} from "shared";
import { PluginPreview, pluginApi } from "@/features/plugin-host";
import { takeTemplateDraft } from "@/features/plugin-templates";
import { PLUGIN_TEMPLATES } from "../_examples";
import {
  Badge,
  Card,
  Field,
  Notice,
  PluginShell,
  errorText,
  useQueryParam,
  ui,
} from "../_shared";

const CodeEditor = dynamic(() => import("@uiw/react-codemirror").then((mod) => mod.default), {
  ssr: false,
});

const DEFAULT_CODE = `// プラグイン本体（plugin.js）
// ホストから渡される API は packages/plugin-sdk の型を参照。
register({
  slots: {
    "thread-post-inline": function ({ data, api, root }) {
      var box = document.createElement('div');
      box.textContent = 'レス ' + (data && data.post ? data.post.num : '?') + ' に表示しています';
      root.appendChild(box);
    }
  }
});`;

const DEFAULT_RENDER = `[]`;

function nextPatch(version: string | null): string {
  if (!version) return "1.0.0";
  const parts = version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues: unknown = Reflect.get(error, "issues");
    if (Array.isArray(issues)) {
      return issues
        .map((issue) => {
          if (!issue || typeof issue !== "object") return String(issue);
          const path: unknown = Reflect.get(issue, "path");
          const message: unknown = Reflect.get(issue, "message");
          const location = Array.isArray(path) ? path.join(".") : "";
          return `${location ? `${location}: ` : ""}${typeof message === "string" ? message : "不正な値"}`;
        })
        .join("\n");
    }
  }
  return errorText(error);
}

export default function PluginEditorPage() {
  const editId = useQueryParam("id");

  const [name, setName] = useState("my-plugin");
  const [version, setVersion] = useState("1.0.0");
  const [summary, setSummary] = useState("スレに何かを表示するプラグイン");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<PluginScope[]>(["personal"]);
  const [permissions, setPermissions] = useState<PluginPermission[]>(["ui:slot"]);
  const [slots, setSlots] = useState<PluginSlotName[]>(["thread-post-inline"]);
  const [allowlistText, setAllowlistText] = useState("");
  const [renderText, setRenderText] = useState(DEFAULT_RENDER);
  const [code, setCode] = useState(DEFAULT_CODE);

  const [pluginId, setPluginId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [checkResult, setCheckResult] = useState<PluginStaticCheckResult | null>(null);
  const [checkWarnings, setCheckWarnings] = useState<string[]>([]);
  const [previewRunId, setPreviewRunId] = useState(0);
  const [previewSlot, setPreviewSlot] = useState<PluginSlotName>("thread-post-inline");
  const [messages, setMessages] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<"private" | "unlisted" | "public">("private");

  const renderRules = useMemo<{ rules: PluginPostRenderRule[]; error: string | null }>(() => {
    try {
      const parsed: unknown = JSON.parse(renderText || "[]");
      if (!Array.isArray(parsed)) return { rules: [], error: "JSON 配列で指定してください" };
      return { rules: parsed as PluginPostRenderRule[], error: null };
    } catch (caught) {
      return { rules: [], error: `レンダー規則の JSON が不正です: ${errorText(caught)}` };
    }
  }, [renderText]);

  const manifestResult = useMemo(() => {
    try {
      const manifest = normalizeManifest({
        name,
        version,
        summary,
        description: description.trim() || undefined,
        scope: scopes,
        permissions,
        connectAllowlist: allowlistText
          .split(/\s+/)
          .map((line) => line.trim())
          .filter(Boolean),
        entry: "plugin.js",
        slots,
        hooks: [],
        render: renderRules.rules.length > 0 ? { post: renderRules.rules } : undefined,
      });
      return { manifest, error: null as string | null };
    } catch (caught) {
      return { manifest: null, error: describeError(caught) };
    }
  }, [name, version, summary, description, scopes, permissions, allowlistText, slots, renderRules]);

  // 既存プラグインを編集（新バージョン追加）
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const detail = await pluginApi.detail(editId);
        if (cancelled) return;
        setPluginId(detail.id);
        setName(detail.name);
        setVersion(nextPatch(detail.latestVersion));
        setSummary(detail.manifest.summary);
        setDescription(detail.manifest.description ?? "");
        setScopes(detail.manifest.scope);
        setPermissions(detail.manifest.permissions);
        setSlots(detail.manifest.slots);
        setAllowlistText(detail.manifest.connectAllowlist.join("\n"));
        setRenderText(JSON.stringify(detail.manifest.render?.post ?? [], null, 2));
        setVisibility(detail.visibility);
        if (detail.latestVersion) {
          const latestCode = await pluginApi.fetchCode(detail.id, detail.latestVersion);
          if (!cancelled) setCode(latestCode);
        }
        if (!cancelled) {
          setPreviewSlot(detail.manifest.slots[0] ?? "thread-post-inline");
          setNotice(`「${detail.name}」の新バージョンを作成します（v${nextPatch(detail.latestVersion)}）`);
        }
      } catch (caught) {
        if (!cancelled) setError(describeError(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editId]);

  const applyTemplate = useCallback((templateId: string) => {
    const template = PLUGIN_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return;
    setName(template.name);
    setVersion(template.version);
    setSummary(template.summary);
    setDescription(template.description);
    setScopes(template.scopes);
    setPermissions(template.permissions);
    setSlots(template.slots);
    setAllowlistText(template.connectAllowlist.join("\n"));
    setRenderText(JSON.stringify(template.render, null, 2));
    setCode(template.code);
    setPreviewSlot(template.slots[0] ?? "thread-post-inline");
    setNotice(`サンプル「${template.label}」を読み込みました`);
    setCheckResult(null);
    setCheckWarnings([]);
  }, []);

  // テンプレートからの受け渡し（報告書 27 §4.6 / 29 決定 7）。
  // - `?from=template`: /plugins/templates で入力済みの { manifest, code } を sessionStorage から 1 回読む
  // - `?template=<id>`: 既定値から生成する（方式 A）
  // 既存の編集（`?id=`）とは排他で、指定が無ければ何もしない（既存構造は維持）。
  // StrictMode の effect 二重実行で sessionStorage を 2 回読まないよう、一度だけ実行する。
  const templateInitRef = useRef(false);
  useEffect(() => {
    if (templateInitRef.current) return;
    templateInitRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") === "template") {
      const draft = takeTemplateDraft();
      if (!draft) {
        setError("テンプレートの下書きが見つかりませんでした。テンプレートから作り直してください。");
        return;
      }
      setName(draft.manifest.name);
      setVersion(draft.manifest.version);
      setSummary(draft.manifest.summary);
      setDescription(draft.manifest.description ?? "");
      setScopes(draft.manifest.scope);
      setPermissions(draft.manifest.permissions);
      setSlots(draft.manifest.slots);
      setAllowlistText(draft.manifest.connectAllowlist.join("\n"));
      setRenderText(JSON.stringify(draft.manifest.render?.post ?? [], null, 2));
      setCode(draft.code);
      setPreviewSlot(draft.manifest.slots[0] ?? "thread-post-inline");
      setNotice("テンプレートの内容を読み込みました。編集して保存できます。");
      return;
    }
    const templateId = params.get("template");
    if (!templateId) return;
    if (PLUGIN_TEMPLATES.some((template) => template.id === templateId)) applyTemplate(templateId);
    else setError("指定されたテンプレートが見つかりません。");
  }, [applyTemplate]);

  async function runCheck() {
    setError(null);
    setCheckResult(null);
    setCheckWarnings([]);
    if (!manifestResult.manifest) {
      setError(manifestResult.error ?? "manifest が不正です");
      return;
    }
    try {
      const result = await pluginApi.previewCheck(code, manifestResult.manifest);
      setCheckResult(result.checks);
      setCheckWarnings(result.warnings);
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  async function save() {
    setError(null);
    setNotice(null);
    if (!manifestResult.manifest) {
      setError(manifestResult.error ?? "manifest が不正です");
      return;
    }
    if (renderRules.error) {
      setError(renderRules.error);
      return;
    }
    setSaving(true);
    try {
      if (pluginId) {
        const result = await pluginApi.addVersion(pluginId, {
          version,
          manifest: manifestResult.manifest,
          code,
          changelog: description || undefined,
        });
        setNotice(`v${result.version} を保存しました（公開申請で審査されます）`);
        setVersion(nextPatch(result.version));
      } else {
        const result = await pluginApi.create({
          manifest: manifestResult.manifest,
          code,
          visibility,
          changelog: "initial version",
        });
        setPluginId(result.id);
        setNotice(`プラグイン「${result.name}」を保存しました（ID: ${result.id}）`);
      }
      setCheckResult(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!pluginId) {
      setError("先に保存してください");
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const result = await pluginApi.publish(pluginId, { scopes, visibility: "public" });
      setNotice(
        result.needsReview
          ? "公開申請を受け付けました。サイト管理者の審査後に公開されます（審査キュー）。"
          : "公開しました。検索・インストールできるようになりました。",
      );
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  return (
    <PluginShell
      title={pluginId ? "プラグインの新バージョン" : "プラグインを作成"}
      description="コードを書いてその場でプレビュー実行できます。manifest で宣言していない権限はサンドボックスで拒否されます。"
      actions={
        <>
          <select
            className="oc-input"
            defaultValue=""
            onChange={(event) => {
              applyTemplate(event.target.value);
              event.target.value = "";
            }}
          >
            <option value="">サンプルを読み込む…</option>
            {PLUGIN_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
          {pluginId ? (
            <a href={`/plugins/view/?id=${encodeURIComponent(pluginId)}`} className="oc-btn">
              詳細へ
            </a>
          ) : null}
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {loading ? <p className="oc-muted oc-small">読み込み中…</p> : null}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 460px", minWidth: 320 }}>
          <Card title="manifest">
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Field label="名前（slug・変更不可）">
                  <input
                    className="oc-input"
                    value={name}
                    disabled={Boolean(pluginId)}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
              </div>
              <div style={{ flex: "0 0 120px" }}>
                <Field label="バージョン">
                  <input className="oc-input" value={version} onChange={(event) => setVersion(event.target.value)} />
                </Field>
              </div>
            </div>
            <Field label="概要（200 文字以内）">
              <input className="oc-input" value={summary} onChange={(event) => setSummary(event.target.value)} />
            </Field>
            <Field label="説明">
              <textarea
                className="oc-textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>

            <Field label="適用スコープ（公開申請・manifest 共通）">
              <div style={{ ...ui.row, marginTop: 4 }}>
                {PLUGIN_SCOPES.map((scope) => (
                  <label key={scope} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={() => setScopes(toggle(scopes, scope))}
                    />
                    {scope === "personal" ? "個人用" : scope === "board" ? "板用" : "サイト全体"}
                  </label>
                ))}
              </div>
            </Field>

            <Field label="権限（manifest.permissions）">
              <div style={{ ...ui.row, marginTop: 4 }}>
                {PLUGIN_PERMISSIONS.map((permission) => (
                  <label key={permission} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={permissions.includes(permission)}
                      onChange={() => setPermissions(toggle(permissions, permission))}
                    />
                    {permission}
                  </label>
                ))}
              </div>
            </Field>

            <Field label="UI スロット（manifest.slots）">
              <div style={{ ...ui.row, marginTop: 4 }}>
                {PLUGIN_SLOTS.map((slot) => (
                  <label key={slot} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={slots.includes(slot)}
                      onChange={() => setSlots(toggle(slots, slot))}
                    />
                    {slot}
                  </label>
                ))}
              </div>
            </Field>

            <Field label="net:fetch 許可オリジン（1 行 1 件）" hint="net:fetch 権限が必要">
              <textarea
                className="oc-textarea"
                value={allowlistText}
                placeholder="https://api.example.com"
                onChange={(event) => setAllowlistText(event.target.value)}
              />
            </Field>

            <Field label="宣言的レンダー規則（manifest.render.post の JSON 配列）">
              <textarea
                className="oc-textarea"
                style={{ fontFamily: "var(--oc-mono)", minHeight: 90 }}
                value={renderText}
                onChange={(event) => setRenderText(event.target.value)}
              />
            </Field>
            {renderRules.error ? <Notice tone="danger">{renderRules.error}</Notice> : null}
            {manifestResult.error ? <Notice tone="danger">{manifestResult.error}</Notice> : null}
          </Card>

          <Card
            title="コード（plugin.js）"
            actions={<span className="oc-muted oc-small">{new TextEncoder().encode(code).byteLength} bytes</span>}
          >
            <CodeEditor
              value={code}
              height="360px"
              extensions={[javascript()]}
              onChange={(value: string) => setCode(value)}
              basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
            />
          </Card>

          <Card>
            <div className="oc-row">
              <button type="button" className="oc-btn oc-btn-primary" onClick={() => void save()} disabled={saving}>
                {pluginId ? "新バージョンを保存" : "保存（下書き）"}
              </button>
              <button
                type="button"
                className="oc-btn"
                onClick={() => setPreviewRunId((value) => value + 1)}
                disabled={!manifestResult.manifest}
              >
                プレビュー実行
              </button>
              <button type="button" className="oc-btn" onClick={() => void runCheck()}>
                静的検査
              </button>
              <select
                className="oc-input" style={{ width: 180 }}
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as typeof visibility)}
              >
                <option value="private">非公開</option>
                <option value="unlisted">限定公開（URL 共有）</option>
                <option value="public">公開</option>
              </select>
              <button type="button" className="oc-btn" onClick={() => void publish()} disabled={!pluginId}>
                公開申請
              </button>
            </div>
            {pluginId ? (
              <p className="oc-muted oc-small">
                ID: {pluginId}（公開申請すると検索に載ります。site スコープは審査キューで承認後に公開）
              </p>
            ) : null}
          </Card>

          {checkResult ? (
            <Card title="静的検査の結果">
              <div className="oc-row">
                {checkResult.allowed ? <Badge tone="ok">公開可能</Badge> : <Badge tone="danger">公開不可</Badge>}
                <Badge>リスクスコア {checkResult.riskScore ?? 0}</Badge>
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {checkResult.reasons.map((reason, index) => (
                  <li key={index} style={{ fontSize: 12 }}>
                    {reason}
                  </li>
                ))}
              </ul>
              {checkWarnings.length > 0 ? (
                <>
                  <h3 style={{ fontSize: 13, margin: "8px 0 2px" }}>権限宣言の警告</h3>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {checkWarnings.map((warning, index) => (
                      <li key={index} style={{ fontSize: 12, color: "#8a5b00" }}>
                        {warning}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div style={{ flex: "1 1 380px", minWidth: 300 }}>
          <Card
            title="プレビュー（sandbox）"
            actions={
              <select
                className="oc-input" style={{ width: 170 }}
                value={previewSlot}
                onChange={(event) => setPreviewSlot(event.target.value as PluginSlotName)}
              >
                {(slots.length > 0 ? slots : PLUGIN_SLOTS).map((slot) => (
                  <option key={slot} value={slot}>
                    {slot}
                  </option>
                ))}
              </select>
            }
          >
            <p className="oc-muted oc-small">
              サンプルデータで実行します。外部通信・投稿・GitHub はプレビューでは無効です（保存後に実データで動作）。
            </p>
            {manifestResult.manifest ? (
              <PluginPreview
                manifest={manifestResult.manifest}
                code={code}
                runId={previewRunId}
                slot={previewSlot}
                data={
                  previewSlot === "thread-head"
                    ? { threadId: 1001, boardId: 1 }
                    : previewSlot === "board-head"
                      ? { boardId: 1, boardSlug: "news" }
                      : previewSlot === "post-form-after"
                        ? { draft: { body: "" } }
                        : { post: { id: 2, num: 2, name: "名無しさん", body: ">>1 おめでとう\n[spoiler]ネタバレ[/spoiler]", createdAt: 1760000060 } }
                }
                onNotify={(message, level) => setMessages((prev) => [`[${level}] ${message}`, ...prev].slice(0, 20))}
                onLog={(args) => setMessages((prev) => [`[log] ${args.join(" ")}`, ...prev].slice(0, 20))}
                minHeight={80}
              />
            ) : (
              <p className="oc-muted oc-small">manifest を修正するとプレビューできます。</p>
            )}
            <div style={{ marginTop: 8 }}>
              <div className="oc-muted oc-small">通知 / ログ</div>
              <ul style={{ margin: 0, paddingLeft: 16, maxHeight: 140, overflow: "auto" }}>
                {messages.map((message, index) => (
                  <li key={index} style={{ fontSize: 12 }}>
                    {message}
                  </li>
                ))}
                {messages.length === 0 ? <li style={{ fontSize: 12, color: "#999" }}>なし</li> : null}
              </ul>
            </div>
          </Card>

          <Card title="ヒント">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#444" }}>
              <li>manifest で宣言していない権限の API は拒否されます。</li>
              <li>宣言的レンダー規則（render.post）は JS なしで投稿表示を変換できます。</li>
              <li>コードは 512KB まで。無限ループ・eval・document.cookie は静的検査でブロックされます。</li>
              <li>保存しただけでは公開されません（非公開の下書き）。公開申請を行ってください。</li>
              <li>現在のスコープ: {scopes.join(", ") || "未選択"}</li>
            </ul>
          </Card>
        </div>
      </div>
    </PluginShell>
  );
}