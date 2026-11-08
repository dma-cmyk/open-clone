// AI 操作のリスク階層カタログ（DESIGN §10.2）。
// 政策エンジン（REST/MCP 共通）・監査・ダッシュボード・MCP ツール定義はすべてこのカタログを唯一の正とする。
// 新しい action を追加する場合は必ずこのファイルに追加し、`AI_ACTION_PARAM_SCHEMAS` も定義すること。

import { z } from "zod";

export const RISK_LEVELS = ["low", "medium", "high", "never"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** リスクの序列（比較用）。never は比較対象外（常に拒否）。 */
export const RISK_RANK: Record<Exclude<RiskLevel, "never">, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** risk_cap に指定できる値（never は指定不可 = 何もできない AI は作れない）。 */
export const RISK_CAPS = ["low", "medium", "high"] as const;
export type RiskCap = (typeof RISK_CAPS)[number];

export const policyModeSchema = z.enum(["auto", "queue", "deny"]);
export type PolicyMode = z.infer<typeof policyModeSchema>;

// ─────────────────────────── 共通パラメータ断片 ───────────────────────────

const cursorParam = z.string().max(200).optional();
const limitParam = z.number().int().min(1).max(100).optional();
const boardIdParam = z.number().int().positive();
const reasonParam = z.string().min(1).max(500);

// ─────────────────────────── 操作カタログ ───────────────────────────

/**
 * action 定義。`params` は strict オブジェクトで、未知キーは VALIDATION エラーになる。
 * これにより「権限フィールドを params に混ぜて昇格する」類の攻撃を構文段階で排除する。
 */
export interface AiActionDefinition {
  readonly risk: RiskLevel;
  readonly description: string;
  /** パラメータスキーマは `AI_ACTION_PARAM_SCHEMAS[action]` が正（ここには持たない）。 */
  readonly params?: z.ZodType;
  /** 人間セッションでのみ実行可能（AI キーでは常に 403）。 */
  readonly humanOnly?: boolean;
  /** 既定の承認者スコープ（queue の notice 表示用）。 */
  readonly approvalScope?: "site" | "board";
}

export const AI_ACTION_PARAM_SCHEMAS = {
  // ── low: 閲覧・検索・監視・下書き（副作用なし） ──
  "board.list": z.strictObject({
    category: z.string().max(100).optional(),
    cursor: cursorParam,
    limit: limitParam,
  }),
  "board.get": z.strictObject({
    boardId: boardIdParam.optional(),
    slug: z.string().max(64).optional(),
  }),
  "thread.list": z.strictObject({
    boardId: boardIdParam,
    cursor: cursorParam,
    limit: limitParam,
  }),
  "thread.get": z.strictObject({ threadId: z.number().int().positive() }),
  "post.list": z.strictObject({
    threadId: z.number().int().positive(),
    afterPostId: z.number().int().nonnegative().optional(),
    limit: limitParam,
  }),
  "post.get": z.strictObject({ postId: z.number().int().positive() }),
  search: z.strictObject({
    q: z.string().min(1).max(200),
    boardId: boardIdParam.optional(),
    threadId: z.number().int().positive().optional(),
    limit: limitParam,
    cursor: cursorParam,
  }),
  "report.list": z.strictObject({
    boardId: boardIdParam.optional(),
    status: z.string().max(32).optional(),
    cursor: cursorParam,
    limit: limitParam,
  }),
  "report.get": z.strictObject({ reportId: z.string().max(64) }),
  "queue.list": z.strictObject({
    status: z.enum(["pending", "approved", "rejected", "executed", "failed", "expired"]).optional(),
    limit: limitParam,
  }),
  "audit.read": z.strictObject({ limit: limitParam, cursor: cursorParam }),
  "stats.read": z.strictObject({ boardId: boardIdParam.optional() }),
  "monitor.feed": z.strictObject({
    boardId: boardIdParam.optional(),
    cursor: cursorParam,
    limit: limitParam,
  }),
  "classify.draft": z.strictObject({ text: z.string().min(1).max(8192) }),
  "agent.self": z.strictObject({}),
  "agent.suspend_self": z.strictObject({ reason: reasonParam }),
  "queue.cancel_own": z.strictObject({ queueId: z.string().max(64) }),

  // ── medium: 可逆・限定付き（エージェント設定に応じて auto / queue） ──
  "post.create": z.strictObject({
    boardId: boardIdParam,
    /** 省略すると新規スレッド作成（title 必須） */
    threadId: z.number().int().positive().optional(),
    title: z.string().min(1).max(200).optional(),
    name: z.string().max(100).optional(),
    mail: z.string().max(100).optional(),
    body: z.string().min(1).max(8192),
  }),
  "post.reply": z.strictObject({
    threadId: z.number().int().positive(),
    name: z.string().max(100).optional(),
    mail: z.string().max(100).optional(),
    body: z.string().min(1).max(8192),
  }),
  "post.hide": z.strictObject({
    postId: z.number().int().positive(),
    reason: z.string().max(500).optional(),
  }),
  "post.mark_spam": z.strictObject({
    postId: z.number().int().positive(),
    reason: z.string().max(500).optional(),
  }),
  "thread.live_off": z.strictObject({ threadId: z.number().int().positive() }),
  "report.triage": z.strictObject({
    reportId: z.string().max(64),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    verdict: z.enum(["actionable", "invalid", "duplicate"]).optional(),
    note: z.string().max(2000).optional(),
  }),
  "board.settings_update": z.strictObject({
    boardId: boardIdParam,
    settings: z.strictObject({
      cooldown_seconds: z.number().int().min(0).max(600).optional(),
      turnstile_required: z.boolean().optional(),
      live: z.boolean().optional(),
      wordfilter: z.array(z.string().max(100)).max(200).optional(),
    }),
  }),
  "plugin.install": z.strictObject({
    boardId: boardIdParam,
    pluginId: z.string().max(64),
    version: z.string().max(32).optional(),
  }),
  "rate_limit.apply": z.strictObject({
    boardId: boardIdParam,
    cooldownSeconds: z.number().int().min(5).max(600),
    reason: reasonParam,
  }),

  // ── high: 不可逆・全体影響（常に人間承認キュー） ──
  "post.delete": z.strictObject({
    postId: z.number().int().positive(),
    reason: reasonParam,
  }),
  "thread.delete": z.strictObject({
    threadId: z.number().int().positive(),
    reason: reasonParam,
  }),
  "board.ban": z.strictObject({
    boardId: boardIdParam,
    deviceHash: z.string().min(8).max(128),
    reason: reasonParam,
    expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
  }),
  "site.ban": z.strictObject({
    deviceHash: z.string().min(8).max(128),
    reason: reasonParam,
    expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
  }),
  "board.rules_update": z.strictObject({
    boardId: boardIdParam,
    rulesMd: z.string().max(20_000),
  }),
  "board.design_update": z.strictObject({
    boardId: boardIdParam,
    design: z.record(z.string(), z.unknown()),
  }),
  "board.staff_update": z.strictObject({
    boardId: boardIdParam,
    accountId: z.string().min(1).max(64),
    level: z.enum(["admin", "deputy", "moderator"]).nullable(),
  }),
  "plugin.review_approve": z.strictObject({
    pluginId: z.string().max(64),
    note: z.string().max(2000).optional(),
  }),
  "plugin.review_reject": z.strictObject({
    pluginId: z.string().max(64),
    note: reasonParam,
  }),
  "plugin.suspend": z.strictObject({
    pluginId: z.string().max(64),
    note: reasonParam,
  }),
  "agent.policy_update": z.strictObject({
    scope: z.enum(["site", "board", "agent"]),
    scopeId: z.string().min(1).max(64),
    action: z.string().min(1).max(64),
    mode: policyModeSchema,
  }),
  "agent.risk_cap_update": z.strictObject({
    agentId: z.string().min(1).max(64),
    riskCap: z.enum(RISK_CAPS),
  }),
  "account.suspend": z.strictObject({
    accountId: z.string().min(1).max(64),
    reason: reasonParam,
    expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
  }),
  "site.announce": z.strictObject({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
  }),
  "board.delete": z.strictObject({
    boardId: boardIdParam,
    reason: reasonParam,
  }),
  "bulk.cross_board": z.strictObject({
    action: z.enum(["post.hide", "post.delete"]),
    postIds: z.array(z.number().int().positive()).min(1).max(100),
    reason: reasonParam,
  }),
  // 承認キュー操作自体は人間専用（AI からは常に 403）
  "queue.decide": z.strictObject({
    queueId: z.string().max(64),
    decision: z.enum(["approve", "reject"]),
    note: z.string().max(2000).optional(),
  }),

  // ── never: AI からは常に 403（カタログには存在するが実行不可） ──
  "invite.issue": z.strictObject({ kind: z.string().max(32) }),
  "owner.role_update": z.strictObject({ accountId: z.string().max(64) }),
  "special_admin.role_update": z.strictObject({ accountId: z.string().max(64) }),
  "infra.secret_read": z.strictObject({ name: z.string().max(100).optional() }),
  "policy.disable": z.strictObject({ reason: z.string().max(500).optional() }),
  "ai.resume": z.strictObject({ scope: z.string().max(32) }),
  "agent.create": z.strictObject({ name: z.string().max(100) }),
  "agent.delete": z.strictObject({ agentId: z.string().max(64) }),
  "agent.key_read": z.strictObject({ agentId: z.string().max(64) }),
  "webhook.secret_read": z.strictObject({ webhookId: z.string().max(64) }),
  "other_agent.read": z.strictObject({ agentId: z.string().max(64) }),
  "audit.purge": z.strictObject({ before: z.number().int().optional() }),
} as const;

export type AiActionName = keyof typeof AI_ACTION_PARAM_SCHEMAS;

const DEFINITIONS: Record<AiActionName, AiActionDefinition> = {
  // low
  "board.list": { risk: "low", description: "板の一覧を取得する" },
  "board.get": { risk: "low", description: "板の詳細（ルール・設定）を取得する" },
  "thread.list": { risk: "low", description: "板のスレッド一覧を取得する" },
  "thread.get": { risk: "low", description: "スレッドの情報を取得する" },
  "post.list": { risk: "low", description: "スレッドのレス一覧を取得する" },
  "post.get": { risk: "low", description: "単一レスの内容を取得する" },
  search: { risk: "low", description: "投稿・スレッドを検索する" },
  "report.list": { risk: "low", description: "通報一覧を取得する" },
  "report.get": { risk: "low", description: "通報の詳細を取得する" },
  "queue.list": { risk: "low", description: "自分が作成した承認待ち項目を取得する" },
  "audit.read": { risk: "low", description: "自分の操作監査ログを取得する" },
  "stats.read": { risk: "low", description: "板の統計（投稿数・通報数）を取得する" },
  "monitor.feed": { risk: "low", description: "投稿監視フィードをカーソルで取得する" },
  "classify.draft": { risk: "low", description: "本文のスパム分類案を作る（副作用なし）" },
  "agent.self": { risk: "low", description: "自分の権限・担当板・制限を取得する" },
  "agent.suspend_self": { risk: "low", description: "自分自身を停止する（権限を増やさない操作）" },
  "queue.cancel_own": { risk: "low", description: "自分が積んだ承認待ち項目を取り下げる" },

  // medium
  "post.create": { risk: "medium", description: "AI 名義で投稿する（スレッド新規作成を含む）" },
  "post.reply": { risk: "medium", description: "既存スレッドに返信する" },
  "post.hide": { risk: "medium", description: "レスを非表示にする（可逆）" },
  "post.mark_spam": { risk: "medium", description: "レスをスパムとして非表示にする（可逆）" },
  "thread.live_off": { risk: "medium", description: "スレッドの実況モードを解除する" },
  "report.triage": { risk: "medium", description: "通報に優先度・判定を付与する" },
  "board.settings_update": {
    risk: "medium",
    description: "板設定の allowlist 内項目を変更する",
    approvalScope: "board",
  },
  "plugin.install": { risk: "medium", description: "承認済みプラグインを板に導入する" },
  "rate_limit.apply": { risk: "medium", description: "板の連投制限（cooldown）を短期変更する" },

  // high
  "post.delete": { risk: "high", description: "レスを削除する（不可逆）", approvalScope: "board" },
  "thread.delete": { risk: "high", description: "スレッドを削除する（不可逆）", approvalScope: "board" },
  "board.ban": { risk: "high", description: "板のアクセス禁止を設定する", approvalScope: "board" },
  "site.ban": { risk: "high", description: "サイト全体のアクセス禁止を設定する", approvalScope: "site" },
  "board.rules_update": { risk: "high", description: "板ルールを変更する", approvalScope: "board" },
  "board.design_update": { risk: "high", description: "板デザインを変更する", approvalScope: "board" },
  "board.staff_update": { risk: "high", description: "板スタッフを任免する", approvalScope: "board" },
  "plugin.review_approve": {
    risk: "high",
    description: "サイト公開プラグインを承認する",
    approvalScope: "site",
  },
  "plugin.review_reject": {
    risk: "high",
    description: "サイト公開プラグインを却下する",
    approvalScope: "site",
  },
  "plugin.suspend": { risk: "high", description: "プラグインを停止する", approvalScope: "site" },
  "agent.policy_update": {
    risk: "high",
    description: "AI 政策（auto/queue/deny）を変更する",
    approvalScope: "site",
  },
  "agent.risk_cap_update": {
    risk: "high",
    description: "AI の権限上限（risk_cap）を変更する",
    approvalScope: "site",
  },
  "account.suspend": { risk: "high", description: "アカウントを停止する", approvalScope: "site" },
  "site.announce": { risk: "high", description: "サイト全体のお知らせを掲示する", approvalScope: "site" },
  "board.delete": { risk: "high", description: "板を削除する", approvalScope: "site" },
  "bulk.cross_board": { risk: "high", description: "複数投稿の一括操作", approvalScope: "site" },
  "queue.decide": {
    risk: "high",
    description: "承認キューの可否判断（人間セッション専用）",
    humanOnly: true,
  },

  // never
  "invite.issue": { risk: "never", description: "招待キー発行（AI 不可）" },
  "owner.role_update": { risk: "never", description: "owner 権限の変更（AI 不可）" },
  "special_admin.role_update": { risk: "never", description: "特別管理人権限の変更（AI 不可）" },
  "infra.secret_read": { risk: "never", description: "インフラ秘密情報の読取（AI 不可）" },
  "policy.disable": { risk: "never", description: "政策エンジンの無効化（AI 不可）" },
  "ai.resume": { risk: "never", description: "緊急停止の解除（人間のみ）" },
  "agent.create": { risk: "never", description: "AI 管理者の新規登録（AI 不可）" },
  "agent.delete": { risk: "never", description: "AI 管理者の削除（AI 不可）" },
  "agent.key_read": { risk: "never", description: "API キーの読取（AI 不可）" },
  "webhook.secret_read": { risk: "never", description: "Webhook 署名鍵の読取（AI 不可）" },
  "other_agent.read": { risk: "never", description: "他 agent の情報読取（AI 不可）" },
  "audit.purge": { risk: "never", description: "監査ログの削除（AI 不可）" },
};

export const AI_ACTION_NAMES = Object.keys(AI_ACTION_PARAM_SCHEMAS) as AiActionName[];

export function isAiActionName(value: string): value is AiActionName {
  return Object.prototype.hasOwnProperty.call(AI_ACTION_PARAM_SCHEMAS, value);
}

/** action の定義（未知の action は undefined）。 */
export function aiActionDefinition(action: string): AiActionDefinition | undefined {
  if (!isAiActionName(action)) return undefined;
  return DEFINITIONS[action];
}

/** action のリスク。未知の action は undefined。 */
export function riskOf(action: string): RiskLevel | undefined {
  return aiActionDefinition(action)?.risk;
}

/** カタログをリスク別に列挙する（ダッシュボード・ドキュメント生成用）。 */
export function actionsByRisk(risk: RiskLevel): AiActionName[] {
  return AI_ACTION_NAMES.filter((name) => DEFINITIONS[name].risk === risk);
}

/**
 * リスク既定モード（DESIGN §10.2）。low=auto, medium=auto（agent 設定で上書き）, high=queue, never=deny。
 */
export function defaultModeForRisk(risk: RiskLevel): PolicyMode {
  switch (risk) {
    case "low":
      return "auto";
    case "medium":
      return "auto";
    case "high":
      return "queue";
    case "never":
      return "deny";
  }
}