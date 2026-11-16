"use client";

// Cloudflare Turnstile ウィジェット（Bot 対策 / CONTRACTS §4.2）。
// ローカル・CI は公式テストキー。本番は NEXT_PUBLIC_TURNSTILE_SITE_KEY を設定する。
//
// 1 フォームにつきウィジェットは 1 個だけ描く（F-06）。投稿フォームはアップロードでも同じ
// トークンを使うため、ウィジェットを持たずにトークンだけを受け取る（`useTurnstileToken`）。
// サイズは `normal`（300×65 の 1 行）を基本にし、コンテナが狭いときだけ `flexible` に落とす。
// 以前は `compact`（150×140）を使っていたため「私はロボットではありません」が折り返し、
// 縦 180px の空白になっていた（museAI #5）。

import { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

// グローバル宣言は他の同名宣言と衝突するため行わない。外部スクリプトが生やす API を
// 構造的に読む（型はこのファイル内の TurnstileApi に限定）。
function turnstileApi(): TurnstileApi | undefined {
  const globals = window as unknown as { turnstile?: TurnstileApi };
  return globals.turnstile;
}

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA";

const SCRIPT_ID = "cf-turnstile-script";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (turnstileApi()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const existing = document.getElementById(SCRIPT_ID);
  if (existing) {
    existing.addEventListener("load", () => resolve());
    existing.addEventListener("error", () => reject(new Error("Turnstile の読み込みに失敗しました")));
    scriptPromise = promise;
    return promise;
  }
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.onload = () => resolve();
  script.onerror = () => reject(new Error("Turnstile の読み込みに失敗しました"));
  document.head.appendChild(script);
  scriptPromise = promise;
  return promise;
}

/** Turnstile の `normal` サイズ（1 行）に必要な幅。これ未満なら折り返すので flexible にする。 */
const NORMAL_MIN_WIDTH = 300;

/** 描画時点のコンテナ幅からウィジェットサイズを選ぶ（描画後に変えても意味がない）。 */
function sizeOf(element: HTMLElement): "normal" | "flexible" {
  const width = element.clientWidth || element.parentElement?.clientWidth || 0;
  return width > 0 && width < NORMAL_MIN_WIDTH ? "flexible" : "normal";
}

export function TurnstileWidget({
  onToken,
  onInvalidate,
  resetKey = 0,
}: {
  /** トークン取得・失効の通知。呼び出し側で安定させる（useCallback）前提。 */
  onToken: (token: string) => void;
  /**
   * このウィジェットのトークンが使えなくなったことを知らせる（ウィジェットの削除・リセット時）。
   * フォームが保持している古いトークンを捨てるために呼ぶ。
   */
  onInvalidate?: () => void;
  /** 増やすとウィジェットをリセットして新しいトークンを取り直す（トークンは 1 回限り）。 */
  resetKey?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const renderedKey = useRef<number | null>(null);
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;
  const [failed, setFailed] = useState(false);
  // interaction-only では普段ウィジェットが見えない。操作が必要になったときだけ枠を出す。
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!TURNSTILE_SITE_KEY) {
      setFailed(true);
      return;
    }
    loadScript()
      .then(() => {
        const api = turnstileApi();
        if (!alive || !container.current || !api) return;
        if (widgetId.current) {
          // React 19 の StrictMode 再マウントや resetKey 変更では、既存ウィジェットを再利用する。
          // ここで render を呼ぶと 1 つのコンテナに 2 個目が積まれ、二重表示になる。
          if (renderedKey.current !== resetKey) {
            renderedKey.current = resetKey;
            // リセットすると前のトークンは無効。フォームの保持値も捨てる。
            onInvalidateRef.current?.();
            api.reset(widgetId.current);
          }
          return;
        }
        renderedKey.current = resetKey;
        widgetId.current = api.render(container.current, {
          sitekey: TURNSTILE_SITE_KEY,
          size: sizeOf(container.current),
          theme: "light",
          language: "ja",
          // ふだんは裏で自動的に検証し、操作が必要なときだけ見せる（報告書 81 / B）。
          appearance: "interaction-only",
          callback: (token: string) => onToken(token),
          "before-interactive-callback": () => setVisible(true),
          "expired-callback": () => onToken(""),
          "error-callback": () => setFailed(true),
        });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
    };
    // onToken は呼び出し側で安定させる（useCallback）前提。
  }, [onToken, resetKey]);

  useEffect(
    () => () => {
      const api = turnstileApi();
      if (widgetId.current && api) {
        api.remove(widgetId.current);
        widgetId.current = null;
        renderedKey.current = null;
        // ウィジェットごと消えるので、保持していたトークンは使えない（開閉で古い値が残る問題）。
        onInvalidateRef.current?.();
      }
    },
    [],
  );

  return (
    <div className="oc-turnstile">
      <div ref={container} className="oc-turnstile-slot" style={visible ? undefined : { minHeight: 0 }} />
      {failed ? (
        <p className="oc-note" role="status">
          Bot 確認を読み込めませんでした（ネットワークまたは Turnstile 設定を確認してください）。
        </p>
      ) : null}
    </div>
  );
}

/**
 * 1 フォーム分の Turnstile 状態（要否の判定・トークン保持・1 回限りの受け渡し）。
 *
 * - `policy` は板設定（off / anonymous / always）とログイン状態から要否を決める。
 * - `take()` はトークンを **1 つだけ** 消費する。まだ届いていなければ、ウィジェットの成功を待つ
 *   （投稿の送信時にトークンが空で 400 になるのを防ぐ）。
 * - 消費したら `resetKey` を進めてウィジェットを取り直させ、次の成功通知まで新しい値は渡さない。
 *   待ち手に渡す経路でも同じで、渡した値は保持しない（投稿と添付で同じトークンを使わない）。
 * - ウィジェットが消える・リセットされると `invalidate()` で保持値を捨てる
 *   （投稿欄を閉じて開き直したときに古いトークンを送らない）。
 *
 * ウィジェット（TurnstileWidget）は呼び出し側が 1 個だけ描く。アップロードも投稿も同じ
 * `take()` を使うため、フォーム内でトークンの出どころが 1 つになる（F-06 の再発防止）。
 */
export interface TurnstileTokenController {
  /** このフォームで Bot 確認が必要か（ウィジェットを描くかの判断に使う）。 */
  needed: boolean;
  /**
   * 板・ログイン状態から見た「確認が要るか」（省略 pass を考慮しない）。
   * 添付のトークン要求はこれに従う（レビュー 84 / R82-05 の回帰修正）。
   */
  policyNeeds: boolean;
  /** ウィジェットの `resetKey`。 */
  resetKey: number;
  /** ウィジェットの成功／失効コールバック。 */
  accept: (token: string) => void;
  /**
   * トークンを 1 つ取り出す（必要ない設定なら undefined）。
   * `forUpload: true` は添付用。添付は「確認済みの省略」の対象外なので、
   * 期限内でも新しいトークンを待つ（レビュー 82 / R82-05）。
   */
  take: (options?: { forUpload?: boolean }) => Promise<string | undefined>;
  /** 保持しているトークンを捨てる（ウィジェットの削除・リセット時に呼ぶ）。 */
  invalidate: () => void;
  /**
   * 添付のためにウィジェットをマウントすべきか（省略中は false のまま＝DOM にも出さない）。
   * 添付が始まると true になる（レビュー 82 / R82-05）。
   */
  uploadWidget: boolean;
}

/** ウィジェットの成功を待つ上限。超えたら「確認を完了してください」と伝える。 */
const TOKEN_TIMEOUT_MS = 20_000;

interface Waiter {
  resolve: (token: string) => void;
  reject: (cause: Error) => void;
  timer: number;
}

export function useTurnstileToken(
  policy: "off" | "anonymous" | "always",
  /**
   * サーバーが「この端末は期限内の確認済み」と答えた場合 true。
   * そのときはウィジェットを出さず、トークンも要求しない（サーバー側で省略される）。
   */
  alreadyPassed = false,
): TurnstileTokenController {
  const [needed, setNeeded] = useState(policy !== "off" && !alreadyPassed);
  // 省略 pass を除いた「確認そのものが必要か」。添付（アップロード）はこちらで判断する。
  const [policyNeeds, setPolicyNeeds] = useState(policy !== "off");
  const [resetKey, setResetKey] = useState(0);
  const [uploadWidget, setUploadWidget] = useState(false);
  /** 未消費のトークン（高々 1 個）。 */
  const tokenRef = useRef("");
  /** 直前に受け取った値。同じ値の二重通知（同じ callback の再入）を無視するために使う。 */
  const lastAcceptedRef = useRef("");
  const waitersRef = useRef<Waiter[]>([]);
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const policyNeedsRef = useRef(policy !== "off");
  policyNeedsRef.current = policyNeeds;

  // 要否の判定。判定中にアップロードが始まっても取りこぼさないよう、結果を待たせる。
  const decisionRef = useRef<{ promise: Promise<boolean>; resolve: (value: boolean) => void } | null>(null);
  useEffect(() => {
    const decision = Promise.withResolvers<boolean>();
    decisionRef.current = decision;
    // アンマウント時のフォールバック（判定が未了のまま残ると待ち手が永遠に待つのを防ぐ）。
    const fallback = policy !== "off";
    const settle = (value: boolean) => {
      decision.resolve(value);
      setNeeded(value);
      setPolicyNeeds(value);
      // 添付の判断は非同期の take() から読むので、ref も同時に更新する。
      policyNeedsRef.current = value;
    };
    if (policy === "off") {
      settle(false);
      return;
    }
    if (policy === "always") {
      settle(true);
      return;
    }
    if (alreadyPassed) {
      // 期限内の確認済み（サーバーが判定）。ウィジェットもトークンも不要。
      // ただし「確認そのものが必要か」は true のまま（添付はトークンが要る）。
      decision.resolve(false);
      setNeeded(false);
      setPolicyNeeds(true);
      policyNeedsRef.current = true;
      return;
    }
    let alive = true;
    api
      .getSession()
      .then((session) => {
        if (alive) settle(!session);
      })
      .catch(() => {
        if (alive) settle(false);
      });
    return () => {
      alive = false;
      decision.resolve(fallback);
    };
  }, [policy, alreadyPassed]);

  // アンマウント時は待ち手を必ず終わらせる（タイマーだけ消すと Promise が宙に浮く）。
  useEffect(
    () => () => {
      for (const waiter of waitersRef.current) {
        window.clearTimeout(waiter.timer);
        waiter.reject(new Error("投稿欄が閉じられたため、Bot 確認をやり直してください"));
      }
      waitersRef.current = [];
      tokenRef.current = "";
    },
    [],
  );

  const accept = (token: string) => {
    if (!token) {
      // 期限切れ。保持値を捨て、待ち手は新しい成功通知を待たせる（タイムアウトで案内する）。
      tokenRef.current = "";
      return;
    }
    // 同じ callback が同じ値を二度通知しても、2 個ぶんとして数えない。
    if (token === lastAcceptedRef.current) return;
    lastAcceptedRef.current = token;

    const waiter = waitersRef.current.shift();
    if (!waiter) {
      // 誰も待っていなければ保持する（次の take で 1 回だけ使う）。
      tokenRef.current = token;
      return;
    }
    // 待ち手に渡した値は保持しない。ウィジェットを取り直させ、次の消費は新しい通知を待つ。
    tokenRef.current = "";
    window.clearTimeout(waiter.timer);
    setResetKey((value) => value + 1);
    waiter.resolve(token);
  };

  const take = async (options: { forUpload?: boolean } = {}): Promise<string | undefined> => {
    const neededNow = decisionRef.current ? await decisionRef.current.promise : policyRef.current !== "off";
    // 投稿の省略（alreadyPassed）でも、添付は「板・ログインの要否」に従ってトークンを取る。
    if (options.forUpload === true) {
      // 添付の要否は「板・ログインから見た確認の要否」（pass を除く）だけで決める。
      if (!policyNeedsRef.current) return undefined;
      setUploadWidget(true);
    } else if (!neededNow) {
      return undefined;
    }
    const current = tokenRef.current;
    if (current) {
      tokenRef.current = "";
      setResetKey((value) => value + 1);
      return current;
    }
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const timer = window.setTimeout(() => {
      waitersRef.current = waitersRef.current.filter((entry) => entry.timer !== timer);
      reject(new Error("Bot 確認（Turnstile）が完了していません。チェックを済ませてから送信してください"));
    }, TOKEN_TIMEOUT_MS);
    waitersRef.current.push({ resolve, reject, timer });
    return promise;
  };

  const invalidate = () => {
    tokenRef.current = "";
  };

  return { needed, policyNeeds, resetKey, accept, take, invalidate, uploadWidget };
}
