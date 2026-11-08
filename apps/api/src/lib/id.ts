// 表示 ID（日替わり・板ごと・4 文字）と忍法帖レベル。
// DESIGN §5.1: base32(HMAC_SHA256(ID_SALT + board_id + YYYYMMDD, ip_normalised))[0:4]。
// 生 IP は保持しないため、正規化 IP の代わりに ip_hash（HMAC(ID_SALT, ip)）を使う。
// HMAC の入力が既に秘密 salt 付きなので、出力の分布・秘匿性は設計同等。

import { DISPLAY_ID_LENGTH, hmacSha256, jstDateKey, toBase32 } from "shared";

/**
 * 表示 ID を生成する。板×JST 日付×IP ハッシュで決まり、日付が変わると回転する。
 * `noId` の場合は呼び出し側が `???` を採用する。
 */
export async function computeDisplayId(params: {
  salt: string;
  boardId: number;
  ipHash: string;
  now: number;
}): Promise<string> {
  const digest = await hmacSha256(params.salt, `display-id:${params.boardId}:${jstDateKey(params.now)}:${params.ipHash}`);
  return toBase32(digest).slice(0, DISPLAY_ID_LENGTH);
}

/** 自演防止（`!jien`）形式: `先頭2文字.プロバイダ文字.L<忍法帖Lv>`。 */
export function jienDisplayId(idHash: string, ipHash: string, ninjaLv: number): string {
  const provider = "abcdefghijklmnopqrstuvwxyz0123456789"[parseInt(ipHash.slice(0, 2), 16) % 36]!;
  return `${idHash.slice(0, 2)}.${provider}.L${ninjaLv}`;
}

/** 投稿数から忍法帖レベル（1〜20）を求める。50 投稿ごとに +1。 */
export function ninjaLevelFor(postCount: number): number {
  return Math.min(20, Math.max(1, 1 + Math.floor(postCount / 50)));
}