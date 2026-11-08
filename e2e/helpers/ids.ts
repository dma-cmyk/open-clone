// E2E で衝突しない一意な識別子を作る。
import { randomBytes } from "node:crypto";

let counter = 0;

/** 例: unique("board") → "board-e2e-lz3k9-1" */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-e2e-${Date.now().toString(36)}-${counter}`;
}

/** テスト専用の IP（レート制限の識別を分離する）。 */
export function fakeIp(seed = Date.now()): string {
  const third = seed % 200;
  const fourth = (Math.floor(seed / 200) % 200) + 1;
  return `198.51.${third}.${fourth}`;
}

/**
 * 端末 Cookie `oc_did` の値（32 hex）。API の requestContext はこの形式のみ受理する。
 * APIRequestContext の Cookie jar は `secure` Cookie を http で送らないことがあるため、
 * レート制限テストではヘッダで明示的に固定する。
 */
export function fakeDeviceId(): string {
  return randomBytes(16).toString("hex");
}