"use client";

// 利用者の画像を 256×256 の PNG（中央で正方形に切る）にして、この端末に保存する形にする。
// 画像はサーバーへ送らない（`settings.ts` の localStorage にだけ置く）。

export const PET_AVATAR_SIZE = 256;
export const PET_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const PET_AVATAR_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function loadImage(url: string): Promise<HTMLImageElement> {
  const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("画像を読み込めませんでした"));
  image.src = url;
  return promise;
}

export type AvatarPrepareResult = { ok: true; dataUrl: string } | { ok: false; error: string };

export async function preparePetAvatar(file: File): Promise<AvatarPrepareResult> {
  if (!PET_AVATAR_TYPES.includes(file.type)) {
    return { ok: false, error: "png・jpeg・webp・gif の画像を選んでください。" };
  }
  if (file.size > PET_AVATAR_MAX_BYTES) {
    return { ok: false, error: "画像は 5MB までです。" };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = PET_AVATAR_SIZE;
    canvas.height = PET_AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, error: "画像を変換できませんでした。" };
    // 中央の正方形を切り出して 256×256 に縮める（縦横比を保ち、余白は作らない）。
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      PET_AVATAR_SIZE,
      PET_AVATAR_SIZE,
    );
    return { ok: true, dataUrl: canvas.toDataURL("image/png") };
  } catch {
    return { ok: false, error: "画像を読み込めませんでした。別の画像を選んでください。" };
  } finally {
    URL.revokeObjectURL(url);
  }
}