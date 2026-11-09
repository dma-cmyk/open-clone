// 0611: 板設定 JSON の kome キー → tsubuyaki キー移行（報告書 31）。
// 実際の migration ファイル（env.TEST_MIGRATIONS）の SQL をそのまま実行して検証する。

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { boardSettingsSchema } from "shared";

const migration = env.TEST_MIGRATIONS.find((item) => item.name.startsWith("0611_"));

async function applyMigration(): Promise<void> {
  if (!migration) throw new Error("0611 の migration が見つかりません");
  for (const query of migration.queries) {
    await env.DB.prepare(query.trim()).run();
  }
}

async function insertBoard(slug: string, settings: Record<string, unknown>): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO boards (slug, name, settings, created_at) VALUES (?, ?, ?, ?) RETURNING id",
  )
    .bind(slug, "移行テスト", JSON.stringify(settings), 1)
    .first<{ id: number }>();
  if (!row) throw new Error("board を作成できませんでした");
  return row.id;
}

async function settingsOf(id: number): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT settings FROM boards WHERE id = ?").bind(id).first<{ settings: string }>();
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>;
}

describe("0611 kome → tsubuyaki 移行", () => {
  it("板設定の kome キーを tsubuyaki へ移し、旧キーを残さない", async () => {
    expect(migration).toBeTruthy();
    const id = await insertBoard("mig-0611-a", { kome: false, live: true });

    await applyMigration();

    const settings = await settingsOf(id);
    expect(settings["live"]).toBe(true);
    expect(settings["tsubuyaki"]).toBe(false);
    expect("kome" in settings).toBe(false);
    expect(boardSettingsSchema.parse(settings).tsubuyaki).toBe(false);
  });

  it("tsubuyaki が既にある行は上書きせず、kome だけ消す", async () => {
    const id = await insertBoard("mig-0611-b", { kome: true, tsubuyaki: false });

    await applyMigration();

    const settings = await settingsOf(id);
    expect(settings["tsubuyaki"]).toBe(false);
    expect("kome" in settings).toBe(false);
  });

  it("kome キーの無い板設定は変えない", async () => {
    const id = await insertBoard("mig-0611-c", { live: true, tsubuyaki: true });
    const before = await settingsOf(id);

    await applyMigration();

    expect(await settingsOf(id)).toEqual(before);
  });
});