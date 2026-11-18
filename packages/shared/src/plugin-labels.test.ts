// 説明表の網羅性（文言ではなく構造）の確認。
// 権限・スロットの増減でエディタやヘルプから場所が抜け落ちないようにする。
// 文面そのものは固定しない（表示の言い回しは自由に直せる）。

import { describe, expect, it } from "vitest";
import { PLUGIN_PERMISSIONS, PLUGIN_SLOTS } from "./schemas/plugin";
import {
  PLUGIN_PERMISSION_INFOS,
  PLUGIN_PLACED_SLOTS,
  PLUGIN_SLOT_INFOS,
  pluginSlotHost,
} from "./plugin-labels";

describe("プラグインの権限・表示場所の説明表", () => {
  it("全権限・全スロットの項目がある", () => {
    expect(PLUGIN_PERMISSION_INFOS.map((info) => info.permission)).toEqual([...PLUGIN_PERMISSIONS]);
    expect(PLUGIN_SLOT_INFOS.map((info) => info.slot)).toEqual([...PLUGIN_SLOTS]);
  });

  it("実際に置かれる場所の一覧が、置き場所のある全スロットを含む", () => {
    const hosts = PLUGIN_SLOTS.filter((slot) => pluginSlotHost(slot) === slot);
    expect([...PLUGIN_PLACED_SLOTS].sort()).toEqual([...hosts].sort());
    expect(new Set(PLUGIN_PLACED_SLOTS).size).toBe(PLUGIN_PLACED_SLOTS.length);
  });

  it("別名の置き先は、実際に置かれる場所の一覧にある", () => {
    for (const slot of PLUGIN_SLOTS) {
      const host = pluginSlotHost(slot);
      if (host !== null && host !== slot) expect(PLUGIN_PLACED_SLOTS).toContain(host);
    }
  });
});