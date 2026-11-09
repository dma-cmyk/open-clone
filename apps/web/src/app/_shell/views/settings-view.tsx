"use client";

// 個人設定（NG 3段階・表示・新着・つぶやき・履歴）。localStorage 永続。
import { useState } from "react";
import {
  addNgEntry,
  removeNgEntry,
  settingsStore,
  type NgConfig,
  type NgMode,
} from "@/features/board-ui/settings";
import { clearHistory, historyStore } from "@/features/board-ui/history";
import { formatRelative } from "@/features/board-ui/format";
import { Button, Notice, Tabs, useToast } from "@/components/ui";
import { Link } from "../router";

const NG_LISTS: { key: keyof Omit<NgConfig, "mode">; label: string; placeholder: string }[] = [
  { key: "words", label: "NG ワード（本文・部分一致）", placeholder: "例: 荒らし / :image / :url" },
  { key: "ids", label: "NG ID（完全一致）", placeholder: "例: MOoI" },
  { key: "names", label: "NG 名前（部分一致）", placeholder: "例: 特定のコテハン" },
  { key: "trips", label: "NG トリップ（完全一致）", placeholder: "例: ◆1xBvFkA3bc" },
  { key: "threads", label: "NG スレタイ（部分一致）", placeholder: "例: 宣伝スレ" },
];

function NgSection() {
  const settings = settingsStore.use();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <section className="oc-settings-section">
      <h2>NG 設定</h2>
      <div className="oc-surface">
        <div className="oc-row">
          <span className="oc-label">処理方法:</span>
          {(
            [
              { value: "confirm", label: "確認（マークして表示）" },
              { value: "hide", label: "非表示（通知のみ）" },
              { value: "ignore", label: "完全に無視" },
            ] as { value: NgMode; label: string }[]
          ).map((item) => (
            <label key={item.value} className="oc-check">
              <input
                type="radio"
                name="ng-mode"
                checked={settings.ng.mode === item.value}
                onChange={() => settingsStore.update({ ng: { ...settings.ng, mode: item.value } })}
              />
              {item.label}
            </label>
          ))}
        </div>
        <p className="oc-note">
          NG はこの端末にのみ保存されます。サーバーには送信されません（open2ch と同じ方式）。特殊 NG: :url / :image / :tsubuyaki / :ai
        </p>

        {NG_LISTS.map((list) => (
          <div key={list.key} className="oc-mt">
            <div className="oc-label">{list.label}</div>
            <div className="oc-row">
              <input
                className="oc-input oc-input-sm"
                style={{ maxWidth: 320 }}
                value={drafts[list.key] ?? ""}
                placeholder={list.placeholder}
                onChange={(event) => setDrafts({ ...drafts, [list.key]: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addNgEntry(list.key, drafts[list.key] ?? "");
                    setDrafts({ ...drafts, [list.key]: "" });
                  }
                }}
              />
              <Button
                size="sm"
                onClick={() => {
                  addNgEntry(list.key, drafts[list.key] ?? "");
                  setDrafts({ ...drafts, [list.key]: "" });
                }}
              >
                追加
              </Button>
            </div>
            <div className="oc-ng-list">
              {settings.ng[list.key].length === 0 ? <span className="oc-muted oc-small">なし</span> : null}
              {settings.ng[list.key].map((value) => (
                <span key={value} className="oc-ng-item">
                  {value}
                  <button type="button" onClick={() => removeNgEntry(list.key, value)} aria-label={`${value} を削除`}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SettingsView() {
  const settings = settingsStore.use();
  const history = historyStore.use();
  const toast = useToast();
  const [tab, setTab] = useState<"ng" | "display" | "behavior" | "history">("ng");

  return (
    <div>
      <div className="oc-panel">
        <div className="oc-panel-title">設定</div>
        <div className="oc-panel-inner">
          <p className="oc-note">
            設定はこの端末（localStorage）に保存されます。ブラウザを変えると引き継がれません。
          </p>
          <Tabs
            tabs={[
              { value: "ng", label: "NG" },
              { value: "display", label: "表示" },
              { value: "behavior", label: "新着・実況・つぶやき" },
              { value: "history", label: "履歴・ブクマ" },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === "ng" ? <NgSection /> : null}

          {tab === "display" ? (
            <section className="oc-settings-section">
              <h2>表示</h2>
              <div className="oc-surface oc-stack">
                <label className="oc-field">
                  <span className="oc-label">文字サイズ: {settings.display.fontSize}px</span>
                  <input
                    type="range"
                    min={12}
                    max={22}
                    value={settings.display.fontSize}
                    onChange={(event) =>
                      settingsStore.update({
                        display: { ...settings.display, fontSize: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.display.showImages}
                    onChange={(event) =>
                      settingsStore.update({ display: { ...settings.display, showImages: event.target.checked } })
                    }
                  />
                  画像・動画を展開表示する
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.display.aa}
                    onChange={(event) => settingsStore.update({ display: { ...settings.display, aa: event.target.checked } })}
                  />
                  AA モード（等幅フォント）
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.display.reverse}
                    onChange={(event) =>
                      settingsStore.update({ display: { ...settings.display, reverse: event.target.checked } })
                    }
                  />
                  レスを逆順（新しい順）で表示
                </label>
                <div className="oc-note">
                  文字サイズはレス本文にのみ適用されます。現在の本文サイズ: {settings.display.fontSize}px
                </div>
              </div>
            </section>
          ) : null}

          {tab === "behavior" ? (
            <section className="oc-settings-section">
              <h2>新着・実況・つぶやき</h2>
              <div className="oc-surface oc-stack">
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.behavior.autoScroll}
                    onChange={(event) =>
                      settingsStore.update({ behavior: { ...settings.behavior, autoScroll: event.target.checked } })
                    }
                  />
                  実況中は新着レスへ自動スクロール（自動追尾）
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.behavior.sound}
                    onChange={(event) =>
                      settingsStore.update({ behavior: { ...settings.behavior, sound: event.target.checked } })
                    }
                  />
                  新着時に通知音を鳴らす
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.behavior.readAloud}
                    onChange={(event) =>
                      settingsStore.update({ behavior: { ...settings.behavior, readAloud: event.target.checked } })
                    }
                  />
                  新着を読み上げる（Web Speech API）
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.behavior.tsubuyaki}
                    onChange={(event) =>
                      settingsStore.update({ behavior: { ...settings.behavior, tsubuyaki: event.target.checked } })
                    }
                  />
                  スレを開いたとき つぶやき を表示する
                </label>
                <label className="oc-check">
                  <input
                    type="checkbox"
                    checked={settings.behavior.floatForm}
                    onChange={(event) =>
                      settingsStore.update({ behavior: { ...settings.behavior, floatForm: event.target.checked } })
                    }
                  />
                  投稿欄を浮き窓にする
                </label>
                <div className="oc-grid-2 oc-mt">
                  <label className="oc-field">
                    <span className="oc-label">つぶやき 文字サイズ: {settings.tsubuyaki.size}px</span>
                    <input
                      type="range"
                      min={14}
                      max={40}
                      value={settings.tsubuyaki.size}
                      onChange={(event) =>
                        settingsStore.update({ tsubuyaki: { ...settings.tsubuyaki, size: Number(event.target.value) } })
                      }
                    />
                  </label>
                  <label className="oc-field">
                    <span className="oc-label">つぶやき 速度: {settings.tsubuyaki.speed}</span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={settings.tsubuyaki.speed}
                      onChange={(event) =>
                        settingsStore.update({ tsubuyaki: { ...settings.tsubuyaki, speed: Number(event.target.value) } })
                      }
                    />
                  </label>
                  <label className="oc-field">
                    <span className="oc-label">つぶやき 不透明度: {settings.tsubuyaki.opacity.toFixed(2)}</span>
                    <input
                      type="range"
                      min={20}
                      max={100}
                      value={settings.tsubuyaki.opacity * 100}
                      onChange={(event) =>
                        settingsStore.update({ tsubuyaki: { ...settings.tsubuyaki, opacity: Number(event.target.value) / 100 } })
                      }
                    />
                  </label>
                  <label className="oc-field">
                    <span className="oc-label">つぶやき 文字色</span>
                    <input
                      type="color"
                      value={settings.tsubuyaki.color}
                      onChange={(event) => settingsStore.update({ tsubuyaki: { ...settings.tsubuyaki, color: event.target.value } })}
                    />
                  </label>
                </div>
              </div>
            </section>
          ) : null}

          {tab === "history" ? (
            <section className="oc-settings-section">
              <h2>書き込み履歴・既読・ブクマ</h2>
              <div className="oc-grid-2">
                <div className="oc-surface">
                  <div className="oc-label">書き込み履歴（{history.writes.length}）</div>
                  {history.writes.length === 0 ? <div className="oc-muted oc-small">ありません</div> : null}
                  {history.writes.slice(0, 20).map((item) => (
                    <div key={item.key} className="oc-history-item">
                      <span className="oc-history-time">{formatRelative(item.at / 1000)}</span>
                      <Link href={item.path}>{item.title || item.path}</Link>
                    </div>
                  ))}
                </div>
                <div className="oc-surface">
                  <div className="oc-label">ブクマ（{history.bookmarks.length}）</div>
                  {history.bookmarks.length === 0 ? <div className="oc-muted oc-small">ありません</div> : null}
                  {history.bookmarks.slice(0, 20).map((item) => (
                    <div key={item.key} className="oc-history-item">
                      <span className="oc-history-time">★</span>
                      <Link href={item.path}>{item.title || item.path}</Link>
                    </div>
                  ))}
                </div>
                <div className="oc-surface">
                  <div className="oc-label">既読（{history.reads.length}）</div>
                  {history.reads.length === 0 ? <div className="oc-muted oc-small">ありません</div> : null}
                  {history.reads.slice(0, 20).map((item) => (
                    <div key={item.key} className="oc-history-item">
                      <span className="oc-history-time">{formatRelative(item.at / 1000)}</span>
                      <Link href={item.path}>{item.title || item.path}</Link>
                    </div>
                  ))}
                </div>
              </div>
              <div className="oc-row oc-mt">
                <Button
                  variant="danger"
                  onClick={() => {
                    clearHistory();
                    toast.show("履歴を削除しました");
                  }}
                >
                  履歴・ブクマをすべて削除
                </Button>
                <Button
                  onClick={() => {
                    settingsStore.reset();
                    toast.show("設定を初期化しました");
                  }}
                >
                  設定を初期化
                </Button>
              </div>
            </section>
          ) : null}

          <Notice kind="ok">設定は投稿・表示に即時反映されます。</Notice>
        </div>
      </div>
    </div>
  );
}