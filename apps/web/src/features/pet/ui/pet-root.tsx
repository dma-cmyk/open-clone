"use client";

// 全ページに置くペット（呼び出しボタンとパネル）。
//
// - 呼び出しボタンは軽い（絵とボタンだけ）。パネルと会話の処理は初めて開くときに読み込む（dynamic import）。
// - 右下に固定。サイトツアー中は出さない（ツアーの吹き出しと重ならないように）。
//   ツアーの状態を購読するのはこのボタンの中だけにして、関係ない再描画をルートへ広げない。
// - 「しまう」とボタンを消し、ヘッダーの「ペット」から呼び戻せる（どちらもこの端末に保存）。
// - 右下のボタンがページの最後の操作（投稿の送信など）に重ならないよう、ページの末尾に余白を足し、
//   下に貼り付いた投稿欄と重なるときは上へ逃がす。

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useTourState } from "@/features/site-tour";
import { DEFAULT_PET_CHARACTER_ID } from "../characters";
import { defaultPetName, savePetUiState } from "../settings";
import { subscribePetOpen } from "./open-store";
import { PetAvatar } from "./pet-avatar";
import { usePetConfig, usePetUiState } from "./use-pet-settings";

const PetPanel = dynamic(() => import("./pet-panel").then((module) => module.PetPanel), {
  ssr: false,
  loading: () => (
    <div className="oc-pet-panel oc-pet-panel-loading" role="status">
      ペットを読み込んでいます…
    </div>
  ),
});

/**
 * 右下のボタンが、ページの下のほうにある操作（「投稿する」「書き込む」バー、浮かせた投稿欄）に
 * 重ならないよう、ボタンの位置を上へ逃がす（CSS 変数 `--oc-pet-lift`）。
 * 画面のスクロール（投稿欄の中のスクロールも）・大きさの変更・画面の差し替えで測り直す。
 */
function useLauncherLift(node: HTMLButtonElement | null, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // 元の位置で測る（前回の逃がした分を戻してから）。
      node.style.setProperty("--oc-pet-lift", "0px");
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      let needed = 0;
      for (const target of document.querySelectorAll<HTMLElement>(
        ".oc-form-submit, .oc-form-openbar, .oc-form-floating, .oc-form-sticky",
      )) {
        const other = target.getBoundingClientRect();
        if (other.width === 0 || other.height === 0) continue;
        const intersects =
          other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top;
        if (!intersects) continue;
        needed = Math.max(needed, rect.bottom - other.top + 8);
      }
      const maxLift = Math.max(0, window.innerHeight - rect.height - 120);
      node.style.setProperty("--oc-pet-lift", `${Math.min(needed, maxLift)}px`);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    schedule();
    // 投稿欄の中のスクロールも拾う（ページのスクロールだけでは足りない）。
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      node.style.removeProperty("--oc-pet-lift");
    };
  }, [enabled, node]);
}

/** 右下のボタン。ツアー中は出さない（購読はこの中だけ）。 */
function PetLauncher({
  characterId,
  petName,
  onOpen,
}: {
  characterId: string;
  petName: string;
  onOpen: () => void;
}) {
  const tour = useTourState();
  const [node, setNode] = useState<HTMLButtonElement | null>(null);
  const visible = tour.page === null;
  useLauncherLift(node, visible);

  if (!visible) return null;
  return (
    <button
      ref={setNode}
      type="button"
      className="oc-pet-launcher"
      data-testid="pet-launcher"
      aria-label={`AI ペット（${petName}）に聞く`}
      title="AI ペットに聞く"
      onClick={onOpen}
    >
      <PetAvatar characterId={characterId} name={petName} fill className="oc-pet-float" />
    </button>
  );
}

export function PetRoot() {
  const config = usePetConfig();
  const ui = usePetUiState();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => setMounted(true), []);

  // ヘッダーの「ペット」で開く（「しまう」も解除する）。
  useEffect(
    () =>
      subscribePetOpen(() => {
        savePetUiState({ hidden: false });
        setOpen(true);
      }),
    [],
  );

  if (!mounted) return null;

  const characterId = config?.characterId ?? DEFAULT_PET_CHARACTER_ID;
  const petName = config?.petName ?? defaultPetName(DEFAULT_PET_CHARACTER_ID);

  return (
    <>
      {open ? (
        <PetPanel
          onClose={() => setOpen(false)}
          onHide={() => {
            setOpen(false);
            savePetUiState({ hidden: true });
          }}
        />
      ) : null}
      {!open && !ui.hidden ? (
        <PetLauncher characterId={characterId} petName={petName} onOpen={() => setOpen(true)} />
      ) : null}
      {/* 固定ボタンがページ末尾のボタンに重ならないための余白（ページの一番下に置く）。 */}
      {!ui.hidden ? <div className="oc-pet-safespace" aria-hidden="true" /> : null}
    </>
  );
}