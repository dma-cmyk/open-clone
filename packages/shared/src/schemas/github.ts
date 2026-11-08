// GitHub 連携（OAuth / PAT / Gist / リポジトリ）の公開契約（WORKPACKAGES §3.4）。
// トークンは AES-256-GCM で暗号化して D1 に保存する（DESIGN §8）。平文はレスポンスに含めない。

import { z } from "zod";

// ───────────────────────── 定数（GitHub の制限をコードで守る） ─────────────────────────

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_OAUTH_SCOPES = ["public_repo", "gist"] as const;

/** 通常ファイルのハード上限（100 MiB 超は GitHub がブロック） */
export const GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Contents API の PUT は base64 送信のため実用上限 1 MiB に制限する */
export const GITHUB_CONTENTS_API_MAX_BYTES = 1024 * 1024;
/** Gist API が返せる 1 ファイルあたりの上限 */
export const GIST_MAX_FILE_BYTES = 1024 * 1024;
/** Gist 1 件あたりのファイル数上限（GitHub の一覧上限 300 より安全側） */
export const GIST_MAX_FILES = 20;
/** Gist リクエスト全体の上限（Worker のメモリ保護。API 1MB/ファイル × 数ファイル想定） */
export const GIST_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** レート残がこの値以下なら操作を止める（枯渇で全機能が止まるのを防ぐ） */
export const GITHUB_RATE_SAFETY_MARGIN = 10;
/** OAuth state の有効秒数 */
export const GITHUB_OAUTH_STATE_TTL_SECONDS = 600;

/** リポジトリ名・オーナー名の書式（GitHub の許容文字） */
export const githubOwnerSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "GitHub のオーナー名が不正です");
export const githubRepoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "GitHub のリポジトリ名が不正です");
/** リポジトリ内パス（`..` や先頭 `/` を拒否） */
export const githubPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "パスが不正です");

// ───────────────────────── レート ─────────────────────────

export const githubRateSchema = z.object({
  limit: z.number().int(),
  remaining: z.number().int(),
  reset: z.number().int(),
  resource: z.string(),
});
export type GithubRate = z.infer<typeof githubRateSchema>;

// ───────────────────────── 連携状態 ─────────────────────────

export const githubLinkStatusSchema = z.object({
  linked: z.boolean(),
  login: z.string().nullable(),
  userId: z.number().int().nullable(),
  avatarUrl: z.string().nullable(),
  method: z.enum(["oauth", "pat"]).nullable(),
  scopes: z.array(z.string()),
  linkedAt: z.number().int().nullable(),
  rate: githubRateSchema.nullable(),
  /** OAuth App がこの環境に設定されているか（未設定なら PAT のみ案内） */
  oauthAvailable: z.boolean(),
});
export type GithubLinkStatus = z.infer<typeof githubLinkStatusSchema>;

export const githubOauthStartResultSchema = z.object({
  authorizeUrl: z.string(),
  state: z.string(),
});
export type GithubOauthStartResult = z.infer<typeof githubOauthStartResultSchema>;

export const githubOauthCallbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(4096),
});
export type GithubOauthCallbackInput = z.infer<typeof githubOauthCallbackSchema>;

export const githubPatSchema = z.object({
  /** fine-grained PAT（github_pat_...）または classic PAT（ghp_...） */
  token: z.string().min(20).max(255),
});
export type GithubPatInput = z.infer<typeof githubPatSchema>;

// ───────────────────────── Gist ─────────────────────────

export const gistFileInputSchema = z.object({
  content: z.string(),
  /** 省略時はキー（ファイル名）を使う */
  filename: z.string().min(1).max(200).optional(),
});
export type GistFileInput = z.infer<typeof gistFileInputSchema>;

export const createGistSchema = z
  .object({
    description: z.string().max(256).optional(),
    public: z.boolean().default(false),
    files: z.record(z.string().min(1).max(200), gistFileInputSchema),
  })
  .refine((value) => Object.keys(value.files).length > 0, "ファイルが 1 つもありません")
  .refine((value) => Object.keys(value.files).length <= GIST_MAX_FILES, `Gist のファイルは ${GIST_MAX_FILES} 個までです`)
  .refine(
    (value) =>
      Object.values(value.files).every(
        (file) => new TextEncoder().encode(file.content).byteLength <= GIST_MAX_FILE_BYTES,
      ),
    `Gist の 1 ファイルは ${GIST_MAX_FILE_BYTES} バイトまでです`,
  )
  .refine(
    (value) =>
      Object.values(value.files).reduce(
        (total, file) => total + new TextEncoder().encode(file.content).byteLength,
        0,
      ) <= GIST_MAX_TOTAL_BYTES,
    `Gist 1 件の合計は ${GIST_MAX_TOTAL_BYTES} バイトまでです`,
  );
export type CreateGistBody = z.infer<typeof createGistSchema>;

export const updateGistSchema = z.object({
  description: z.string().max(256).optional(),
  files: z.record(z.string().min(1).max(200), gistFileInputSchema.nullable()).optional(),
});
export type UpdateGistBody = z.infer<typeof updateGistSchema>;

export const gistSummarySchema = z.object({
  id: z.string(),
  htmlUrl: z.string(),
  description: z.string().nullable(),
  public: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  files: z.array(z.object({ filename: z.string(), size: z.number().int(), rawUrl: z.string().nullable() })),
});
export type GistSummary = z.infer<typeof gistSummarySchema>;

// ───────────────────────── リポジトリ ─────────────────────────

export const repoSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
  permissions: z.object({ push: z.boolean() }).nullable(),
});
export type RepoSummaryDto = z.infer<typeof repoSummarySchema>;

export const repoListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
  sort: z.enum(["updated", "pushed", "full_name", "created"]).default("updated"),
});
export type RepoListQuery = z.infer<typeof repoListQuerySchema>;

export const repoFileWriteSchema = z.object({
  path: githubPathSchema,
  content: z.string(),
  message: z.string().min(1).max(200).default("Update from おーぷんクローン"),
  sha: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(200).optional(),
});
export type RepoFileWriteBody = z.infer<typeof repoFileWriteSchema>;

export const repoFileReadQuerySchema = z.object({
  path: githubPathSchema,
  ref: z.string().min(1).max(200).optional(),
});
export type RepoFileReadQuery = z.infer<typeof repoFileReadQuerySchema>;

export const repoFileDeleteSchema = z.object({
  path: githubPathSchema,
  sha: z.string().min(1).max(100),
  message: z.string().min(1).max(200).default("Delete from おーぷんクローン"),
  branch: z.string().min(1).max(200).optional(),
});
export type RepoFileDeleteBody = z.infer<typeof repoFileDeleteSchema>;

export const repoFileSchema = z.object({
  path: z.string(),
  sha: z.string(),
  size: z.number().int(),
  content: z.string().nullable(),
  encoding: z.string().nullable(),
  htmlUrl: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  rawUrl: z.string().nullable(),
});
export type RepoFileDto = z.infer<typeof repoFileSchema>;

// ───────────────────────── エラー詳細（連携誘導） ─────────────────────────

/** 未連携時の 403 details。UI はこれを見て `/account/github` へ誘導する。 */
export interface GithubLinkRequiredDetails {
  linkRequired: true;
  linkUrl: string;
}

export const GITHUB_LINK_REQUIRED_DETAILS: GithubLinkRequiredDetails = {
  linkRequired: true,
  linkUrl: "/account/github",
};