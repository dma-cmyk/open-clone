"use client";

// テンプレートから作る（① コードを書かない経路。報告書 27 §4 / 28 §8.2）。
//
// 流れ: テンプレートを選ぶ → フォーム入力（ライブ検証）→ プレビュー＋静的検査 → 自分用に導入して保存。
// 保存・導入・公開は既存の API（POST /v1/plugins, /install, /publish）をそのまま使い、
// テンプレート専用の裏口は作らない。生成は shared の `generateFromTemplate`（クライアント側）。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginStaticCheckResult, PluginTemplateDefinition } from "shared";
import {
  PLUGIN_TEMPLATES,
  TemplateForm,
  TemplatePreview,
  buildRenderSamples,
  describeGenerationError,
  findPluginTemplate,
  generateDraft,
  initialFormState,
  saveTemplateDraft,
  templateChangelog,
  templateKindLabel,
  templatePermissionLabels,
  templateRiskBadge,
  validateForm,
  type DraftResult,
  type FormState,
  type FormValue,
  type RenderSample,
} from "@/features/plugin-templates";
import { PluginApiError, pluginApi } from "@/features/plugin-host";
import {
  Badge,
  Card,
  Notice,
  PluginShell,
  errorText,
  useQueryParam,
  ui,
} from "../_shared";

type Step = "select" | "edit" | "done";
type GeneratedDraft = Extract<DraftResult, { ok: true }>;

interface SavedPlugin {
  id: string;
  name: string;
}

export default function PluginTemplatesPage() {
  const queryTemplate = useQueryParam("template");
  const [step, setStep] = useState<Step>("select");
  const [template, setTemplate] = useState<PluginTemplateDefinition | null>(null);
  const [formState, setFormState] = useState<FormState>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [generated, setGenerated] = useState<GeneratedDraft | null>(null);
  const [samples, setSamples] = useState<RenderSample[]>([]);
  const [runId, setRunId] = useState(0);
  const [check, setCheck] = useState<{ checks: PluginStaticCheckResult; warnings: string[] } | null>(null);
  const [saved, setSaved] = useState<SavedPlugin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const validation = useMemo(
    () => (template ? validateForm(template, formState) : null),
    [template, formState],
  );

  const selectTemplate = useCallback((definition: PluginTemplateDefinition) => {
    setTemplate(definition);
    setFormState(initialFormState(definition));
    setTouched(new Set());
    setShowAllErrors(false);
    setGenerated(null);
    setSamples([]);
    setCheck(null);
    setSaved(null);
    setError(null);
    setNeedLogin(false);
    setNotice(null);
    setStep("edit");
  }, []);

  // `?template=<id>` で直接開ける（27 §4.6 方式 A の入口。既定値から始める）。
  useEffect(() => {
    if (!queryTemplate || step !== "select") return;
    const found = findPluginTemplate(queryTemplate);
    if (found) selectTemplate(found);
    else setError("指定されたテンプレートが見つかりません。");
    // step の変化で再選択しないよう、クエリの到着時だけ評価する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryTemplate]);

  const visibleErrors = useMemo<Record<string, string>>(() => {
    if (!validation) return {};
    if (showAllErrors) return validation.fieldErrors;
    return Object.fromEntries(
      Object.entries(validation.fieldErrors).filter(([key]) => touched.has(key)),
    );
  }, [validation, showAllErrors, touched]);

  function handleFieldChange(key: string, value: FormValue) {
    setFormState((previous) => ({ ...previous, [key]: value }));
    setTouched((previous) => new Set(previous).add(key));
    // 入力が変わったら、以前のプレビュー・検査結果は古いので消す。
    setGenerated(null);
    setSamples([]);
    setCheck(null);
    setError(null);
    setNotice(null);
  }

  function handleApiError(caught: unknown) {
    if (caught instanceof PluginApiError) {
      if (caught.status === 401) {
        setNeedLogin(true);
        return;
      }
      if (caught.status === 409) {
        setError("その名前はすでに使われています。別の名前にしてください");
        return;
      }
    }
    setError(errorText(caught));
  }

  /** フォームから生成するだけ（API を呼ばない）。エディタへの受け渡しにも使う。 */
  function draftOnly(): GeneratedDraft | null {
    if (!template) return null;
    setShowAllErrors(true);
    if (!validation?.ok) {
      setError("入力内容を確認してください。");
      return null;
    }
    try {
      const draft = generateDraft(template, formState);
      if (!draft.ok) {
        setError(Object.values(draft.fieldErrors).join("\n"));
        return null;
      }
      setGenerated(draft);
      setSamples(buildRenderSamples(template.id, draft.values));
      setRunId((value) => value + 1);
      return draft;
    } catch (caught) {
      setError(describeGenerationError(caught));
      return null;
    }
  }

  /** 生成 + 静的検査（保存とプレビューの共通経路）。 */
  async function prepare(): Promise<{ draft: GeneratedDraft; check: { checks: PluginStaticCheckResult; warnings: string[] } } | null> {
    setError(null);
    setNeedLogin(false);
    setNotice(null);
    const draft = draftOnly();
    if (!draft) return null;
    try {
      const result = await pluginApi.previewCheck(draft.code, draft.manifest);
      setCheck(result);
      return { draft, check: result };
    } catch (caught) {
      handleApiError(caught);
      return null;
    }
  }

  async function preview() {
    setBusy(true);
    try {
      await prepare();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!template) return;
    setBusy(true);
    setError(null);
    setNeedLogin(false);
    setNotice(null);
    try {
      const prepared = await prepare();
      if (!prepared) return;
      if (!prepared.check.checks.allowed) {
        setError("静的検査に合格しなかったため保存できません。理由を確認してください。");
        return;
      }
      const created = await pluginApi.create({
        manifest: prepared.draft.manifest,
        code: prepared.draft.code,
        visibility: "private",
        changelog: templateChangelog(template.id),
        templateId: template.id,
      });
      setSaved({ id: created.id, name: created.name });
      try {
        await pluginApi.install(created.id, { scope: "personal" });
        setNotice("自分用に導入しました（このブラウザに適用）");
      } catch (caught) {
        setNotice(
          "保存しましたが、このブラウザへの導入に失敗しました。詳細画面の「個人用にインストール」から導入してください。",
        );
        handleApiError(caught);
      }
      setStep("done");
      window.scrollTo({ top: 0 });
    } catch (caught) {
      handleApiError(caught);
    } finally {
      setBusy(false);
    }
  }

  function handoffToEditor() {
    if (!template) return;
    // 保存（`save` → `prepare`）と同じ `draftOnly` を通す。必須項目が空なら
    // 既定値で埋めて遷移せず、フォーム上に保存時と同じエラーを表示する（UI Low-2）。
    const draft = draftOnly();
    if (!draft) return;
    const stored = saveTemplateDraft({
      templateId: template.id,
      values: draft.values,
      manifest: draft.manifest,
      code: draft.code,
    });
    if (!stored) {
      setError("ブラウザの保存領域が使えないため、エディタへ引き継げませんでした。");
      return;
    }
    window.location.href = "/plugins/new/?from=template";
  }

  function resetWizard() {
    setStep("select");
    setTemplate(null);
    setGenerated(null);
    setSamples([]);
    setCheck(null);
    setSaved(null);
    setNotice(null);
    setError(null);
    setNeedLogin(false);
    setShowAllErrors(false);
    setTouched(new Set());
    window.scrollTo({ top: 0 });
  }

  return (
    <PluginShell
      title="テンプレートから作る"
      description="フォームに言葉や数字を入れるだけで、自分だけのプラグインが作れます。コードを書く必要はありません。"
      actions={
        <a href="/plugins/new/" className="oc-btn">
          コードを直接書く
        </a>
      }
    >
      <div role="status" aria-live="polite">
        {needLogin ? (
          <Notice tone="danger">
            ログインが必要です。
            <a href="/account/login">ログイン</a>
          </Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
      </div>

      {step === "select" ? (
        <>
          <Card title="テンプレートを選ぶ">
            {PLUGIN_TEMPLATES.length === 0 ? (
              <p className="oc-empty">テンプレートを準備中です。しばらくお待ちください。</p>
            ) : (
              <div className="oc-grid-2">
                {PLUGIN_TEMPLATES.map((definition) => {
                  const risk = templateRiskBadge(definition);
                  return (
                    <section className="oc-panel" key={definition.id} data-template={definition.id}>
                      <div className="oc-panel-title">
                        <span>{definition.label}</span>
                        <span className="oc-spacer" />
                        <Badge tone={risk.tone}>{risk.label}</Badge>
                      </div>
                      <div className="oc-panel-inner">
                        <p style={{ margin: "0 0 6px", fontSize: 13 }}>{definition.description}</p>
                        <div style={{ ...ui.row, marginBottom: 8 }}>
                          <Badge>{templateKindLabel(definition)}</Badge>
                          {templatePermissionLabels(definition).map((label) => (
                            <Badge key={label}>{label}</Badge>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="oc-btn oc-btn-primary oc-btn-block"
                          onClick={() => selectTemplate(definition)}
                        >
                          これで作る
                        </button>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            <p className="oc-note" style={{ marginTop: 8 }}>
              作ったプラグインは、まず自分用（このブラウザだけ）に導入されます。板・サイト全体への公開は、
              保存後の詳細画面から申請できます。
            </p>
          </Card>
        </>
      ) : null}

      {step === "edit" && template ? (
        <>
          <Card
            title={`設定: ${template.label}`}
            actions={
              <button type="button" className="oc-btn oc-btn-sm" onClick={resetWizard}>
                選び直す
              </button>
            }
          >
            {template.id === "ng-word-mask" ? (
              <Notice tone="warn">
                このテンプレートは表示だけを置き換えます。投稿内容そのものは変更されません（投稿は止まりません）。
              </Notice>
            ) : null}
            <TemplateForm
              template={template}
              state={formState}
              errors={visibleErrors}
              disabled={busy}
              onChange={handleFieldChange}
            />
            <div style={{ ...ui.row, marginTop: 8 }}>
              <button type="button" className="oc-btn oc-btn-primary" onClick={() => void preview()} disabled={busy}>
                プレビュー
              </button>
              <button type="button" className="oc-btn" onClick={handoffToEditor} disabled={busy}>
                コードを見る・手で編集する
              </button>
              <button type="button" className="oc-btn" onClick={resetWizard} disabled={busy}>
                キャンセル
              </button>
            </div>
            {template.kind === "render" ? (
              <p className="oc-note" style={{ marginTop: 6 }}>
                長いレス（2,048 字を超える本文）には表示ルールが適用されません。プレビューの「長文」で確認できます。
              </p>
            ) : null}
          </Card>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 420px", minWidth: 280 }}>
              <Card title="プレビュー">
                {generated ? (
                  <TemplatePreview
                    template={template}
                    manifest={generated.manifest}
                    code={generated.code}
                    samples={samples}
                    runId={runId}
                  />
                ) : (
                  <p className="oc-muted oc-small">
                    ［プレビュー］を押すと、ここに動作結果が表示されます。
                  </p>
                )}
              </Card>
            </div>

            <div style={{ flex: "1 1 320px", minWidth: 280 }}>
              <Card title="検査結果">
                {check ? (
                  <>
                    <div className="oc-row">
                      {check.checks.allowed ? (
                        <Badge tone="ok">保存できます</Badge>
                      ) : (
                        <Badge tone="danger">保存できません</Badge>
                      )}
                      <Badge>リスクスコア {check.checks.riskScore ?? 0}</Badge>
                    </div>
                    {check.checks.reasons.length > 0 ? (
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                        {check.checks.reasons.map((reason) => (
                          <li key={reason} style={{ fontSize: 12, color: "#8b1a1a" }}>
                            {reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {check.warnings.length > 0 ? (
                      <>
                        <h3 style={{ fontSize: 13, margin: "8px 0 2px" }}>警告</h3>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {check.warnings.map((warning) => (
                            <li key={warning} style={{ fontSize: 12, color: "#8a5b00" }}>
                              {warning}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </>
                ) : (
                  <p className="oc-muted oc-small">［プレビュー］で静的検査も実行されます。</p>
                )}
              </Card>

              <Card title="保存">
                <p className="oc-muted oc-small" style={{ marginTop: 0 }}>
                  保存すると、非公開のプラグインとして登録され、このブラウザに個人用として導入されます。
                  板・サイトへの公開申請は、保存後の詳細画面から行えます（サイト全体は管理者の審査後）。
                </p>
                <button
                  type="button"
                  className="oc-btn oc-btn-primary oc-btn-block"
                  onClick={() => void save()}
                  disabled={busy}
                >
                  自分用に導入して保存
                </button>
              </Card>
            </div>
          </div>
        </>
      ) : null}

      {step === "done" && saved && template ? (
        <Card title="できました">
          <div className="oc-row" style={{ marginBottom: 8 }}>
            <Badge tone="ok">個人用に導入済み</Badge>
            <Badge>{template.label}</Badge>
            <span className="oc-muted oc-small">ID: {saved.id}</span>
          </div>
          <p style={{ margin: "0 0 8px" }}>
            「{saved.name}」を保存し、このブラウザに導入しました。スレを開くと動作を確認できます。
          </p>
          <div className="oc-row">
            <a className="oc-btn oc-btn-primary" href="/">
              スレで試す
            </a>
            <a className="oc-btn" href="/plugins/demo/">
              スレ表示デモ
            </a>
            <a className="oc-btn" href={`/plugins/view/?id=${encodeURIComponent(saved.id)}`}>
              詳細
            </a>
            <a className="oc-btn" href={`/plugins/new/?id=${encodeURIComponent(saved.id)}`}>
              コードを編集
            </a>
            <a className="oc-btn" href={`/plugins/view/?id=${encodeURIComponent(saved.id)}`}>
              板/サイトに公開申請
            </a>
          </div>
          <p className="oc-note" style={{ marginTop: 8 }}>
            サイト全体への公開は審査待ちになります。個人用・板用のみなら審査なしで公開できます。
          </p>
          <div className="oc-row" style={{ marginTop: 8 }}>
            <button type="button" className="oc-btn" onClick={resetWizard}>
              もう 1 つ作る
            </button>
          </div>
          <p className="oc-muted oc-small">
            作成元: テンプレート「{template.label}」（詳細画面のバージョン履歴に記録されます）
          </p>
        </Card>
      ) : null}
    </PluginShell>
  );
}