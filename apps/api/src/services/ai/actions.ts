// AI action の実行ディスパッチャ（政策判定を通過した後にだけ呼ばれる）。
// 書き込みは WP1 の投稿パイプライン（`createPostInternal` / `createThreadInternal`。AI 運営が
// 唯一の経路として使う実装）と、DESIGN §4.1 で確定している列だけを使った更新に限定する。
// ここに到達した action は policy-engine によって risk_cap・担当板・委譲範囲が検証済み。

import {
  ApiError,
  hmacSha256Hex,
  ulid,
  type AiActionName,
} from "shared";
import type { Env } from "../../lib/env";
import { createPostInternal, createThreadInternal } from "../../lib/pipeline";
import {
  decideReview,
  disablePlugin,
  getPluginRow,
  getVersionRow,
  installPlugin,
  parseManifest,
  type ReviewRow,
} from "../plugins/registry";
import { runStaticChecks } from "../plugins/static-checks";
import { setAgentStatus } from "./agents";
import { asRecord, parseJsonRecord } from "./json";
import type { AiAgentContext } from "./policy-engine";
import {
  boardStats,
  getBoard,
  getPost,
  getReport,
  getThread,
  listBoards,
  listPosts,
  listReports,
  listThreads,
  monitorFeed,
  searchPosts,
} from "./readers";

export interface ActionExecutionInput {
  env: Env;
  agent: AiAgentContext;
  /** 政策エンジンが解決した対象板（対象外なら null） */
  boardId: number | null;
  action: AiActionName;
  params: Record<string, unknown>;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** AI 投稿の身元ハッシュ（IP/端末を保存せず、agent ごとに安定したハッシュを持つ）。 */
async function aiIdentity(env: Env, agentId: string): Promise<{ deviceHash: string; ipHash: string }> {
  return {
    deviceHash: await hmacSha256Hex(env.ID_SALT, `ai-device:${agentId}`),
    ipHash: await hmacSha256Hex(env.ID_SALT, `ai-ip:${agentId}`),
  };
}

function boardSettingsOf(raw: string): Record<string, unknown> {
  return parseJsonRecord(raw) ?? {};
}

async function updateBoardSettings(
  env: Env,
  boardId: number,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT settings FROM boards WHERE id = ?")
    .bind(boardId)
    .first<{ settings: string }>();
  if (!row) throw ApiError.notFound("板が見つかりません");
  const merged = { ...boardSettingsOf(row.settings), ...patch };
  await env.DB.prepare("UPDATE boards SET settings = ? WHERE id = ?")
    .bind(JSON.stringify(merged), boardId)
    .run();
  return merged;
}

const ALLOWED_SETTINGS_KEYS = ["cooldown_seconds", "turnstile_required", "live", "wordfilter"] as const;

async function insertBan(
  env: Env,
  input: { boardId: number | null; deviceHash: string; reason: string; agentId: string; expiresAt: number | null },
): Promise<{ id: string }> {
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO board_bans (id, board_id, identity_hash, kind, reason, by_account_id, expires_at, created_at)
     VALUES (?, ?, ?, 'device', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.boardId,
      input.deviceHash,
      input.reason,
      `ai:${input.agentId}`,
      input.expiresAt,
      now(),
    )
    .run();
  return { id };
}

async function approvePluginReview(
  env: Env,
  input: { pluginId: string; note?: string; agentId: string; decision: "approve" | "reject" },
): Promise<{ pluginId: string; status: string }> {
  const review = await env.DB.prepare(
    `SELECT * FROM plugin_reviews
     WHERE plugin_id = ? AND scope = 'site' AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(input.pluginId)
    .first<ReviewRow>();
  if (!review) throw ApiError.conflict("審査待ちのプラグインがありません");

  if (input.decision === "approve") {
    const version = await getVersionRow(env.DB, input.pluginId, review.version);
    if (!version) throw ApiError.notFound("プラグインの版が見つかりません");
    const checks = await runStaticChecks(version.code, parseManifest(version.manifest_json));
    if (!checks.allowed) {
      throw ApiError.forbidden(`静的検査で拒否されました: ${checks.reasons.join(" / ")}`);
    }
  }

  const result = await decideReview(env.DB, review, {
    decision: input.decision,
    note: input.note,
    reviewerId: input.agentId,
    reviewerType: "ai",
  });
  return { pluginId: input.pluginId, status: result.pluginStatus };
}

/**
 * 政策判定済みの action を実行する。返り値は API 応答/MCP の `result` にそのまま入る。
 * 実行に失敗した場合は例外を投げ、呼び出し側が監査に `error` を記録する。
 */
export async function executeAiAction(input: ActionExecutionInput): Promise<unknown> {
  const { env, agent, action, params, boardId } = input;

  switch (action) {
    // ── 読み取り ──
    case "board.list":
      return listBoards(env, {
        category: typeof params.category === "string" ? params.category : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      });
    case "board.get":
      return getBoard(env, {
        boardId: typeof params.boardId === "number" ? params.boardId : undefined,
        slug: typeof params.slug === "string" ? params.slug : undefined,
      });
    case "thread.list":
      return listThreads(env, Number(params.boardId), {
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      });
    case "thread.get":
      return getThread(env, Number(params.threadId));
    case "post.list":
      return listPosts(env, Number(params.threadId), {
        afterPostId: typeof params.afterPostId === "number" ? params.afterPostId : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    case "post.get":
      return getPost(env, Number(params.postId));
    case "search":
      return searchPosts(env, {
        q: String(params.q),
        boardId: typeof params.boardId === "number" ? params.boardId : undefined,
        threadId: typeof params.threadId === "number" ? params.threadId : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      });
    case "monitor.feed":
      return monitorFeed(env, {
        boardId: typeof params.boardId === "number" ? params.boardId : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      });
    case "report.list":
      return listReports(env, {
        boardId: typeof params.boardId === "number" ? params.boardId : undefined,
        status: typeof params.status === "string" ? params.status : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      });
    case "report.get":
      return getReport(env, String(params.reportId));
    case "stats.read":
      return boardStats(env, typeof params.boardId === "number" ? params.boardId : undefined);
    case "classify.draft":
      return classifyDraft(String(params.text));
    case "agent.self":
      return {
        id: agent.id,
        name: agent.name,
        ownerType: agent.ownerType,
        ownerId: agent.ownerId,
        boardId: agent.boardId,
        allowedBoards: agent.allowedBoards,
        riskCap: agent.riskCap,
        rateLimitPerMin: agent.rateLimitPerMin,
        dailyLimit: agent.dailyLimit,
        displayName: agent.displayName,
      };
    case "queue.list":
      return listOwnQueue(env, agent.id, {
        status: typeof params.status === "string" ? params.status : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    case "audit.read":
      return listOwnAudit(env, agent.id, {
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
      });
    case "agent.suspend_self":
      await setAgentStatus(env, agent.id, "suspended", String(params.reason));
      return { agentId: agent.id, status: "suspended" };
    case "queue.cancel_own": {
      const queueId = String(params.queueId);
      const result = await env.DB.prepare(
        `UPDATE ai_queue SET status = 'rejected', decided_at = ?, decided_by = ?, note = ?
         WHERE id = ? AND agent_id = ? AND status = 'pending'`,
      )
        .bind(now(), agent.id, "AI 自身による取り下げ", queueId, agent.id)
        .run();
      if ((result.meta.rows_written ?? 0) === 0) {
        throw ApiError.notFound("取り下げ可能な承認待ち項目がありません");
      }
      return { queueId, status: "rejected" };
    }

    // ── medium ──
    case "post.create": {
      const identity = await aiIdentity(env, agent.id);
      const threadId = typeof params.threadId === "number" ? params.threadId : null;
      if (threadId === null) {
        const title = typeof params.title === "string" ? params.title : "";
        if (!title) throw ApiError.validation("スレッド新規作成には title が必要です");
        const created = await createThreadInternal(
          {
            boardId: Number(params.boardId),
            title,
            body: String(params.body),
            name: typeof params.name === "string" ? params.name : agent.displayName,
            mail: typeof params.mail === "string" ? params.mail : undefined,
            aiAgentId: agent.id,
            accountId: null,
            deviceHash: identity.deviceHash,
            ipHash: identity.ipHash,
            skipGuards: true,
          },
          { env },
        );
        return { threadId: created.thread.id, postId: created.post.id, num: created.post.num };
      }
      const created = await createPostInternal(
        {
          boardId: Number(params.boardId),
          threadId,
          body: String(params.body),
          name: typeof params.name === "string" ? params.name : agent.displayName,
          mail: typeof params.mail === "string" ? params.mail : undefined,
          aiAgentId: agent.id,
          accountId: null,
          deviceHash: identity.deviceHash,
          ipHash: identity.ipHash,
          skipGuards: true,
        },
        { env },
      );
      return { threadId: created.threadId, postId: created.postId, num: created.num };
    }
    case "post.reply": {
      if (boardId === null) throw ApiError.validation("返信先スレッドの板を特定できません");
      const identity = await aiIdentity(env, agent.id);
      const created = await createPostInternal(
        {
          boardId,
          threadId: Number(params.threadId),
          body: String(params.body),
          name: typeof params.name === "string" ? params.name : agent.displayName,
          mail: typeof params.mail === "string" ? params.mail : undefined,
          aiAgentId: agent.id,
          accountId: null,
          deviceHash: identity.deviceHash,
          ipHash: identity.ipHash,
          skipGuards: true,
        },
        { env },
      );
      return { threadId: created.threadId, postId: created.postId, num: created.num };
    }
    case "post.hide":
    case "post.mark_spam": {
      const postId = Number(params.postId);
      const result = await env.DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ? AND deleted = 0")
        .bind(postId)
        .run();
      if ((result.meta.rows_written ?? 0) === 0) throw ApiError.notFound("対象のレスが見つかりません");
      return { postId, hidden: true, reason: params.reason ?? null };
    }
    case "thread.live_off": {
      const threadId = Number(params.threadId);
      await env.DB.prepare("UPDATE threads SET live = 0 WHERE id = ?").bind(threadId).run();
      return { threadId, live: false };
    }
    case "report.triage": {
      const reportId = String(params.reportId);
      const report = await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(reportId).first();
      if (!report) throw ApiError.notFound("通報が見つかりません");
      const ts = now();
      await env.DB.prepare(
        `INSERT INTO ai_report_triage (report_id, priority, verdict, note, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(report_id) DO UPDATE SET priority = excluded.priority, verdict = excluded.verdict,
           note = excluded.note, agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
      )
        .bind(
          reportId,
          String(params.priority),
          typeof params.verdict === "string" ? params.verdict : null,
          typeof params.note === "string" ? params.note : null,
          agent.id,
          ts,
          ts,
        )
        .run();
      return { reportId, priority: params.priority, verdict: params.verdict ?? null };
    }
    case "board.settings_update": {
      const patch = asRecord(params.settings);
      if (!patch) throw ApiError.validation("settings が必要です");
      const filtered: Record<string, unknown> = {};
      for (const key of ALLOWED_SETTINGS_KEYS) {
        if (key in patch) filtered[key] = patch[key];
      }
      const merged = await updateBoardSettings(env, Number(params.boardId), filtered);
      return { boardId: Number(params.boardId), settings: merged };
    }
    case "rate_limit.apply": {
      const merged = await updateBoardSettings(env, Number(params.boardId), {
        cooldown_seconds: Number(params.cooldownSeconds),
      });
      return { boardId: Number(params.boardId), cooldownSeconds: merged.cooldown_seconds };
    }
    case "plugin.install": {
      if (boardId === null) throw ApiError.validation("導入先の板が特定できません");
      const plugin = await getPluginRow(env.DB, String(params.pluginId));
      if (!plugin) throw ApiError.notFound("プラグインが見つかりません");
      if (plugin.status !== "published") {
        throw ApiError.forbidden("公開承認済みのプラグインのみ導入できます");
      }
      const version = typeof params.version === "string" ? params.version : plugin.latest_version;
      if (!version) throw ApiError.validation("版が指定されていません");
      const versionRow = await getVersionRow(env.DB, plugin.id, version);
      if (!versionRow || versionRow.status !== "approved") {
        throw ApiError.forbidden("承認済みの版のみ導入できます");
      }
      const installed = await installPlugin(env.DB, plugin, {
        scope: "board",
        scopeRef: String(boardId),
        version,
        pinned: false,
        installedBy: `ai:${agent.id}`,
      });
      return { pluginId: plugin.id, boardId, version, install: installed.install };
    }

    // ── high（人間承認後にのみ到達） ──
    case "post.delete": {
      const postId = Number(params.postId);
      const result = await env.DB.prepare("UPDATE posts SET deleted = 1, hidden = 1 WHERE id = ?")
        .bind(postId)
        .run();
      if ((result.meta.rows_written ?? 0) === 0) throw ApiError.notFound("対象のレスが見つかりません");
      return { postId, deleted: true };
    }
    case "thread.delete": {
      const threadId = Number(params.threadId);
      await env.DB.prepare("UPDATE threads SET status = 'deleted' WHERE id = ?").bind(threadId).run();
      return { threadId, status: "deleted" };
    }
    case "board.ban":
      return insertBan(env, {
        boardId: Number(params.boardId),
        deviceHash: String(params.deviceHash),
        reason: String(params.reason),
        agentId: agent.id,
        expiresAt:
          typeof params.expiresInSeconds === "number" ? now() + params.expiresInSeconds : null,
      });
    case "site.ban":
      return insertBan(env, {
        boardId: null,
        deviceHash: String(params.deviceHash),
        reason: String(params.reason),
        agentId: agent.id,
        expiresAt:
          typeof params.expiresInSeconds === "number" ? now() + params.expiresInSeconds : null,
      });
    case "board.rules_update": {
      const boardIdParam = Number(params.boardId);
      await env.DB.prepare("UPDATE boards SET rules_md = ? WHERE id = ?")
        .bind(String(params.rulesMd), boardIdParam)
        .run();
      return { boardId: boardIdParam, updated: true };
    }
    case "board.design_update": {
      const boardIdParam = Number(params.boardId);
      const design = params.design && typeof params.design === "object" ? params.design : {};
      await env.DB.prepare("UPDATE boards SET design = ? WHERE id = ?")
        .bind(JSON.stringify(design), boardIdParam)
        .run();
      return { boardId: boardIdParam, updated: true };
    }
    case "board.staff_update": {
      const boardIdParam = Number(params.boardId);
      const accountId = String(params.accountId);
      if (params.level === null) {
        await env.DB.prepare("DELETE FROM board_staff WHERE board_id = ? AND account_id = ?")
          .bind(boardIdParam, accountId)
          .run();
        return { boardId: boardIdParam, accountId, level: null };
      }
      await env.DB.prepare(
        `INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(board_id, account_id) DO UPDATE SET level = excluded.level`,
      )
        .bind(boardIdParam, accountId, String(params.level), `ai:${agent.id}`, now())
        .run();
      return { boardId: boardIdParam, accountId, level: params.level };
    }
    case "plugin.review_approve":
      return approvePluginReview(env, {
        pluginId: String(params.pluginId),
        note: typeof params.note === "string" ? params.note : undefined,
        agentId: agent.id,
        decision: "approve",
      });
    case "plugin.review_reject":
      return approvePluginReview(env, {
        pluginId: String(params.pluginId),
        note: String(params.note),
        agentId: agent.id,
        decision: "reject",
      });
    case "plugin.suspend":
      await disablePlugin(env.DB, String(params.pluginId), String(params.note));
      return { pluginId: String(params.pluginId), status: "disabled" };
    case "account.suspend": {
      const accountId = String(params.accountId);
      const ts = now();
      await env.DB.batch([
        env.DB.prepare("UPDATE accounts SET status = 'suspended' WHERE id = ?").bind(accountId),
        env.DB.prepare(
          `INSERT INTO suspensions (id, account_id, scope, board_id, reason, by, expires_at, lifted_at, created_at)
           VALUES (?, ?, 'site', NULL, ?, ?, ?, NULL, ?)`,
        ).bind(
          ulid(),
          accountId,
          String(params.reason),
          `ai:${agent.id}`,
          typeof params.expiresInSeconds === "number" ? ts + params.expiresInSeconds : null,
          ts,
        ),
      ]);
      return { accountId, status: "suspended" };
    }
    case "site.announce": {
      const payload = JSON.stringify({
        title: String(params.title),
        body: String(params.body),
        by: `ai:${agent.id}`,
        at: now(),
      });
      await env.DB.prepare(
        `INSERT INTO site_config (key, value) VALUES ('site_announcement', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
        .bind(payload)
        .run();
      return { published: true };
    }
    case "board.delete": {
      const boardIdParam = Number(params.boardId);
      await env.DB.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(boardIdParam).run();
      return { boardId: boardIdParam, status: "deleted" };
    }
    case "bulk.cross_board": {
      const ids = Array.isArray(params.postIds) ? params.postIds.map(Number) : [];
      const action = String(params.action);
      const results: { postId: number; boardId: number | null; ok: boolean }[] = [];
      for (const postId of ids) {
        const row = await env.DB.prepare("SELECT board_id FROM posts WHERE id = ?")
          .bind(postId)
          .first<{ board_id: number }>();
        if (!row) {
          results.push({ postId, boardId: null, ok: false });
          continue;
        }
        if (agent.allowedBoards !== "*" && !agent.allowedBoards.includes(row.board_id)) {
          results.push({ postId, boardId: row.board_id, ok: false });
          continue;
        }
        if (action === "post.hide") {
          await env.DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(postId).run();
        } else {
          await env.DB.prepare("UPDATE posts SET deleted = 1, hidden = 1 WHERE id = ?").bind(postId).run();
        }
        results.push({ postId, boardId: row.board_id, ok: true });
      }
      return { action, results };
    }
    case "agent.policy_update":
    case "agent.risk_cap_update":
      // AI からの権限・政策変更は policy-engine で拒否される（ここには到達しない）。
      throw ApiError.forbidden("AI から AI の権限・政策は変更できません");
    case "queue.decide":
      throw ApiError.forbidden("承認は人間セッションのみ可能です");

    // ── never（policy-engine で拒否。防御的フォールバック） ──
    case "invite.issue":
    case "owner.role_update":
    case "special_admin.role_update":
    case "infra.secret_read":
    case "policy.disable":
    case "ai.resume":
    case "agent.create":
    case "agent.delete":
    case "agent.key_read":
    case "webhook.secret_read":
    case "other_agent.read":
    case "audit.purge":
      throw ApiError.forbidden("この操作は AI には許可されていません");
  }
}

/** スパム分類の下書き（副作用なし・決定論的）。 */
function classifyDraft(text: string): {
  labels: string[];
  score: number;
  suggestion: "allow" | "review" | "hide";
} {
  const labels: string[] = [];
  let score = 0;
  const rules: [RegExp, string, number][] = [
    [/(.)\1{9,}/u, "repetition", 30],
    [/https?:\/\/\S+/giu, "link", 25],
    [/(?:無料|副業|稼げる|line|LINE|LINE_ID|投資|仮想通貨)/u, "solicitation", 40],
    [/(?:死ね|殺す|消えろ)/u, "harassment", 45],
    [/[A-Za-z0-9+/]{200,}=*/u, "encoded_blob", 30],
  ];
  for (const [pattern, label, weight] of rules) {
    if (pattern.test(text)) {
      labels.push(label);
      score += weight;
    }
  }
  if (text.length > 4000 && labels.length === 0) score += 10;
  const suggestion = score >= 60 ? "hide" : score >= 25 ? "review" : "allow";
  return { labels, score: Math.min(100, score), suggestion };
}

async function listOwnQueue(
  env: Env,
  agentId: string,
  input: { status?: string; limit?: number },
): Promise<unknown> {
  const limit = Math.min(Math.max(1, input.limit ?? 20), 100);
  const rows = await env.DB.prepare(
    `SELECT q.*, a.name AS agent_name FROM ai_queue q LEFT JOIN ai_agents a ON a.id = q.agent_id
     WHERE q.agent_id = ? AND (? = '' OR q.status = ?) ORDER BY q.requested_at DESC LIMIT ?`,
  )
    .bind(agentId, input.status ?? "", input.status ?? "", limit)
    .all();
  return { items: rows.results ?? [] };
}

async function listOwnAudit(
  env: Env,
  agentId: string,
  input: { limit?: number; cursor?: string },
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, input.limit ?? 30), 100);
  let before = Number.MAX_SAFE_INTEGER;
  if (input.cursor) {
    try {
      const parsed: unknown = JSON.parse(atob(input.cursor));
      if (parsed && typeof parsed === "object" && "at" in parsed && typeof parsed.at === "number") {
        before = parsed.at;
      }
    } catch {
      before = Number.MAX_SAFE_INTEGER;
    }
  }
  const rows = await env.DB.prepare(
    `SELECT id, action, risk, mode, board_id, result, error_code, created_at
     FROM ai_audit WHERE agent_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(agentId, before, limit + 1)
    .all<{ created_at: number }>();
  const items = rows.results ?? [];
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: items.length > limit && last ? btoa(JSON.stringify({ at: last.created_at })) : null,
  };
}