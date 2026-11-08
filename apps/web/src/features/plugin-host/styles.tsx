"use client";

// 宣言的レンダー規則の装飾 CSS。ページで 1 回だけ描画する。

import { PLUGIN_RENDER_CSS } from "./render-rules";

export function PluginRenderStyles() {
  return <style>{PLUGIN_RENDER_CSS}</style>;
}
