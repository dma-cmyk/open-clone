"use client";

// WP2 の `<PluginSlot>`（`apps/web/src/components/plugin-slot.tsx`）へ、
// WP3 の sandbox ランナーを登録するアダプタ。
// WP2 のレイアウト/スレ画面はこのモジュールを 1 回 import するだけで良い:
//
//   import "@/features/plugin-host/register";
//
// （registerPluginSlotRenderer は WP2 が提供する登録 API。編集は WP2 側の 1 行のみ）

import { registerPluginSlotRenderer, type PluginSlotContext } from "@/components/plugin-slot";
import { PluginSlot } from "./slot";
import type { PluginSlotName } from "shared";

/**
 * WP2 のスロット名 → manifest のスロット名。
 * shared の PLUGIN_SLOTS に WP2 の名前を含めてあるため現状は同じ名前だが、
 * 将来 WP2 側の名称が変わってもここで吸収する。
 */
export const WP2_SLOT_ALIASES: Record<PluginSlotContext["slot"], PluginSlotName> = {
  "site-header": "site-header",
  "site-top": "site-top",
  "board-top": "board-top",
  "board-sidebar": "board-sidebar",
  "thread-top": "thread-top",
  "thread-nav": "thread-nav",
  "post-form-extra": "post-form-extra",
  "thread-bottom": "thread-bottom",
  "board-manage": "board-manage",
  "post-actions": "post-actions",
};

let dispose: (() => void) | null = null;

/** 登録を冪等に行う（HMR/複数 import で二重登録しない）。 */
export function installPluginHostRenderers(): () => void {
  if (dispose) return dispose;
  dispose = registerPluginSlotRenderer((context) => (
    <PluginSlot
      name={WP2_SLOT_ALIASES[context.slot] ?? "thread-top"}
      boardSlug={context.boardSlug}
      threadId={context.threadId}
      postId={context.postId}
      data={{
        threadId: context.threadId ?? null,
        postId: context.postId ?? null,
        post:
          context.postBody !== undefined
            ? {
                id: context.postId ?? 0,
                num: 0,
                name: "",
                body: context.postBody,
                createdAt: 0,
              }
            : undefined,
      }}
    />
  ));
  return dispose;
}

installPluginHostRenderers();