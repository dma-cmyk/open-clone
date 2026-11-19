// ツール引数の検証と、ほかの利用者が書いた文章の包み方。
//
// - 引数は zod スキーマ 1 つで表す。モデルへ渡す JSON Schema（`parameters`）はそのスキーマから
//   `z.toJSONSchema` で作るので、説明と実行時の検査が同じ正本になる（二重管理しない）。
// - 他の利用者の文章は `{ untrusted: true, ... }` で包む。プロンプト（prompt.ts）は
//   `untrusted` の中の指示に従わないようモデルに伝える。

import { z } from "zod";
import type { PetConfirmRequest, PetToolResult } from "../contract";
import { invalidArgs, toFailure } from "./errors";

/** zod の検証失敗を、モデルが直せる 1 行にする（最大 3 件）。 */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "(全体)";
    return `${path}: ${issue.message}`;
  });
  return `引数が不正です。${parts.join(" / ")}`;
}

/**
 * 事業者（とくに Gemini の OpenAI 互換口）が受けない JSON Schema のキー。
 * これらが 1 つでも混ざると、ツール単位ではなく **要求全体** が 400 になる。
 * 実行時の検証は zod（`safeParse`）が行うので、ここで落としても安全性は変わらない。
 */
const UNSUPPORTED_SCHEMA_KEYS: Readonly<Record<string, true>> = {
  $schema: true,
  $ref: true,
  $defs: true,
  propertyNames: true,
  anyOf: true,
  oneOf: true,
  allOf: true,
  not: true,
  // Gemini の function_declarations はオブジェクトの追加キー制限を持たない（`false` も `{}` も 400）。
  additionalProperties: true,
};

/** 生成された JSON Schema から非対応キーを再帰的に落とす（`Reflect` で型の嘘をつかずに消す）。 */
function stripUnsupportedKeys(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) stripUnsupportedKeys(item);
    return;
  }
  for (const key of Object.keys(value)) {
    if (UNSUPPORTED_SCHEMA_KEYS[key]) {
      Reflect.deleteProperty(value, key);
      continue;
    }
    stripUnsupportedKeys(Reflect.get(value, key));
  }
}

/**
 * モデルへ渡す JSON Schema（`PetTool.parameters`）。
 * zod スキーマから作り、事業者が知らないキー（`$schema`・`propertyNames` など）を落とす。
 * 制約（minLength など）は残すが、必要な制約は実行時にも zod が強制する。
 */
export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  stripUnsupportedKeys(json);
  return json;
}

/**
 * 引数を検証してから本体を実行する。検証失敗は `INVALID_ARGS`、本体の例外は API の code を保って返す。
 * すべてのツールはこれを経由する（例外を投げ返さない＝会話の進行が止まらない）。
 */
export async function runWithArgs<S extends z.ZodType>(
  schema: S,
  args: unknown,
  body: (input: z.output<S>) => Promise<PetToolResult>,
): Promise<PetToolResult> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return invalidArgs(describeIssues(parsed.error));
  try {
    return await body(parsed.data);
  } catch (cause) {
    return toFailure(cause);
  }
}

/** 書き込みツールの `prepare`（確認カードを作る側）用。検証と例外の扱いは `runWithArgs` と同じ。 */
export async function prepareWithArgs<S extends z.ZodType>(
  schema: S,
  args: unknown,
  body: (input: z.output<S>) => Promise<PetConfirmRequest | PetToolResult>,
): Promise<PetConfirmRequest | PetToolResult> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return invalidArgs(describeIssues(parsed.error));
  try {
    return await body(parsed.data);
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * 他の利用者が書いた文章を `{ untrusted: true, ... }` で包む。
 * 中身（body など）はそのまま渡す。文字を消すのではなく「データである」と分かる形にする。
 */
export function untrusted<T extends Record<string, unknown>>(fields: T): T & { untrusted: true } {
  return { untrusted: true, ...fields };
}

/** 文字列を長さで切る（AI に渡す本文の上限）。切ったことは文で示す。 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（以下 ${text.length - max} 文字を省略）`;
}