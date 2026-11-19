"use client";

// ペットの設定（最初の設定と、あとからの見た目・キーの変更）。
//
// - 事業者（プリセット 5 社 + OpenAI 互換の URL）・モデル（検索して選べる）・API キーを入れる。
// - API キーはパスワード欄（表示切替あり）。発行画面へのリンクを出す。
// - 「この端末に覚えておく」がオンなら localStorage、オフならタブを閉じるまで（sessionStorage）。
// - 「接続を試す」はツール無しで短い文を 1 回だけ送る（本物の事業者に料金がかかるのは利用者の操作時だけ）。
// - 見た目は既定の 4 体から選ぶか、画像をアップロードする（256×256 の PNG にしてこの端末に保存）。
// - 一覧（モデル）は保存しない。表示中のこの画面だけが持つ。

import { useState } from "react";
import { PET_PROVIDER_PRESETS, petProviderPreset } from "shared";
import type { PetConfig } from "../contract";
import { PetRelayError, petTestConnection } from "../relay-client";
import { defaultPetName, providerHint, savePetAvatar, savePetConfig } from "../settings";
import { PET_CHARACTERS } from "../characters";
import { preparePetAvatar } from "./avatar-image";
import { ModelPicker } from "./model-picker";
import { PetAvatar } from "./pet-avatar";
import { usePetAvatar } from "./use-pet-settings";

const NOTICE = [
  "頼んだ内容と、ペットが読んだページの文章が、選んだ AI 事業者に送られます。",
  "料金はあなたのキーにかかります。",
  "キーはこのサイトのサーバーには保存されません（中継のたびに送るだけ）。",
].join(" ");

export function PetSettingsForm({
  mode,
  initialConfig,
  onDone,
  onClose,
}: {
  mode: "setup" | "settings";
  initialConfig: PetConfig;
  onDone: (config: PetConfig) => void;
  onClose?: () => void;
}) {
  const uploaded = usePetAvatar();
  const [draft, setDraft] = useState<PetConfig>(initialConfig);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [avatarNote, setAvatarNote] = useState<string | null>(null);

  const update = (partial: Partial<PetConfig>) => {
    setError(null);
    // キー・事業者・モデル・接続先を変えたら、前の「接続を試す」の結果は古いので消す。
    setTestState(null);
    setDraft((current) => ({ ...current, ...partial }));
  };
  const preset = petProviderPreset(draft.provider);

  const save = () => {
    const model = draft.model.trim().slice(0, 200);
    const apiKey = draft.apiKey.trim().slice(0, 512);
    const baseUrl = draft.baseUrl.trim().slice(0, 300);
    if (model.length === 0) {
      setError("モデル名を入れてください（「モデル一覧を取得」で選べます）。");
      return;
    }
    if (apiKey.length === 0) {
      setError("API キーを入れてください。");
      return;
    }
    if (draft.provider === "custom" && baseUrl.length === 0) {
      setError("接続先の URL を入れてください。");
      return;
    }
    const petName = draft.petName.trim().slice(0, 20) || defaultPetName(draft.characterId);
    onDone(savePetConfig({ ...draft, model, apiKey, baseUrl, petName }));
  };

  const test = async () => {
    if (testing) return;
    setTesting(true);
    setTestState(null);
    try {
      const reply = await petTestConnection({ ...draft, model: draft.model.trim(), apiKey: draft.apiKey.trim() });
      setTestState({ kind: "ok", message: `つながりました: ${reply.slice(0, 200)}` });
    } catch (cause) {
      setTestState({
        kind: "error",
        message: cause instanceof PetRelayError ? cause.message : "接続を確認できませんでした。",
      });
    } finally {
      setTesting(false);
    }
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setAvatarNote(null);
    const prepared = await preparePetAvatar(file);
    if (!prepared.ok) {
      setAvatarNote(prepared.error);
      return;
    }
    savePetAvatar(prepared.dataUrl);
    update({ characterId: "custom" });
    setAvatarNote("アップロードした画像をこの端末に保存しました（サーバーには送りません）。");
  };

  return (
    <div className="oc-pet-settings" data-testid="pet-settings">
      <p className="oc-note" data-testid="pet-setup-notice">
        {NOTICE}
      </p>

      <label className="oc-pet-field">
        <span>AI 事業者</span>
        <select
          className="oc-select"
          value={draft.provider}
          data-testid="pet-provider"
          onChange={(event) => update({ provider: event.target.value as PetConfig["provider"] })}
        >
          {PET_PROVIDER_PRESETS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <span className="oc-tiny oc-muted">{providerHint(draft.provider)}</span>
      </label>

      {draft.provider === "custom" ? (
        <label className="oc-pet-field">
          <span>接続先 URL（https）</span>
          <input
            className="oc-input"
            type="url"
            inputMode="url"
            placeholder="https://example.com/v1"
            value={draft.baseUrl}
            maxLength={300}
            data-testid="pet-base-url"
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        </label>
      ) : null}

      <div className="oc-pet-field">
        <span>モデル</span>
        <ModelPicker
          provider={draft.provider}
          baseUrl={draft.baseUrl}
          apiKey={draft.apiKey}
          value={draft.model}
          onChange={(model) => update({ model })}
        />
      </div>

      <label className="oc-pet-field">
        <span>API キー</span>
        <div className="oc-pet-key-row">
          <input
            className="oc-input"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder="API キー"
            value={draft.apiKey}
            maxLength={512}
            data-testid="pet-api-key"
            onChange={(event) => update({ apiKey: event.target.value })}
          />
          <button type="button" className="oc-btn oc-btn-sm" onClick={() => setShowKey((value) => !value)}>
            {showKey ? "隠す" : "表示"}
          </button>
        </div>
        {preset.keyPageUrl ? (
          <a className="oc-tiny" href={preset.keyPageUrl} target="_blank" rel="noreferrer noopener">
            {preset.label} の API キーを発行する（別タブ）
          </a>
        ) : (
          <span className="oc-tiny oc-muted">
            この接続先の API キーは、そのサービスの案内に従って発行してください。
          </span>
        )}
      </label>

      <label className="oc-pet-check">
        <input
          type="checkbox"
          checked={draft.remember}
          data-testid="pet-remember"
          onChange={(event) => update({ remember: event.target.checked })}
        />
        <span>
          この端末に覚えておく
          <span className="oc-tiny oc-muted">（オフにするとタブを閉じるまで）</span>
        </span>
      </label>

      <div className="oc-pet-field">
        <div className="oc-row">
          <button
            type="button"
            className="oc-btn oc-btn-sm"
            data-testid="pet-test-connection"
            disabled={testing || draft.apiKey.trim().length === 0 || draft.model.trim().length === 0}
            onClick={() => void test()}
          >
            {testing ? "確認中…" : "接続を試す"}
          </button>
          <span className="oc-tiny oc-muted">短い文を 1 回だけ送ります。</span>
        </div>
        {testState ? (
          <p
            className={testState.kind === "ok" ? "oc-tiny oc-ok-text" : "oc-tiny oc-error-text"}
            role={testState.kind === "error" ? "alert" : "status"}
            data-testid="pet-test-result"
          >
            {testState.message}
          </p>
        ) : null}
      </div>

      <div className="oc-pet-field">
        <span>見た目</span>
        <div className="oc-pet-character-list" role="radiogroup" aria-label="ペットの見た目">
          {PET_CHARACTERS.map((character) => (
            <label
              key={character.id}
              className={draft.characterId === character.id ? "oc-pet-character active" : "oc-pet-character"}
            >
              <input
                type="radio"
                name="pet-character"
                value={character.id}
                checked={draft.characterId === character.id}
                onChange={() => update({ characterId: character.id })}
              />
              <PetAvatar characterId={character.id} name={draft.petName} size={40} />
              <span>{character.label}</span>
            </label>
          ))}
          {uploaded || draft.characterId === "custom" ? (
            <label
              className={draft.characterId === "custom" ? "oc-pet-character active" : "oc-pet-character"}
              data-testid="pet-character-custom"
            >
              <input
                type="radio"
                name="pet-character"
                value="custom"
                checked={draft.characterId === "custom"}
                onChange={() => update({ characterId: "custom" })}
              />
              <PetAvatar characterId="custom" name={draft.petName} size={40} />
              <span>アップロードした画像</span>
            </label>
          ) : null}
        </div>
        <div className="oc-pet-field">
          <span className="oc-tiny oc-muted">画像をアップロード（png・jpeg・webp・gif、5MB まで）</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            data-testid="pet-avatar-file"
            onChange={(event) => void pickAvatar(event.target.files?.[0])}
          />
        </div>
        {avatarNote ? (
          <p className="oc-tiny" role="status">
            {avatarNote}
          </p>
        ) : null}
      </div>

      <label className="oc-pet-field">
        <span>名前（20 文字まで）</span>
        <div className="oc-pet-key-row">
          <input
            className="oc-input"
            value={draft.petName}
            maxLength={20}
            data-testid="pet-name"
            onChange={(event) => update({ petName: event.target.value })}
          />
          <button
            type="button"
            className="oc-btn oc-btn-sm"
            onClick={() => update({ petName: defaultPetName(draft.characterId) })}
          >
            既定に戻す
          </button>
        </div>
      </label>

      {error ? (
        <p className="oc-error-text" role="alert" data-testid="pet-settings-error">
          {error}
        </p>
      ) : null}

      <div className="oc-pet-settings-actions">
        {onClose ? (
          <button type="button" className="oc-btn" onClick={onClose}>
            閉じる
          </button>
        ) : null}
        <button type="button" className="oc-btn oc-btn-primary" data-testid="pet-save" onClick={save}>
          {mode === "setup" ? "保存して始める" : "保存"}
        </button>
      </div>
    </div>
  );
}