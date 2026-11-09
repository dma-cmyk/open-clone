#!/usr/bin/env node
// docs/api.md を shared の zod スキーマと apps/api のルート定義から生成する。
//
// 実行:
//   pnpm --filter e2e gen:api-docs
//   （= pnpm --filter e2e exec tsx tools/gen-api-docs.ts）
//
// 方針:
// - スキーマは packages/shared/src/schemas/*.ts を実際に import し、zod v4 の toJSONSchema で出力する。
// - ルートは apps/api/src/routes/*.ts を静的解析して method/path/ミドルウェアを抽出する。
// - 未実装（501 スタブ）は「要確認」として明示する。推測で実装済みと書かない。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "packages/shared/src/schemas");
const ROUTES_DIR = path.join(ROOT, "apps/api/src/routes");
const OUT_FILE = path.join(ROOT, "docs/api.md");

// スキーマファイルはディレクトリ走査で列挙するため、モジュール指定子が実行時に決まる。
// （静的 import では「新しい schema ファイルを自動で拾う」要件を満たせない）
const requireFromShared = createRequire(path.join(ROOT, "packages/shared/package.json"));

interface ZodLike {
  safeParse: unknown;
  _def: unknown;
}

interface ZodModule {
  toJSONSchema: (schema: unknown, options?: Record<string, unknown>) => unknown;
}

async function loadZod(): Promise<ZodModule> {
  const resolved = requireFromShared.resolve("zod");
  const mod = (await import(pathToFileURL(resolved).href)) as {
    z?: ZodModule;
    default?: { z?: ZodModule } & ZodModule;
  };
  const z = mod.z ?? mod.default?.z ?? mod.default;
  if (!z || typeof z.toJSONSchema !== "function") {
    throw new Error("zod v4 (toJSONSchema) を解決できませんでした");
  }
  return z;
}

function isZodSchema(value: unknown): value is ZodLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    "_def" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

interface SchemaEntry {
  file: string;
  name: string;
  jsonSchema: unknown;
  error?: string;
}

async function collectSchemas(z: ZodModule): Promise<{ entries: SchemaEntry[]; failures: string[] }> {
  const entries: SchemaEntry[] = [];
  const failures: string[] = [];
  const files = fs
    .readdirSync(SCHEMA_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

  for (const file of files) {
    const fullPath = path.join(SCHEMA_DIR, file);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(fullPath).href)) as Record<string, unknown>;
    } catch (error) {
      failures.push(`${file}: import 失敗 — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const name of Object.keys(mod).sort()) {
      const value = mod[name];
      if (!isZodSchema(value)) continue;
      try {
        const jsonSchema = z.toJSONSchema(value, {
          io: "input",
          unrepresentable: "any",
          target: "draft-2020-12",
        });
        entries.push({ file, name, jsonSchema });
      } catch (error) {
        entries.push({
          file,
          name,
          jsonSchema: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { entries, failures };
}

interface RouteEntry {
  file: string;
  method: string;
  routePath: string;
  middleware: string[];
  line: number;
}

const MIDDLEWARE_PATTERN =
  /\b(requireAuth|requireOwner|requireOwnerActive|requireAdmin|requireAdminActive|requireRole|requireBoardStaff|requireAction|requireTurnstile|optionalAuth)\b/g;

function extractRoutes(): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const files = fs
    .readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  for (const file of files) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    const lines = source.split("\n");
    const routePattern = /app\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g;
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(source)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const line = source.slice(0, match.index).split("\n").length;
      // ルート定義の続き（次のルート定義まで最大 12 行）からミドルウェア名を拾う。
      const window = lines.slice(line - 1, line + 12).join("\n");
      const middleware = Array.from(new Set(Array.from(window.matchAll(MIDDLEWARE_PATTERN), (m) => m[1])));
      routes.push({ file, method, routePath, middleware, line });
    }
  }
  return routes;
}

interface RouteFileStatus {
  file: string;
  owner: string;
  mount: string;
  status: string;
}

const ROUTE_FILES: Array<{ file: string; owner: string; mount: string }> = [
  { file: "meta.ts", owner: "WP0", mount: "/v1/meta, /v1（health alias）" },
  { file: "auth.ts", owner: "WP6", mount: "/v1/auth" },
  { file: "github-auth.ts", owner: "WP4", mount: "/v1/github/oauth, /v1/github/link" },
  { file: "accounts.ts", owner: "WP6", mount: "/v1/accounts" },
  { file: "invites.ts", owner: "WP6", mount: "/v1/admin/invites" },
  { file: "admin.ts", owner: "WP6", mount: "/v1/admin" },
  { file: "boards.ts", owner: "WP1", mount: "/v1/boards" },
  { file: "threads.ts", owner: "WP1", mount: "/v1/threads" },
  { file: "posts.ts", owner: "WP1", mount: "/v1/posts" },
  { file: "search.ts", owner: "WP1", mount: "/v1/search" },
  { file: "ranking.ts", owner: "WP1", mount: "/v1/ranking, /v1/headline" },
  { file: "reports.ts", owner: "WP1", mount: "/v1/reports" },
  { file: "compat.ts", owner: "WP1", mount: "/compat" },
  { file: "rt.ts", owner: "WP1", mount: "/v1/rt, /rt" },
  { file: "uploads.ts", owner: "WP4", mount: "/v1/uploads" },
  { file: "github-files.ts", owner: "WP4", mount: "/v1/github/files, /v1/github/hooks" },
  { file: "plugins.ts", owner: "WP3", mount: "/v1/plugins" },
  { file: "plugin-net.ts", owner: "WP3", mount: "/v1/plugin-net" },
  { file: "ai.ts", owner: "WP5", mount: "/v1/ai" },
  { file: "mcp.ts", owner: "WP5", mount: "/mcp, /mcp/legacy" },
];

function routeFileStatuses(): RouteFileStatus[] {
  return ROUTE_FILES.map((entry) => {
    const fullPath = path.join(ROUTES_DIR, entry.file);
    if (!fs.existsSync(fullPath)) {
      return { ...entry, status: "ファイルなし（要確認）" };
    }
    const source = fs.readFileSync(fullPath, "utf8");
    const allPaths = Array.from(
      source.matchAll(/app\.all\(\s*["'`]([^"'`]+)["'`]/g),
      (match) => match[1],
    );
    const realRouteCount =
      (source.match(/app\.(get|post|put|patch|delete)\(/g) ?? []).length +
      allPaths.filter((routePath) => routePath !== "*").length;
    const hasFallbackStub = source.includes("NOT_IMPLEMENTED") && allPaths.includes("*");
    const isEmpty = /^\s*export\s*\{\s*\}\s*;?\s*$/m.test(source) && realRouteCount === 0;
    const status =
      realRouteCount === 0 && hasFallbackStub
        ? "501 スタブ（未実装）"
        : realRouteCount > 0 && hasFallbackStub
          ? "一部実装（fallback 501 あり）"
          : realRouteCount > 0
            ? "実装あり"
            : isEmpty
              ? "空（未実装）"
              : "要確認";
    return { ...entry, status };
  });
}

async function main(): Promise<void> {
  const z = await loadZod();
  const { entries, failures } = await collectSchemas(z);
  const routes = extractRoutes();
  const statuses = routeFileStatuses();

  const errorCodes = (await import(pathToFileURL(path.join(ROOT, "packages/shared/src/errors.ts")).href)) as {
    ErrorCode: Record<string, string>;
  };
  const constants = (await import(pathToFileURL(path.join(ROOT, "packages/shared/src/constants.ts")).href)) as {
    RATE_LIMITS: Record<string, { windowSeconds: number; max: number }>;
  };

  const lines: string[] = [];
  lines.push("# REST API 仕様");
  lines.push("");
  lines.push("> このファイルは `tools/gen-api-docs.ts` が生成する。**手編集しない**。");
  lines.push("> 生成: `pnpm --filter e2e gen:api-docs`");
  lines.push("> 正本: `packages/shared/src/schemas/*.ts`（zod）と `apps/api/src/routes/*.ts`。");
  lines.push("> 未実装のルートは「501 スタブ」と明記し、実装済みと推測で書かない。");
  lines.push("");
  lines.push("## 1. 共通仕様");
  lines.push("");
  lines.push("### 1.1 レスポンス envelope");
  lines.push("");
  lines.push("成功: `200` / `201`");
  lines.push("");
  lines.push("```json");
  lines.push('{ "ok": true, "data": { } }');
  lines.push("```");
  lines.push("");
  lines.push("失敗: `4xx` / `5xx`");
  lines.push("");
  lines.push("```json");
  lines.push('{ "ok": false, "code": "ERROR_CODE", "message": "人間向け説明", "details": null }');
  lines.push("```");
  lines.push("");
  lines.push("`details` は省略可能。`ZodError` は `400 VALIDATION` と `details: issues` に変換される。");
  lines.push("");
  lines.push("### 1.2 エラーコード");
  lines.push("");
  lines.push("| code | 意味 |");
  lines.push("|---|---|");
  const errorMeanings: Record<string, string> = {
    INTERNAL: "想定外の内部エラー（詳細は返さない）",
    MISCONFIGURED: "サーバ設定不足（secret 未設定等）",
    NOT_FOUND: "リソース不在 / ルート不在",
    NOT_IMPLEMENTED: "未実装（WP スタブ）",
    VALIDATION: "入力検証エラー",
    BAD_REQUEST: "不正なリクエスト",
    UNAUTHORIZED: "認証が必要",
    FORBIDDEN: "権限不足",
    BAD_ORIGIN: "Origin/CSRF 検証失敗",
    TURNSTILE_FAILED: "Turnstile 検証失敗",
    RATE_LIMITED: "レート制限",
    BANNED: "アクセス禁止",
    CONFLICT: "競合（重複・状態不整合）",
    PAYLOAD_TOO_LARGE: "本文サイズ超過",
    AI_STOPPED: "AI 緊急停止中",
    BAD_GATEWAY: "外部サービス応答異常",
    TOTP_REQUIRED: "TOTP コードの入力が必要（ログイン二段目）",
    TOTP_INVALID: "TOTP コードが不正（残り試行回数を details.remaining で返す）",
    TOTP_LOCKED: "TOTP 失敗回数が上限。ロック解除まで待機（details.lockedUntil）",
    STEP_UP_REQUIRED: "高リスク操作に TOTP step-up（再認証）が必要",
    INVITE_INVALID: "招待キーが無効・期限切れ・使用済み",
    OWNER_SETUP_CLOSED: "owner 初期設定は完了済み（再実行不可）",
  };
  for (const code of Object.values(errorCodes.ErrorCode)) {
    lines.push(`| \`${code}\` | ${errorMeanings[code] ?? "要確認"} |`);
  }
  lines.push("");
  lines.push("### 1.3 認証");
  lines.push("");
  lines.push("- セッション Cookie: `oc_sess`（HttpOnly）。`Authorization: Bearer ocai_...` は AI agent 用。");
  lines.push("- 端末 Cookie: `oc_did`（HttpOnly、初回リクエストで発行）。");
  lines.push("- mutation（POST/PUT/PATCH/DELETE）は `Origin` が `ALLOWED_ORIGINS` に一致すること。");
  lines.push("- 権限は `packages/shared/src/schemas/permission.ts` の `can()` とサーバ側ミドルウェアで強制。");
  lines.push("");
  lines.push("### 1.4 レート制限（`shared/constants.ts`）");
  lines.push("");
  lines.push("| scope | window | max |");
  lines.push("|---|---|---|");
  for (const [scope, limit] of Object.entries(constants.RATE_LIMITS)) {
    lines.push(`| ${scope} | ${limit.windowSeconds}s | ${limit.max} |`);
  }
  lines.push("");
  lines.push("## 2. エンドポイント一覧（自動抽出）");
  lines.push("");
  if (routes.length === 0) {
    lines.push("_ルート定義がまだ抽出できていない（全ルートが 501 スタブ）。_");
  } else {
    lines.push("| Method | Path | ミドルウェア | ファイル | 行 |");
    lines.push("|---|---|---|---|---|");
    for (const route of routes) {
      lines.push(
        `| ${route.method} | \`${route.routePath.replace(/\|/g, "\\|").replace(/\n/g, " ")}\` | ${route.middleware.length > 0 ? route.middleware.map((m) => `\`${m}\``).join(", ") : "—"} | \`${route.file}\` | ${route.line} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 3. ルートファイル別の実装状況");
  lines.push("");
  lines.push("| ファイル | 所有 | mount | 状態 |");
  lines.push("|---|---|---|---|");
  for (const status of statuses) {
    lines.push(`| \`${status.file}\` | ${status.owner} | \`${status.mount}\` | ${status.status} |`);
  }
  lines.push("");
  lines.push("## 4. 予定エンドポイント（WORKPACKAGES §3.2 の契約）");
  lines.push("");
  lines.push("以下は契約上の予定であり、実装状況は §3 を参照。未実装のものは **要確認**。");
  lines.push("");
  lines.push("| mount | 主な用途 | 所有 |");
  lines.push("|---|---|---|");
  const planned: Array<[string, string, string]> = [
    ["`/v1/meta/*`", "health / usage", "WP0"],
    ["`/v1/auth/*`", "register, login, logout, session, totp/*, recovery", "WP6"],
    ["`/v1/github/oauth/*`, `/v1/github/link*`", "GitHub OAuth / 連携", "WP4"],
    ["`/v1/accounts/*`", "自分情報、アカウント停止（admin）", "WP6"],
    ["`/v1/admin/invites/*`", "招待キー発行 / accept", "WP6"],
    ["`/v1/admin/*`", "site settings, suspensions, audit, owner setup", "WP6"],
    ["`/v1/boards/*`", "一覧, 作成, 詳細, 設定, スタッフ任免", "WP1"],
    ["`/v1/threads/*`", "一覧, 作成, レス取得 ?since, 実況", "WP1"],
    ["`/v1/posts/*`", "作成, つぶやき, 削除/非表示, 投票, 安価", "WP1"],
    ["`/v1/search/*`", "スレタイ/全文/ID/画像検索", "WP1"],
    ["`/v1/ranking/*`, `/v1/headline/*`", "ランキング / ヘッドライン", "WP1"],
    ["`/v1/reports/*`", "通報作成, 一覧, 処理", "WP1"],
    ["`/compat/*`", "subject.txt, dat, bbs.cgi 互換, rss（Shift_JIS）", "WP1"],
    ["`/v1/rt/ticket`, `/rt`", "WebSocket ticket / 接続", "WP1"],
    ["`/v1/uploads/*`", "prepare, proxy, commit, history, delete", "WP4"],
    ["`/v1/github/files/*`, `/v1/github/hooks/*`", "repo/gist CRUD プロキシ, webhook", "WP4"],
    ["`/v1/plugins/*`", "CRUD, code 配信, install, review, hooks/github", "WP3"],
    ["`/v1/plugin-net/*`", "サンドボックス net:fetch プロキシ", "WP3"],
    ["`/v1/ai/*`", "agents CRUD, policies, queue, audit, stop, webhooks", "WP5"],
    ["`/mcp`, `/mcp/legacy`", "MCP サーバー（ステートレス / 旧互換）", "WP5"],
  ];
  for (const [mount, purpose, owner] of planned) {
    lines.push(`| ${mount} | ${purpose} | ${owner} |`);
  }
  lines.push("");
  lines.push("## 5. スキーマ（zod → JSON Schema）");
  lines.push("");
  if (entries.length === 0) {
    lines.push("_スキーマがまだ抽出できていない。_");
  }
  let currentFile = "";
  for (const entry of entries) {
    if (entry.file !== currentFile) {
      currentFile = entry.file;
      lines.push(`### \`packages/shared/src/schemas/${entry.file}\``);
      lines.push("");
    }
    lines.push(`#### \`${entry.name}\``);
    lines.push("");
    if (entry.error) {
      lines.push(`> JSON Schema 生成失敗（要確認）: ${entry.error}`);
    } else {
      lines.push("```json");
      lines.push(JSON.stringify(entry.jsonSchema, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  if (failures.length > 0) {
    lines.push("### 生成できなかったスキーマファイル（要確認）");
    lines.push("");
    for (const failure of failures) lines.push(`- ${failure}`);
    lines.push("");
  }
  lines.push("## 6. 未実装・要確認");
  lines.push("");
  const unimplemented = statuses.filter((status) => status.status !== "実装あり");
  if (unimplemented.length === 0) {
    lines.push("なし（全ルートファイルに実装あり）。");
  } else {
    for (const status of unimplemented) {
      lines.push(`- \`${status.file}\`（${status.owner}）: ${status.status}`);
    }
  }
  lines.push("");
  lines.push("> この一覧は生成時点の静的解析結果。実装が進んだら再生成すること。");
  lines.push("");

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
  console.log(`[gen-api-docs] wrote ${path.relative(ROOT, OUT_FILE)} (${entries.length} schemas, ${routes.length} routes)`);
  if (failures.length > 0) {
    console.warn(`[gen-api-docs] ${failures.length} schema file(s) failed to import (see docs/api.md §5)`);
  }
}

main().catch((error) => {
  console.error("[gen-api-docs] failed:", error);
  process.exitCode = 1;
});