"use client";

// ペットのパネル（会話・確認カード・設定）。初めて開いたときに読み込まれる（`pet-root.tsx` が dynamic import）。
//
// 会話の進行は `agent.ts`。ここは「並べて出す・入力を渡す・確認カードの返事を返す」だけを持つ。
// 中継のエラーは `relay-client.ts` が日本語にした文を、そのまま「注意書き」として会話に足す。

import { useCallback, useEffect, useRef, useState } from "react";
import { navigate } from "@/app/_shell/router";
import { toolResultContent, runPetTurn } from "../agent";
import type { PetApproval, PetConfirmRequest } from "../contract";
import { buildPetSystemPrompt } from "../prompt";
import { PetRelayError, petChat } from "../relay-client";
import { clearPetConfig, defaultPetConfig, isPetConfigured, savePetUiState } from "../settings";
import { getPetTools } from "../tools";
import { readPageContext } from "../tools/page-context";
import {
  appendEntry,
  clearEntries,
  entriesToMessages,
  loadEntries,
  newEntryKey,
  saveEntries,
  type PetEntry,
} from "./conversation-store";
import { shouldSendOnEnter } from "./enter-key";
import { createPendingConfirms } from "./pending-confirms";
import { PetAvatar } from "./pet-avatar";
import { PetConfirmCard } from "./pet-confirm-card";
import { PetSettingsForm } from "./pet-settings-form";
import { PetText } from "./pet-text";
import { usePetConfig, usePetUiState } from "./use-pet-settings";
import { useVoiceInput } from "./voice-input";

const GREETING = "こんにちは。使い方の案内、掲示板の操作の代行、要約、自分用プラグインの作成を手伝います。何でも聞いてください。";

export function PetPanel({ onClose, onHide }: { onClose: () => void; onHide: () => void }) {
  const stored = usePetConfig();
  const ui = usePetUiState();
  const config = stored ?? defaultPetConfig();
  const configured = isPetConfigured(stored);

  const [entries, setEntries] = useState<PetEntry[]>(() => loadEntries());
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [pending] = useState(createPendingConfirms);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const voice = useVoiceInput((text) => {
    setDraft((current) => (current.length > 0 ? `${current}${text}` : text));
  });

  useEffect(() => {
    saveEntries(entries);
  }, [entries]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries, progress]);

  useEffect(() => {
    if (configured && view === "chat") inputRef.current?.focus();
  }, [configured, view]);

  const pushNotice = (text: string, tone: "info" | "error" = "info") => {
    setEntries((current) => appendEntry(current, { key: newEntryKey(), at: Date.now(), role: "notice", text, tone }));
  };

  const cancelAllPending = useCallback(() => {
    const keys = new Set(pending.cancelAll());
    if (keys.size === 0) return;
    setEntries((current) =>
      current.map((entry) =>
        entry.role === "confirm" && keys.has(entry.key) ? { ...entry, decision: "canceled" } : entry,
      ),
    );
  }, [pending]);

  // 画面を閉じたときに待ちだけが残らないようにする（約束は取り消しで解決する）。
  useEffect(
    () => () => {
      pending.cancelAll();
    },
    [pending],
  );

  // Esc: 確認カードがあれば取り消す、設定中なら会話へ、それ以外は閉じる。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 内側の部品（モデル一覧など）が Esc を処理した場合は、パネルは閉じない。
      if (event.defaultPrevented) return;
      if (pending.size() > 0) {
        cancelAllPending();
        return;
      }
      if (view === "settings" && configured) {
        setView("chat");
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancelAllPending, configured, onClose, pending, view]);

  const stop = () => {
    abortRef.current?.abort();
    cancelAllPending();
  };

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || busy || !configured) return;
    const userEntry: PetEntry = { key: newEntryKey(), at: Date.now(), role: "user", content: text.slice(0, 24_000) };
    const next = appendEntry(entries, userEntry);
    setEntries(next);
    setDraft("");
    setBusy(true);
    setProgress(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const page = readPageContext();

    try {
      const result = await runPetTurn({
        config: stored,
        system: buildPetSystemPrompt({ petName: stored.petName, page }),
        tools: getPetTools(),
        ctx: { signal: controller.signal, page, navigate: (path) => navigate(path) },
        messages: entriesToMessages(next),
        send: (input, options) => petChat(stored, input, { signal: options.signal }),
        confirm: (request: PetConfirmRequest) => {
          const { promise, resolve } = Promise.withResolvers<PetApproval | null>();
          const key = newEntryKey();
          setEntries((current) => appendEntry(current, { key, at: Date.now(), role: "confirm", request, decision: null }));
          pending.add(key, resolve);
          return promise;
        },
        onEvent: (event) => {
          if (event.type === "assistant") {
            if (event.content === null && event.toolCalls.length === 0) return;
            setEntries((current) =>
              appendEntry(current, {
                key: newEntryKey(),
                at: Date.now(),
                role: "assistant",
                content: event.content,
                toolCalls: event.toolCalls,
              }),
            );
          } else if (event.type === "tool_start") {
            setProgress(event.label);
          } else if (event.type === "tool_end") {
            setProgress(null);
            setEntries((current) =>
              appendEntry(current, {
                key: newEntryKey(),
                at: Date.now(),
                role: "tool",
                toolCallId: event.call.id,
                name: event.call.name,
                label: event.label,
                content: toolResultContent(event.result),
                result: event.result,
              }),
            );
          }
        },
      });
      if (result.limitReached) {
        pushNotice("ツールの利用が上限（8 往復）に達しました。続けて頼むと、そこから再開できます。");
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        pushNotice("止めました。");
      } else if (cause instanceof PetRelayError) {
        pushNotice(cause.message, "error");
      } else {
        pushNotice(cause instanceof Error ? cause.message : "会話を続けられませんでした。", "error");
      }
    } finally {
      setBusy(false);
      setProgress(null);
      abortRef.current = null;
    }
  };

  const decideConfirm = (key: string, decision: "approved" | "canceled", turnstileToken: string | null) => {
    setEntries((current) =>
      current.map((entry) => (entry.role === "confirm" && entry.key === key ? { ...entry, decision } : entry)),
    );
    pending.decide(key, decision === "approved" ? { turnstileToken } : null);
  };

  const clearChat = () => {
    clearEntries();
    setEntries([]);
    setProgress(null);
  };

  const startVoice = () => {
    if (!ui.voiceNoticeSeen) savePetUiState({ voiceNoticeSeen: true });
    voice.start();
  };

  const showSetup = !configured || view === "settings";
  const page = showSetup ? null : readPageContext();

  return (
    <div
      className="oc-pet-panel"
      role="dialog"
      aria-label="AI ペット"
      data-testid="pet-panel"
    >
      <div className="oc-pet-head">
        <PetAvatar
          characterId={config.characterId}
          name={config.petName}
          size={34}
          className={busy ? "oc-pet-talk" : "oc-pet-float"}
        />
        <span className="oc-pet-name" data-testid="pet-head-name">
          {config.petName}
        </span>
        <span className="oc-spacer" />
        {configured ? (
          <button
            type="button"
            className="oc-btn oc-btn-sm"
            data-testid="pet-open-settings"
            title="設定（事業者・モデル・API キー・見た目）"
            onClick={() => setView(view === "settings" ? "chat" : "settings")}
            disabled={busy}
          >
            設定
          </button>
        ) : null}
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          data-testid="pet-clear"
          title="会話を消す"
          aria-label="会話を消す"
          onClick={clearChat}
          disabled={busy}
        >
          消去
        </button>
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          data-testid="pet-hide"
          title="しまう（ヘッダーの「ペット」で戻せます）"
          onClick={onHide}
        >
          しまう
        </button>
        <button
          type="button"
          className="oc-icon-btn"
          data-testid="pet-close"
          aria-label="閉じる"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {showSetup ? (
        <div className="oc-pet-body">
          {configured ? null : (
            <p className="oc-small" style={{ margin: "0 0 6px" }}>
              はじめに、使う AI 事業者とモデル・API キーを決めてください。あとから「設定」で変えられます。
            </p>
          )}
          <PetSettingsForm
            mode={configured ? "settings" : "setup"}
            initialConfig={configured ? stored : config}
            onDone={(saved) => {
              if (!configured) pushNotice(`${saved.petName}です。よろしくね。何でも聞いてください。`);
              setView("chat");
            }}
            onClose={configured ? () => setView("chat") : undefined}
          />
          {configured ? (
            <button
              type="button"
              className="oc-btn oc-btn-sm oc-mt"
              onClick={() => {
                clearPetConfig();
                setView("chat");
              }}
            >
              設定を消す（最初の設定に戻る）
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="oc-pet-body oc-pet-messages" ref={listRef} data-testid="pet-messages" aria-live="polite">
            {entries.length === 0 ? <p className="oc-pet-greeting">{GREETING}</p> : null}
            {entries.map((entry) => {
              switch (entry.role) {
                case "user":
                  return (
                    <div key={entry.key} className="oc-pet-row oc-pet-row-user">
                      <div className="oc-pet-bubble oc-pet-bubble-user">
                        <PetText text={entry.content} />
                      </div>
                    </div>
                  );
                case "assistant":
                  return (
                    <div key={entry.key} className="oc-pet-row oc-pet-row-pet">
                      <PetAvatar characterId={config.characterId} name={config.petName} size={24} />
                      <div className="oc-pet-bubble">
                        {entry.content ? <PetText text={entry.content} /> : null}
                        {entry.toolCalls.length > 0 && !entry.content ? (
                          <span className="oc-tiny oc-muted">（ツールを使います）</span>
                        ) : null}
                      </div>
                    </div>
                  );
                case "tool":
                  return (
                    <div key={entry.key} className="oc-pet-tool" data-testid="pet-tool-line">
                      <span>{entry.label}</span>
                      <span className={entry.result.ok ? "oc-pet-tool-ok" : "oc-pet-tool-ng"}>
                        {entry.result.ok ? "完了" : "できませんでした"}
                      </span>
                      {entry.result.ok ? null : <span className="oc-tiny oc-error-text">{entry.result.error}</span>}
                    </div>
                  );
                case "confirm":
                  return (
                    <PetConfirmCard
                      key={entry.key}
                      request={entry.request}
                      boardSlug={page?.boardSlug ?? null}
                      decision={entry.decision}
                      onDecide={(decision, token) => decideConfirm(entry.key, decision, token)}
                    />
                  );
                case "notice":
                  return (
                    <p
                      key={entry.key}
                      className={entry.tone === "error" ? "oc-pet-notice oc-error-text" : "oc-pet-notice"}
                      role={entry.tone === "error" ? "alert" : "status"}
                      data-testid="pet-notice"
                    >
                      {entry.text}
                    </p>
                  );
                default:
                  return null;
              }
            })}
            {progress ? (
              <div className="oc-pet-progress" role="status" data-testid="pet-progress">
                <PetAvatar
                  characterId={config.characterId}
                  name={config.petName}
                  size={24}
                  className="oc-pet-think"
                />
                <span>{progress}</span>
                <span className="oc-pet-dots" aria-hidden="true">
                  …
                </span>
              </div>
            ) : null}
          </div>

          <div className="oc-pet-composer">
            {voice.supported ? (
              <button
                type="button"
                className={voice.listening ? "oc-btn oc-btn-sm oc-btn-primary" : "oc-btn oc-btn-sm"}
                data-testid="pet-mic"
                aria-label={voice.listening ? "音声入力を止める" : "音声入力"}
                title="音声入力（話した言葉を入力欄の文字にします）"
                onClick={() => (voice.listening ? voice.stop() : startVoice())}
              >
                {voice.listening ? "■" : "🎤"}
              </button>
            ) : null}
            <textarea
              ref={inputRef}
              className="oc-pet-input"
              rows={2}
              value={draft}
              data-testid="pet-input"
              placeholder="聞きたいことを書く（Enter で送る / Shift+Enter で改行）"
              maxLength={24_000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  shouldSendOnEnter({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                    keyCode: event.keyCode,
                  })
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="button"
              className={busy ? "oc-btn" : "oc-btn oc-btn-primary"}
              data-testid="pet-send"
              onClick={() => (busy ? stop() : void send())}
            >
              {busy ? "止める" : "送る"}
            </button>
          </div>
          {voice.interim ? (
            <p className="oc-tiny oc-muted oc-pet-interim" data-testid="pet-voice-interim">
              聞き取り中: {voice.interim}
            </p>
          ) : null}
          {voice.error ? (
            <p className="oc-tiny oc-error-text oc-pet-interim" role="alert">
              {voice.error}
            </p>
          ) : null}
          {voice.supported && !ui.voiceNoticeSeen ? (
            <p className="oc-pet-voice-note" data-testid="pet-voice-notice">
              音声はブラウザの音声認識で文字にされます（Chrome では Google のサーバーに送られます）。
              <button type="button" className="oc-btn oc-btn-sm" onClick={() => savePetUiState({ voiceNoticeSeen: true })}>
                わかった
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}