// 全スロットがホスト画面に置かれていることの確認（設計 60 直し方 3）。
// 宣言だけして置き忘れたスロット（＝導入しても何も出ない）を将来も作らないため、
// 実際の画面ソースの `<PluginSlot slot="...">` を数える。UI の文言には依存しない。

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_SLOTS, type PluginSlotName } from "shared";
import { SLOT_ALIASES } from "./slots";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function collectTsx(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsx(full, found);
      continue;
    }
    if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) found.push(full);
  }
  return found;
}

/** 画面に `<PluginSlot slot="...">` として置かれているホスト側スロット名。 */
function placedSlots(): Set<string> {
  const placed = new Set<string>();
  for (const file of collectTsx(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/<PluginSlot\b[^>]*slot="([a-z-]+)"/g)) {
      const slot = match[1];
      if (slot) placed.add(slot);
    }
  }
  return placed;
}

/**
 * 専用ページが自前で描画するため、共通画面に置かないスロット。
 * plugin-page は `/plugins/demo/` とエディタのプレビューが `<PluginSlot name="...">` を
 * 直接置く（対象ページにだけ出すのが仕様）。
 */
const PLACED_ONLY_IN_DEDICATED_PAGE: Partial<Record<PluginSlotName, string>> = {
  "plugin-page": "/plugins/demo/ とエディタのプレビューが専用ページ内で描画する",
};

const placed = placedSlots();
const genericNames = new Set(Object.keys(SLOT_ALIASES));

describe("プラグインスロットの設置", () => {
  it("PLUGIN_SLOTS の全スロットが、対応するホスト画面か専用ページに置かれている", () => {
    const missing: string[] = [];
    for (const slot of PLUGIN_SLOTS) {
      if (PLACED_ONLY_IN_DEDICATED_PAGE[slot]) continue;
      if (genericNames.has(slot)) {
        const hosts = SLOT_ALIASES[slot] ?? [];
        if (hosts.length === 0) {
          missing.push(`${slot}（割り当て先が無い）`);
          continue;
        }
        for (const host of hosts) {
          if (!placed.has(host)) missing.push(`${slot} → ${host}（未設置）`);
        }
        continue;
      }
      if (!placed.has(slot)) missing.push(`${slot}（未設置）`);
    }
    expect(missing).toEqual([]);
  });

  it("SLOT_ALIASES の割り当て先はすべて既知のホストスロット", () => {
    for (const [generic, hosts] of Object.entries(SLOT_ALIASES)) {
      expect(PLUGIN_SLOTS, `${generic} が PLUGIN_SLOTS に無い`).toContain(generic);
      expect(hosts.length, `${generic} の割り当て先が空`).toBeGreaterThan(0);
      for (const host of hosts) {
        expect(PLUGIN_SLOTS, `${generic} → ${host} が PLUGIN_SLOTS に無い`).toContain(host);
      }
    }
  });

  it("画面に置かれたスロット名は PLUGIN_SLOTS に載っている（綴り間違いを検出）", () => {
    for (const slot of placed) {
      expect(PLUGIN_SLOTS, `${slot} は PLUGIN_SLOTS に無い`).toContain(slot);
    }
  });

  it("レスごとのスロット（post-actions）は 1 レスに 1 つだけ置く", () => {
    const postRows = readFileSync(path.join(SRC_DIR, "features/board-ui/post-row.tsx"), "utf8");
    const count = [...postRows.matchAll(/slot="post-actions"/g)].length;
    expect(count).toBe(1);
  });
});