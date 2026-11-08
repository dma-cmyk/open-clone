// スレ主自治コマンド（!aku / !kaijo / !sub / !cap / !reset / !nopic / !ngk / !jien / !add）
// の検証と状態遷移の計算。DB への書き込みは pipeline が batch で行う（読み取りのみここで実行）。

import {
  ApiError,
  type BoardSettings,
  type ParsedBodyCommand,
  type ThreadState,
  jstEndOfDay,
} from "shared";
import type { ThreadRow } from "../services/board/store";

export interface CommandActor {
  deviceHash: string;
  ipHash: string;
  accountId: string | null;
  displayId: string;
  ninjaLv: number;
}

export interface CommandContext {
  db: D1Database;
  now: number;
  thread: ThreadRow;
  state: ThreadState;
  settings: BoardSettings;
  actor: CommandActor;
  isStaff: boolean;
}

export interface CommandPlan {
  state: ThreadState;
  stateChanged: boolean;
  subAdds: Array<{ identityHash: string; accountId: string | null }>;
  subRemoves: string[];
  capUpdates: Array<{ postId: number; cap: string | null }>;
  /** >>1 への追記（`!add`）。FTS の再索引も pipeline が行う。 */
  addAppend: {
    postId: number;
    previousBody: string;
    previousName: string;
    previousTitle: string | null;
    nextBody: string;
  } | null;
  notices: string[];
}

interface TargetPost {
  id: number;
  num: number;
  device_hash: string;
  post_id_hash: string;
  body: string;
  cap: string | null;
}

const SUB_LIMIT = 10;
const ADD_LIMIT = 50;
const AKU_LIMIT = 200;

/** スレ主か（端末またはアカウントで判定）。 */
export function isThreadOwner(thread: ThreadRow, actor: CommandActor): boolean {
  if (thread.owner_account_id && actor.accountId && thread.owner_account_id === actor.accountId) return true;
  return Boolean(thread.owner_device_hash && thread.owner_device_hash === actor.deviceHash);
}

/** 副主か。 */
export async function isThreadSub(db: D1Database, threadId: number, deviceHash: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM thread_subs WHERE thread_id = ? AND identity_hash = ?")
    .bind(threadId, deviceHash)
    .first<{ found: number }>();
  return row !== null;
}

function uniquePush(list: string[], value: string, limit: number): void {
  if (!list.includes(value) && list.length < limit) list.push(value);
}

/**
 * コマンドを検証し、適用後の状態と追加書き込みを返す。
 * 権限不足・対象不明・上限超過は ApiError を投げる（投稿自体を失敗させる）。
 */
export async function planThreadCommands(
  context: CommandContext,
  commands: ParsedBodyCommand[],
): Promise<CommandPlan> {
  const state: ThreadState = {
    ...context.state,
    akuIds: [...context.state.akuIds],
    akuDevices: [...context.state.akuDevices],
  };
  const plan: CommandPlan = { state, stateChanged: false, subAdds: [], subRemoves: [], capUpdates: [], addAppend: null, notices: [] };
  if (commands.length === 0) return plan;

  const owner = isThreadOwner(context.thread, context.actor);
  const sub = !owner && (await isThreadSub(context.db, context.thread.id, context.actor.deviceHash));
  const canAku = owner || sub || context.isStaff;

  const ownerOnly = commands.find((command) =>
    ["sub", "reset", "ngk", "jien", "add"].includes(command.name),
  );
  if (ownerOnly && !owner) {
    throw ApiError.forbidden(`!${ownerOnly.name} はスレ主のみ使用できます`);
  }
  const restricted = commands.find((command) => ["aku", "kaijo", "cap", "nopic"].includes(command.name));
  if (restricted && !canAku) {
    throw ApiError.forbidden(`!${restricted.name} はスレ主・副主のみ使用できます`);
  }

  const anchorNums = Array.from(new Set(commands.flatMap((command) => command.anchors))).filter((num) => num > 0);
  const targets = await loadTargets(context.db, context.thread.id, anchorNums);
  const targetByNum = new Map(targets.map((target) => [target.num, target]));

  const resolveTargets = (command: ParsedBodyCommand): TargetPost[] => {
    return command.anchors
      .map((num) => targetByNum.get(num))
      .filter((target): target is TargetPost => target !== undefined);
  };

  const ownerHash = context.thread.owner_device_hash;
  for (const command of commands) {
    switch (command.name) {
      case "aku": {
        const resolved = resolveTargets(command);
        if (resolved.length === 0) {
          // 安価なし = 自分の ID をアク禁（open2ch の「本人にも可」）
          uniquePush(state.akuDevices, context.actor.deviceHash, AKU_LIMIT);
          uniquePush(state.akuIds, context.actor.displayId, AKU_LIMIT);
          plan.notices.push("★自分をアク禁にしました");
          break;
        }
        for (const target of resolved) {
          if (ownerHash && target.device_hash === ownerHash && !owner) {
            throw ApiError.forbidden("スレ主をアク禁することはできません");
          }
          uniquePush(state.akuDevices, target.device_hash, AKU_LIMIT);
          uniquePush(state.akuIds, target.post_id_hash, AKU_LIMIT);
          plan.notices.push(`★アク禁にしました: >>${target.num}`);
        }
        state.akuExpiresAt = jstEndOfDay(context.now);
        break;
      }
      case "kaijo": {
        const resolved = resolveTargets(command);
        for (const target of resolved) {
          state.akuDevices = state.akuDevices.filter((hash) => hash !== target.device_hash);
          state.akuIds = state.akuIds.filter((id) => id !== target.post_id_hash);
          plan.notices.push(`★アク禁を解除しました: >>${target.num}`);
        }
        if (resolved.length === 0) {
          state.akuDevices = [];
          state.akuIds = [];
          state.akuExpiresAt = null;
          plan.notices.push("★アク禁をすべて解除しました");
        }
        break;
      }
      case "sub": {
        if (command.anchors.length !== 1) throw ApiError.validation("!sub は 1 レスにつき 1 人のみ指定できます");
        const target = targetByNum.get(command.anchors[0]!);
        if (!target) throw ApiError.validation("!sub の安価先が見つかりません");
        if (ownerHash && target.device_hash === ownerHash) {
          throw ApiError.validation("スレ主を副主に指定することはできません");
        }
        if (plan.subRemoves.includes(target.device_hash) || (await isThreadSub(context.db, context.thread.id, target.device_hash))) {
          plan.subRemoves.push(target.device_hash);
          plan.notices.push(`★副主を解雇しました: >>${target.num}`);
        } else {
          if (plan.subAdds.length >= SUB_LIMIT) throw ApiError.validation(`副主は ${SUB_LIMIT} 人までです`);
          plan.subAdds.push({ identityHash: target.device_hash, accountId: null });
          plan.notices.push(`★副主に追加: >>${target.num}`);
        }
        break;
      }
      case "cap": {
        const resolved = resolveTargets(command);
        if (resolved.length === 0) throw ApiError.validation("!cap には安価が必要です");
        const capText = command.arg.replace(/^▲/, "").trim();
        for (const target of resolved) {
          const cap = capText.length > 0 ? capText.slice(0, 32) : null;
          plan.capUpdates.push({ postId: target.id, cap });
          plan.notices.push(cap ? `★キャップを付与しました: >>${target.num}` : `★キャップを解除しました: >>${target.num}`);
        }
        break;
      }
      case "reset": {
        const subs = await context.db
          .prepare("SELECT identity_hash FROM thread_subs WHERE thread_id = ?")
          .bind(context.thread.id)
          .all<{ identity_hash: string }>();
        plan.subRemoves.push(...subs.results.map((row) => row.identity_hash));
        state.akuDevices = [];
        state.akuIds = [];
        state.akuExpiresAt = null;
        state.resetAt = context.now;
        plan.notices.push("★すべての副主＆akuを解除");
        break;
      }
      case "nopic": {
        state.nopic = !state.nopic;
        plan.notices.push(state.nopic ? "★画像投稿を禁止しました" : "★画像投稿の禁止を解除しました");
        break;
      }
      case "ngk": {
        state.ngk = !state.ngk;
        plan.notices.push(state.ngk ? "★コテ禁を設定しました" : "★コテ禁を解除しました");
        break;
      }
      case "jien": {
        state.jien = !state.jien;
        plan.notices.push(state.jien ? "★自演防止モードを有効にしました" : "★自演防止モードを解除しました");
        break;
      }
      case "add": {
        const text = command.arg.trim();
        if (text.length === 0) throw ApiError.validation("!add には追記する本文が必要です");
        if (state.addCount >= ADD_LIMIT) throw ApiError.validation(`!add は ${ADD_LIMIT} 回までです`);
        const op = await context.db
          .prepare("SELECT id, body, name, title FROM posts WHERE thread_id = ? AND num = 1 LIMIT 1")
          .bind(context.thread.id)
          .first<{ id: number; body: string; name: string; title: string | null }>();
        if (!op) throw ApiError.validation(">>1 が見つかりません");
        const nextBody = `${op.body}\n${text}`;
        if (nextBody.length > 20_000) throw ApiError.validation(">>1 が長すぎます");
        plan.addAppend = {
          postId: op.id,
          previousBody: op.body,
          previousName: op.name,
          previousTitle: op.title,
          nextBody,
        };
        state.addCount += 1;
        plan.notices.push("★>>1 に追記しました");
        break;
      }
    }
  }

  plan.stateChanged =
    plan.notices.length > 0 ||
    plan.subAdds.length > 0 ||
    plan.subRemoves.length > 0 ||
    plan.capUpdates.length > 0 ||
    plan.addAppend !== null;

  return plan;
}

async function loadTargets(db: D1Database, threadId: number, nums: number[]): Promise<TargetPost[]> {
  if (nums.length === 0) return [];
  const placeholders = nums.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT id, num, device_hash, post_id_hash, body, cap FROM posts
       WHERE thread_id = ? AND kind = 'post' AND deleted = 0 AND num IN (${placeholders})`,
    )
    .bind(threadId, ...nums)
    .all<TargetPost>();
  return result.results;
}