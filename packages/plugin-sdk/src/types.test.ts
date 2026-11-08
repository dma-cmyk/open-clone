// plugin-sdk の型テスト（tsd 相当）と definePlugin の実行時テスト。
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_SLOTS,
  normalizeManifest,
  type PluginApi,
  type PluginDefinition,
  type PluginDraft,
  type PluginDraftPatch,
  type PluginNetFetchResult,
  type PluginPost,
  type PluginSlotHandler,
} from "./index";
import { definePlugin, getPluginApi, PLUGIN_SDK_VERSION } from "./define-plugin";

describe("plugin-sdk の型契約", () => {
  it("API の戻り値型が契約どおり", () => {
    expectTypeOf<PluginApi["net"]["fetch"]>().returns.toEqualTypeOf<Promise<PluginNetFetchResult>>();
    expectTypeOf<PluginApi["data"]["posts"]>().returns.toEqualTypeOf<Promise<PluginPost[]>>();
    expectTypeOf<PluginApi["storage"]["get"]>().returns.toEqualTypeOf<Promise<string | null>>();
    expectTypeOf<PluginApi["notify"]["show"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<PluginApi["ai"]["complete"]>().returns.toEqualTypeOf<
      Promise<{ text: string; model?: string }>
    >();
    expectTypeOf<PluginApi["permissions"]>().toEqualTypeOf<readonly (typeof PLUGIN_PERMISSIONS)[number][]>();
  });

  it("スロットハンドラは文字列または void を返せる", () => {
    expectTypeOf<PluginSlotHandler>().returns.toEqualTypeOf<void | string | Promise<void | string>>();
    expectTypeOf<PluginDefinition["slots"]>().toEqualTypeOf<
      Partial<Record<(typeof PLUGIN_SLOTS)[number], PluginSlotHandler>> | undefined
    >();
  });

  it("beforePost フックの入出力型", () => {
    expectTypeOf<PluginDefinition["hooks"]>().toMatchTypeOf<
      | {
          beforePost?: (
            draft: PluginDraft,
            api: PluginApi,
          ) => PluginDraftPatch | void | Promise<PluginDraftPatch | void>;
        }
      | undefined
    >();
  });

  it("manifest の既定値が正規化される", () => {
    const manifest = normalizeManifest({
      name: "type-test",
      version: "1.0.0",
      summary: "型テスト",
      scope: ["personal"],
      permissions: ["ui:slot"],
      slots: ["thread-head"],
    });
    expect(manifest.entry).toBe("plugin.js");
    expect(manifest.connectAllowlist).toEqual([]);
    expect(manifest.hooks).toEqual([]);
  });
});

describe("definePlugin", () => {
  it("register が無い環境では明示エラー", () => {
    expect(() => definePlugin({})).toThrow(/register/);
  });

  it("register に定義を渡す", () => {
    const received: PluginDefinition[] = [];
    Object.assign(globalThis, {
      register: (definition: PluginDefinition) => {
        received.push(definition);
      },
    });
    const definition: PluginDefinition = {
      slots: {
        "thread-head": ({ root }) => {
          root.textContent = "hello";
        },
      },
    };
    const returned = definePlugin(definition);
    expect(returned).toBe(definition);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(definition);
    expect(PLUGIN_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    Reflect.deleteProperty(globalThis, "register");
  });

  it("API 未初期化なら getPluginApi はエラー", () => {
    expect(() => getPluginApi()).toThrow(/初期化/);
  });
});