"use client";

// 板管理: 基本設定 / ルール / デザイン。shared の boardSettings/boardDesign に準拠。
import { useEffect, useState } from "react";
import { api } from "@/features/board-ui/api";
import { boardBanner, boardDesignStyle } from "@/features/board-ui/board-design";
import { Button, Notice, useToast } from "@/components/ui";
import type { BoardDesign, BoardDetail, BoardSettings } from "@/features/board-ui/types";

type Mode = "basic" | "rules" | "design";

export function ManageBoardSettings({
  board,
  mode,
  canManage,
  onSaved,
}: {
  board: BoardDetail;
  mode: Mode;
  /** 板の管理人（admin）以上か。ロボット確認の省略時間は管理人のみ変更できる。 */
  canManage?: boolean;
  onSaved: (board: BoardDetail) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(board.name);
  const [category, setCategory] = useState(board.category);
  const [description, setDescription] = useState(board.description ?? "");
  const [rules, setRules] = useState(board.rulesMd ?? "");
  const [settings, setSettings] = useState<BoardSettings>({
    turnstile: board.settings?.turnstile ?? "anonymous",
    turnstilePassMinutes: board.settings?.turnstilePassMinutes ?? 30,
    cooldownSeconds: board.settings?.cooldownSeconds ?? 0,
    live: Boolean(board.settings?.live),
    allowImages: board.settings?.allowImages !== false,
    tsubuyaki: board.settings?.tsubuyaki !== false,
    noId: Boolean(board.settings?.noId),
    maxPosts: board.settings?.maxPosts ?? 1000,
    allowPostEdit: board.settings?.allowPostEdit !== false,
    allowPostDelete: board.settings?.allowPostDelete !== false,
    allowThreadEdit: board.settings?.allowThreadEdit !== false,
    allowThreadDelete: board.settings?.allowThreadDelete !== false,
    allowQuoteThread: board.settings?.allowQuoteThread !== false,
    selfEditWindowMinutes: board.settings?.selfEditWindowMinutes ?? 0,
  });
  const [ngWords, setNgWords] = useState((board.settings?.ngWords ?? []).join("\n"));
  const [design, setDesign] = useState<BoardDesign>({
    themeColor: board.design?.themeColor ?? "#ccffcc",
    accentColor: board.design?.accentColor ?? "#228811",
    bannerUrl: board.design?.bannerUrl ?? null,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(board.name);
    setCategory(board.category);
    setDescription(board.description ?? "");
    setRules(board.rulesMd ?? "");
    setSettings({
      turnstile: board.settings?.turnstile ?? "anonymous",
      turnstilePassMinutes: board.settings?.turnstilePassMinutes ?? 30,
      cooldownSeconds: board.settings?.cooldownSeconds ?? 0,
      live: Boolean(board.settings?.live),
      allowImages: board.settings?.allowImages !== false,
      tsubuyaki: board.settings?.tsubuyaki !== false,
      noId: Boolean(board.settings?.noId),
      maxPosts: board.settings?.maxPosts ?? 1000,
      allowPostEdit: board.settings?.allowPostEdit !== false,
      allowPostDelete: board.settings?.allowPostDelete !== false,
      allowThreadEdit: board.settings?.allowThreadEdit !== false,
      allowThreadDelete: board.settings?.allowThreadDelete !== false,
      allowQuoteThread: board.settings?.allowQuoteThread !== false,
      selfEditWindowMinutes: board.settings?.selfEditWindowMinutes ?? 0,
    });
    setNgWords((board.settings?.ngWords ?? []).join("\n"));
    setDesign({
      themeColor: board.design?.themeColor ?? "#ccffcc",
      accentColor: board.design?.accentColor ?? "#228811",
      bannerUrl: board.design?.bannerUrl ?? null,
    });
  }, [board]);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateBoard(board.slug, patch);
      onSaved(updated);
      toast.show("保存しました");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (mode === "basic") {
    return (
      <div className="oc-stack">
        <div className="oc-grid-2">
          <label className="oc-field">
            <span className="oc-label">板名</span>
            <input className="oc-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          </label>
          <label className="oc-field">
            <span className="oc-label">カテゴリ</span>
            <input className="oc-input" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={32} />
          </label>
        </div>
        <label className="oc-field">
          <span className="oc-label">板の説明</span>
          <textarea
            className="oc-textarea"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        </label>
        <div className="oc-grid-2">
          <label className="oc-field">
            <span className="oc-label">連投制限（秒）</span>
            <input
              className="oc-input"
              type="number"
              min={0}
              max={3600}
              value={settings.cooldownSeconds}
              onChange={(event) => setSettings({ ...settings, cooldownSeconds: Number(event.target.value) })}
            />
          </label>
          <label className="oc-field">
            <span className="oc-label">Turnstile</span>
            <select
              className="oc-select"
              value={settings.turnstile}
              onChange={(event) => setSettings({ ...settings, turnstile: event.target.value as BoardSettings["turnstile"] })}
            >
              <option value="anonymous">未ログインのみ要求</option>
              <option value="always">全投稿で要求</option>
              <option value="off">要求しない</option>
            </select>
          </label>
          <label className="oc-field">
            <span className="oc-label">確認を省略する時間（分）</span>
            <input
              className="oc-input"
              type="number"
              min={0}
              max={1440}
              value={settings.turnstilePassMinutes}
              onChange={(event) => setSettings({ ...settings, turnstilePassMinutes: Number(event.target.value) })}
              disabled={settings.turnstile !== "anonymous" || canManage === false}
              title="一度ロボット確認に成功した端末は、この時間だけレス・つぶやきの確認を省略します（0 で毎回）。スレ立ては常に確認します。"
            />
            <span className="oc-note">
              「未ログインのみ要求」のときだけ有効です（0 で毎回確認）。スレ立ては常に確認します。
              {canManage === false ? " 変更は板の管理人（admin）だけができます。" : ""}
            </span>
          </label>
          <label className="oc-field">
            <span className="oc-label">既定のレス上限</span>
            <input
              className="oc-input"
              type="number"
              min={10}
              max={1000}
              value={settings.maxPosts}
              onChange={(event) => setSettings({ ...settings, maxPosts: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="oc-row">
          <label className="oc-check">
            <input type="checkbox" checked={settings.live} onChange={(event) => setSettings({ ...settings, live: event.target.checked })} />
            実況板
          </label>
          <label className="oc-check">
            <input
              type="checkbox"
              checked={settings.allowImages}
              onChange={(event) => setSettings({ ...settings, allowImages: event.target.checked })}
            />
            画像投稿を許可
          </label>
          <label className="oc-check">
            <input type="checkbox" checked={settings.tsubuyaki} onChange={(event) => setSettings({ ...settings, tsubuyaki: event.target.checked })} />
            つぶやきを許可
          </label>
          <label className="oc-check">
            <input type="checkbox" checked={settings.noId} onChange={(event) => setSettings({ ...settings, noId: event.target.checked })} />
            ID 非表示
          </label>
        </div>
        <div className="oc-panel" style={{ marginTop: 10 }}>
          <div className="oc-panel-title">本人による編集・削除・引用スレ</div>
          <div className="oc-panel-inner oc-stack">
            <div className="oc-row">
              <label className="oc-check">
                <input type="checkbox" checked={settings.allowPostEdit} onChange={(event) => setSettings({ ...settings, allowPostEdit: event.target.checked })} />
                レス編集
              </label>
              <label className="oc-check">
                <input type="checkbox" checked={settings.allowPostDelete} onChange={(event) => setSettings({ ...settings, allowPostDelete: event.target.checked })} />
                レス本人削除
              </label>
              <label className="oc-check">
                <input type="checkbox" checked={settings.allowThreadEdit} onChange={(event) => setSettings({ ...settings, allowThreadEdit: event.target.checked })} />
                スレ編集
              </label>
              <label className="oc-check">
                <input type="checkbox" checked={settings.allowThreadDelete} onChange={(event) => setSettings({ ...settings, allowThreadDelete: event.target.checked })} />
                スレ本人削除
              </label>
              <label className="oc-check">
                <input type="checkbox" checked={settings.allowQuoteThread} onChange={(event) => setSettings({ ...settings, allowQuoteThread: event.target.checked })} />
                引用スレ
              </label>
            </div>
            <label className="oc-field" style={{ maxWidth: 280 }}>
              <span className="oc-label">本人が編集・削除できる時間（分・0 = 無制限）</span>
              <input
                className="oc-input"
                type="number"
                min={0}
                max={525600}
                value={settings.selfEditWindowMinutes ?? 0}
                onChange={(event) => setSettings({ ...settings, selfEditWindowMinutes: Number(event.target.value) })}
              />
            </label>
            <div className="oc-muted oc-small">
              この設定は本人操作（編集・削除）だけに適用されます。板スタッフの削除・非表示には影響しません。
            </div>
          </div>
        </div>
        <label className="oc-field">
          <span className="oc-label">NG ワード（1行1語。ヒットした投稿は拒否されます）</span>
          <textarea className="oc-textarea" rows={4} value={ngWords} onChange={(event) => setNgWords(event.target.value)} />
        </label>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div className="oc-row">
          <Button
            variant="primary"
            disabled={saving}
            onClick={() =>
              void save({
                name: name.trim(),
                category: category.trim(),
                description: description.trim(),
                settings: {
                  turnstile: settings.turnstile,
                  turnstilePassMinutes: settings.turnstilePassMinutes,
                  cooldownSeconds: settings.cooldownSeconds,
                  live: settings.live,
                  allowImages: settings.allowImages,
                  tsubuyaki: settings.tsubuyaki,
                  noId: settings.noId,
                  maxPosts: settings.maxPosts,
                  allowPostEdit: settings.allowPostEdit,
                  allowPostDelete: settings.allowPostDelete,
                  allowThreadEdit: settings.allowThreadEdit,
                  allowThreadDelete: settings.allowThreadDelete,
                  allowQuoteThread: settings.allowQuoteThread,
                  selfEditWindowMinutes: settings.selfEditWindowMinutes,
                  ngWords: ngWords
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, 200),
                },
              })
            }
          >
            {saving ? "保存中…" : "保存する"}
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "rules") {
    return (
      <div className="oc-stack">
        <label className="oc-field">
          <span className="oc-label">板ルール（プレーンテキスト・改行保持）</span>
          <textarea className="oc-textarea" rows={14} value={rules} onChange={(event) => setRules(event.target.value)} maxLength={20000} />
        </label>
        <div className="oc-surface">
          <div className="oc-label">プレビュー</div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{rules || "（空）"}</div>
        </div>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <Button variant="primary" disabled={saving} onClick={() => void save({ rulesMd: rules })}>
          {saving ? "保存中…" : "ルールを保存"}
        </Button>
      </div>
    );
  }

  const banner = boardBanner(design);

  return (
    <div className="oc-stack">
      <div className="oc-grid-2">
        <label className="oc-field">
          <span className="oc-label">テーマ色（ヘッダ/枠）</span>
          <input
            type="color"
            value={design.themeColor ?? "#ccffcc"}
            onChange={(event) => setDesign({ ...design, themeColor: event.target.value })}
          />
        </label>
        <label className="oc-field">
          <span className="oc-label">アクセント色（名前）</span>
          <input
            type="color"
            value={design.accentColor ?? "#228811"}
            onChange={(event) => setDesign({ ...design, accentColor: event.target.value })}
          />
        </label>
      </div>
      <label className="oc-field">
        <span className="oc-label">バナー画像 URL</span>
        <input
          className="oc-input"
          value={design.bannerUrl ?? ""}
          onChange={(event) => setDesign({ ...design, bannerUrl: event.target.value || null })}
          placeholder="https://example.com/banner.png"
          maxLength={512}
        />
      </label>
      <div style={boardDesignStyle(design)}>
        <div className="oc-board-header">
          {banner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={banner} alt="板バナー" style={{ maxHeight: 120, marginBottom: 6 }} />
          ) : null}
          <div className="oc-board-title">
            {board.name}
            <small>＠おーぷんクローン</small>
          </div>
          <span className="oc-thread-title">プレビュー: スレッドタイトル (42)</span>
          <div className="oc-post-header">
            <span className="oc-post-num">1</span>：<span className="oc-post-name">名無しさん</span>：
            <span className="oc-post-date">26/11/08(日) 12:00:00 ID:AbCd</span>
          </div>
        </div>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button variant="primary" disabled={saving} onClick={() => void save({ design })}>
        {saving ? "保存中…" : "デザインを保存"}
      </Button>
    </div>
  );
}