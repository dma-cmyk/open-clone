"use client";

// 音声入力（Web Speech API。`ja-JP`）。話した言葉を入力欄の文字にする。
// 対応していないブラウザではボタンを出さない（`speechRecognitionCtor()` が null）。
//
// 音声はブラウザの音声認識で文字にされる。Chrome では Google のサーバーに送られるため、
// 初回にその旨を画面で案内する（`settings.ts` の voiceNoticeSeen）。
// e2e は `addInitScript` で偽の `webkitSpeechRecognition` を入れ、このフックの配線を確かめる。

import { useEffect, useRef, useState } from "react";

export interface SpeechAlternative {
  transcript: string;
  confidence?: number;
}

export interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
}

export interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResult };
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

export function speechRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const globals = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return globals.SpeechRecognition ?? globals.webkitSpeechRecognition ?? null;
}

function voiceErrorMessage(code: string | undefined): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "マイクの使用が許可されていません。ブラウザの許可を確かめてください。";
    case "no-speech":
      return "音声が聞き取れませんでした。もう一度話してください。";
    case "network":
      return "音声認識に接続できませんでした。ネットワークを確かめてください。";
    case "audio-capture":
      return "マイクが見つかりませんでした。";
    default:
      return "音声入力を続けられませんでした。もう一度試してください。";
  }
}

/** 認識結果から「確定した文」と「変換中の文」を取り出す。 */
export function readSpeechResults(event: SpeechResultEvent): { finalText: string; interimText: string } {
  let finalText = "";
  let interimText = "";
  const results = event.results;
  for (let index = 0; index < (results?.length ?? 0); index += 1) {
    const result = results[index];
    const transcript = result?.[0]?.transcript ?? "";
    if (result?.isFinal) finalText += transcript;
    else interimText += transcript;
  }
  return { finalText, interimText };
}

export interface VoiceInputState {
  /** このブラウザで音声入力が使えるか（マウント後に判定する）。 */
  supported: boolean;
  listening: boolean;
  /** 変換中の文（入力欄の下に出す）。 */
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
}

/** 話した文が確定するたびに `onFinal` を呼ぶ。 */
export function useVoiceInput(onFinal: (text: string) => void): VoiceInputState {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setSupported(speechRecognitionCtor() !== null);
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const start = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    recognitionRef.current?.abort();
    const recognition = new Ctor();
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const { finalText, interimText } = readSpeechResults(event);
      setInterim(interimText);
      if (finalText.trim().length > 0) {
        setInterim("");
        onFinalRef.current(finalText);
      }
    };
    recognition.onerror = (event) => {
      // 利用者が止めた（aborted）ときは、失敗の文を出さない。
      if (event.error === "aborted") {
        setListening(false);
        return;
      }
      setError(voiceErrorMessage(event.error));
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      setInterim("");
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setError(null);
    setInterim("");
    try {
      recognition.start();
      setListening(true);
    } catch {
      setError(voiceErrorMessage(undefined));
      recognitionRef.current = null;
    }
  };

  const stop = () => {
    recognitionRef.current?.stop();
  };

  return { supported, listening, interim, error, start, stop };
}