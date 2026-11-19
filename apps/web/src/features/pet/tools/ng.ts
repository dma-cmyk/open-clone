// NG の追加・解除のツール（この端末の個人設定。サーバーには送らない）。
// 保存は画面と同じ `features/board-ui/settings.ts` の関数を使う（設定画面と NG の扱いをずらさない）。

import { z } from "zod";
import { addNgEntry, removeNgEntry, settingsStore, type NgListKind, type NgMode } from "../../board-ui/settings";
import type { PetConfirmRequest, PetToolResult, PetWriteTool } from "../contract";
import { prepareWithArgs, runWithArgs, toolParameters } from "./args";
import { notFound } from "./errors";

const KIND_LABEL: Readonly<Record<NgListKind, string>> = {
  words: "NG ワード",
  ids: "NG ID",
  names: "NG 名前",
  trips: "NG トリップ",
  threads: "NG スレタイ",
};

const MODE_LABEL: Readonly<Record<NgMode, string>> = {
  confirm: "確認（マークして表示）",
  hide: "非表示（通知のみ）",
  ignore: "完全に無視",
};

const ngArgs = z
  .object({
    kind: z
      .enum(["words", "ids", "names", "trips", "threads"])
      .describe("NG の種類（words=言葉 / ids=表示 ID / names=名前 / trips=トリップ / threads=スレタイ）"),
    value: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("値（登録・解除する対象。ID は 4 文字など、画面と同じ形式）"),
  })
  .strict();

function currentEntries(kind: NgListKind): string[] {
  return settingsStore.get().ng[kind];
}

function details(kind: NgListKind, value: string, extra: { label: string; value: string }[]) {
  const ng = settingsStore.get().ng;
  return [
    { label: "種類", value: KIND_LABEL[kind] },
    { label: "値", value },
    ...extra,
    { label: "いまの処理", value: MODE_LABEL[ng.mode] },
    { label: "いまの登録数", value: `${currentEntries(kind).length} 件` },
    { label: "保存先", value: "この端末（サーバーには送りません）" },
  ];
}

export const addNgTool: PetWriteTool = {
  name: "add_ng",
  label: "NG の追加を準備しています",
  description:
    "この端末の NG 一覧に 1 件足す（words=言葉・ids=表示 ID・names=名前・trips=トリップ・threads=スレタイ）。確認カードの後で保存する。",
  parameters: toolParameters(ngArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(ngArgs, args, async (input): Promise<PetConfirmRequest> => {
      const already = currentEntries(input.kind).includes(input.value);
      return {
        title: "NG に追加します",
        danger: false,
        details: details(input.kind, input.value, [
          { label: "状態", value: already ? "すでに登録済みです（変わりません）" : "新しく追加します" },
        ]),
      };
    });
  },
  async run(args) {
    return runWithArgs(ngArgs, args, async (input) => {
      const before = currentEntries(input.kind).length;
      addNgEntry(input.kind, input.value);
      const after = currentEntries(input.kind).length;
      return { ok: true, data: { kind: input.kind, value: input.value, added: after > before, count: after } };
    });
  },
};

export const removeNgTool: PetWriteTool = {
  name: "remove_ng",
  label: "NG の解除を準備しています",
  description:
    "この端末の NG 一覧から 1 件外す（words・ids・names・trips・threads）。確認カードの後で保存する。",
  parameters: toolParameters(ngArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(ngArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const entries = currentEntries(input.kind);
      if (!entries.includes(input.value)) {
        return notFound(
          `${KIND_LABEL[input.kind]}に「${input.value}」は登録されていません。登録済み: ${
            entries.length > 0 ? entries.join(", ") : "（なし）"
          }`,
        );
      }
      return {
        title: "NG から外します",
        danger: false,
        details: details(input.kind, input.value, [{ label: "状態", value: "登録済みです。外すと元の表示に戻ります。" }]),
      };
    });
  },
  async run(args) {
    return runWithArgs(ngArgs, args, async (input) => {
      const before = currentEntries(input.kind).length;
      removeNgEntry(input.kind, input.value);
      const after = currentEntries(input.kind).length;
      return { ok: true, data: { kind: input.kind, value: input.value, removed: after < before, count: after } };
    });
  },
};