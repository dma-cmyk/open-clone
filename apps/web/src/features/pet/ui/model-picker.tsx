"use client";

// モデル名の入力欄（検索できる一覧 = combobox / listbox）。
//
// - 「モデル一覧を取得」を押したときだけ中継 API（`POST /pet/models`）へキーを送る。自動では取らない。
// - 取った一覧は入力中の文字で絞り込む（部分一致・大文字小文字を区別しない）。
// - ↑↓ で選び、Enter で決め、Esc で閉じる。表示名があれば id と並べる。
// - 取得できないときは理由を出し、自由入力のまま使える（一覧を取れなくても保存できる）。
// - 一覧は保存しない（表示中の設定画面だけ。キーや事業者が変われば捨てる）。

import { useEffect, useId, useMemo, useState } from "react";
import type { PetModelInfo, PetProviderId } from "shared";
import { petModels, PetRelayError } from "../relay-client";

const VISIBLE_MAX = 100;

export function ModelPicker({
  provider,
  baseUrl,
  apiKey,
  value,
  onChange,
  disabled,
}: {
  provider: PetProviderId;
  baseUrl: string;
  apiKey: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const [fetched, setFetched] = useState<{ key: string; models: PetModelInfo[]; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // キー・事業者・接続先が変わったら、前の一覧は使わない（別のキーで取った一覧を混ぜない）。
  const requestKey = `${provider}|${baseUrl.trim()}|${apiKey}`;
  const models = fetched !== null && fetched.key === requestKey ? fetched.models : null;

  const filtered = useMemo(() => {
    if (!models) return [];
    const query = value.trim().toLowerCase();
    if (query.length === 0) return models;
    return models.filter(
      (model) => model.id.toLowerCase().includes(query) || (model.label ?? "").toLowerCase().includes(query),
    );
  }, [models, value]);

  const shown = filtered.slice(0, VISIBLE_MAX);
  const expanded = open && shown.length > 0;
  useEffect(() => {
    setActiveIndex(0);
  }, [value, models]);

  const canFetch = !disabled && !loading && apiKey.trim().length > 0 && (provider !== "custom" || baseUrl.trim().length > 0);

  const fetchModels = async () => {
    if (!canFetch) return;
    setLoading(true);
    setError(null);
    try {
      const response = await petModels({ provider, baseUrl, apiKey });
      setFetched({ key: requestKey, models: response.models, truncated: response.truncated });
      setOpen(true);
      if (response.models.length === 0) {
        setError("モデル一覧が空でした。モデル名を直接入れてください。");
      }
    } catch (cause) {
      setFetched(null);
      setOpen(false);
      setError(
        cause instanceof PetRelayError
          ? cause.message
          : "モデル一覧を取得できませんでした。モデル名を直接入れてください。",
      );
    } finally {
      setLoading(false);
    }
  };

  const choose = (model: PetModelInfo) => {
    onChange(model.id);
    setOpen(false);
  };

  return (
    <div className="oc-pet-model">
      <div className="oc-pet-model-row">
        <input
          className="oc-input"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && shown[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="モデル名（例: gpt-4o-mini）"
          value={value}
          maxLength={200}
          data-testid="pet-model-input"
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (models) setOpen(true);
          }}
          onBlur={() => {
            // 候補のクリック（onMouseDown で preventDefault）以外では閉じる。
            setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              if (shown.length === 0) return;
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => (index + 1) % shown.length);
            } else if (event.key === "ArrowUp") {
              if (shown.length === 0) return;
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => (index - 1 + shown.length) % shown.length);
            } else if (event.key === "Enter") {
              if (!expanded) return;
              event.preventDefault();
              const model = shown[activeIndex];
              if (model) choose(model);
            } else if (event.key === "Escape") {
              if (expanded) {
                event.preventDefault();
                // パネル（document の keydown）まで Esc を届かせない。一覧だけ閉じる。
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                setOpen(false);
              }
            }
          }}
        />
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          data-testid="pet-model-fetch"
          disabled={!canFetch}
          onClick={() => void fetchModels()}
          title={canFetch ? "事業者からモデル一覧を取り、検索して選べます" : "事業者と API キーを入れると使えます"}
        >
          {loading ? "取得中…" : "モデル一覧を取得"}
        </button>
      </div>
      {expanded ? (
        <ul className="oc-pet-model-list" role="listbox" id={listId} data-testid="pet-model-list">
          {shown.map((model, index) => (
            <li
              key={model.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "oc-pet-model-option active" : "oc-pet-model-option"}
              data-model-id={model.id}
              // 入力欄の blur より先に選ぶ（クリックで閉じて選べない問題を避ける）。
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(model)}
            >
              <span className="oc-pet-model-id">{model.id}</span>
              {model.label && model.label !== model.id ? <span className="oc-pet-model-label">{model.label}</span> : null}
            </li>
          ))}
          {filtered.length > shown.length ? (
            <li className="oc-pet-model-more" role="presentation">
              ほか {filtered.length - shown.length} 件（文字を入れて絞り込んでください）
            </li>
          ) : null}
        </ul>
      ) : null}
      {models && filtered.length === 0 ? (
        <p className="oc-tiny oc-muted" data-testid="pet-model-empty">
          一覧に「{value.trim()}」に合うモデルがありません。この名前のまま使えます。
        </p>
      ) : null}
      {fetched?.truncated ? <p className="oc-tiny oc-muted">一覧が多いため、一部だけ表示しています。</p> : null}
      {error ? (
        <p className="oc-tiny oc-error-text" role="alert" data-testid="pet-model-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}