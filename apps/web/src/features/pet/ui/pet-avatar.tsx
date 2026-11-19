"use client";

// ペットの絵。既定の 4 体（`PET_CHARACTERS`）か、利用者がアップロードした画像（characterId "custom"）。
// 画像が読めないとき（未配置・壊れたファイル・アップロード前の "custom"）は、
// 名前の頭文字を丸に描いて動き続ける（ボタンが空にならないように）。

import { useState } from "react";
import { PET_CHARACTERS } from "../characters";
import { usePetAvatar } from "./use-pet-settings";

export function PetAvatar({
  characterId,
  name,
  size = 40,
  fill,
  className,
}: {
  characterId: string;
  name: string;
  size?: number;
  /** 親の大きさに合わせる（固定ボタンなど CSS で大きさを決める場所）。 */
  fill?: boolean;
  className?: string;
}) {
  const uploaded = usePetAvatar();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = characterId === "custom" ? uploaded : PET_CHARACTERS.find((item) => item.id === characterId)?.src ?? null;
  const initial = Array.from(name.trim())[0] ?? "?";
  const box = fill ? { width: "100%", height: "100%" } : { width: size, height: size };
  // fill（右下の呼び出しボタン）では、文字の大きさを CSS に任せる（ボタンの大きさに合わせる）。
  const fallbackStyle = fill ? box : { ...box, fontSize: Math.round(size * 0.45) };

  if (!src || failedSrc === src) {
    return (
      <span
        className={className ? `oc-pet-avatar-fallback ${className}` : "oc-pet-avatar-fallback"}
        style={fallbackStyle}
        aria-hidden="true"
      >
        {initial}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ ...box, objectFit: "contain" }}
      onError={() => setFailedSrc(src)}
      draggable={false}
    />
  );
}