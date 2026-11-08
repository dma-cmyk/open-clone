"use client";

// 板作成画面。板管理人 = 作成者。1週間無投稿で自動削除（運用は cron / WP1）。
import { useCallback, useMemo, useState } from "react";
import { api } from "@/features/board-ui/api";
import { boardBanner, boardDesignStyle } from "@/features/board-ui/board-design";
import { TurnstileWidget } from "@/features/board-ui/turnstile";
import { useApiData } from "@/features/board-ui/use-api-data";
import { Button, Notice, useToast } from "@/components/ui";
import { navigate } from "../router";
import type { BoardDesign, BoardSettings } from "@/features/board-ui/types";

const SLUG = /^[a-z0-9][a-z0-9_-]{1,30}$/;

export function BoardNewView() {
  const toast = useToast();
  const boards = useApiData(() => api.listBoards(), []);
  const categories = useMemo(() => boards.data?.categories ?? [], [boards.data]);

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState("");
  const [design, setDesign] = useState<BoardDesign>({
    themeColor: "#ccffcc",
    accentColor: "#228811",
    bannerUrl: null,
  });
  const [settings, setSettings] = useState<BoardSettings>({
    turnstile: "anonymous",
    cooldownSeconds: 5,
    live: false,
    allowImages: true,
    kome: true,
    noId: false,
    maxPosts: 1000,
  });
  const [ngWords, setNgWords] = useState("");
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onToken = useCallback((value: string) => setToken(value), []);

  const submit = async () => {
    setError(null);
    if (!SLUG.test(slug)) {
      setError("板スラッグは英小文字・数字・ハイフン・アンダースコアで 2〜31 文字です（例: news-plus）");
      return;
    }
    if (name.trim().length === 0) {
      setError("板名を入力してください");
      return;
    }
    if (category.trim().length === 0) {
      setError("カテゴリを入力してください");
      return;
    }
    setSubmitting(true);
    try {
      const board = await api.createBoard({
        slug,
        name: name.trim(),
        category: category.trim(),
        description: description.trim() || undefined,
        rulesMd: rules.trim() || undefined,
        design,
        settings: {
          turnstile: settings.turnstile,
          cooldownSeconds: settings.cooldownSeconds,
          live: settings.live,
          allowImages: settings.allowImages,
          kome: settings.kome,
          noId: settings.noId,
          maxPosts: settings.maxPosts,
          ngWords: ngWords
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 200),
        },
        turnstileToken: token || undefined,
      });
      toast.show("板を作成しました");
      navigate(`/b/${encodeURIComponent(board.slug ?? slug)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "板の作成に失敗しました");
    } finally {
      setSubmitting(false);
      setResetKey((value) => value + 1);
      setToken("");
    }
  };

  const banner = boardBanner(design);

  return (
    <div>
      <div className="oc-panel">
        <div className="oc-panel-title">板を作る</div>
        <div className="oc-panel-inner">
          <Notice kind="warn">
            板の作成にはアカウントが必要です（<a href="/account/login">ログイン</a> / <a href="/account/register">新規登録</a>）。
            作成者が初代板管理人になります。1週間投稿がない板は自動削除されます。
          </Notice>

          <div className="oc-grid-2 oc-mt">
            <label className="oc-field">
              <span className="oc-label">板スラッグ（URL /b/&lt;slug&gt;）</span>
              <input
                className="oc-input"
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
                placeholder="例: news-plus"
                maxLength={31}
              />
            </label>
            <label className="oc-field">
              <span className="oc-label">板名</span>
              <input className="oc-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
            </label>
            <label className="oc-field">
              <span className="oc-label">カテゴリ</span>
              <input
                className="oc-input"
                list="oc-categories"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                maxLength={32}
              />
              <datalist id="oc-categories">
                {categories.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
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

          <label className="oc-field">
            <span className="oc-label">板ルール（プレーンテキスト / 改行保持）</span>
            <textarea
              className="oc-textarea"
              rows={4}
              value={rules}
              onChange={(event) => setRules(event.target.value)}
              maxLength={20000}
              placeholder={"1. 荒らし行為は禁止です\n2. 宣伝目的の投稿は削除します"}
            />
          </label>

          <div className="oc-panel" style={{ marginTop: 8 }}>
            <div className="oc-panel-title">板デザイン</div>
            <div className="oc-panel-inner">
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
                <span className="oc-label">バナー画像 URL（任意・https / data:image）</span>
                <input
                  className="oc-input"
                  value={design.bannerUrl ?? ""}
                  onChange={(event) => setDesign({ ...design, bannerUrl: event.target.value || null })}
                  placeholder="https://example.com/banner.png"
                  maxLength={512}
                />
              </label>
              <div className="oc-surface" style={boardDesignStyle(design)}>
                <div className="oc-panel" style={{ marginBottom: 0 }}>
                  <div className="oc-panel-title">プレビュー</div>
                  <div className="oc-panel-inner">
                    {banner ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={banner} alt="板バナー" style={{ maxHeight: 120, marginBottom: 6 }} />
                    ) : null}
                    <div className="oc-thread-title">サンプルスレッドタイトル (12)</div>
                    <div className="oc-post-header">
                      <span className="oc-post-num">1</span>：<span className="oc-post-name">名無しさん</span>：
                      <span className="oc-post-date">26/11/08(日) 12:00:00</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="oc-panel" style={{ marginTop: 8 }}>
            <div className="oc-panel-title">板の動作設定</div>
            <div className="oc-panel-inner">
              <div className="oc-grid-2">
                <label className="oc-field">
                  <span className="oc-label">Turnstile（Bot 対策）</span>
                  <select
                    className="oc-select"
                    value={settings.turnstile}
                    onChange={(event) =>
                      setSettings({ ...settings, turnstile: event.target.value as BoardSettings["turnstile"] })
                    }
                  >
                    <option value="anonymous">未ログインのみ要求</option>
                    <option value="always">全投稿で要求</option>
                    <option value="off">要求しない</option>
                  </select>
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
                  <input
                    type="checkbox"
                    checked={settings.live}
                    onChange={(event) => setSettings({ ...settings, live: event.target.checked })}
                  />
                  実況板にする
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
                  <input
                    type="checkbox"
                    checked={settings.kome}
                    onChange={(event) => setSettings({ ...settings, kome: event.target.checked })}
                  />
                  kome を許可
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.noId}
                    onChange={(event) => setSettings({ ...settings, noId: event.target.checked })}
                  />
                  ID を表示しない
                </label>
              </div>
              <label className="oc-field oc-mt">
                <span className="oc-label">NG ワード（1行1語・最大200）</span>
                <textarea
                  className="oc-textarea"
                  rows={3}
                  value={ngWords}
                  onChange={(event) => setNgWords(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="oc-mt">
            <TurnstileWidget onToken={onToken} resetKey={resetKey} />
          </div>
          {error ? <Notice kind="error">{error}</Notice> : null}
          <div className="oc-row oc-mt">
            <Button variant="primary" onClick={submit} disabled={submitting}>
              {submitting ? "作成中…" : "板を作成する"}
            </Button>
            <span className="oc-note">作成後、板管理画面からルール・デザイン・スタッフを変更できます。</span>
          </div>
        </div>
      </div>
    </div>
  );
}