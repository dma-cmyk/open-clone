// 外部 HTTP のモック（@cloudflare/vitest-plugin の公式パターン）。
// Turnstile/GitHub/外部アップローダのモックはこの network に登録する。
import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();
