// GitHub / Gist 経由のプラグイン導入・公開・更新（DESIGN §7.3 / §8）。
// 取込は公開 Gist / 公開リポジトリを GitHub の公開 API から直接読む（未認証 60 req/h を守る）。
// 発行は WP4 の github サービス契約（createGist / pushToRepo）を呼ぶ。未連携ならエラーを返すだけで、
// サイト内レジストリ機能（作成・公開・検索・導入・更新）は GitHub なしで完結する。

import {
  ApiError,
  PLUGIN_ENTRY_FILENAME,
  PLUGIN_MANIFEST_FILENAME,
  normalizeManifest,
  type PluginManifest,
} from "shared";
import { createGist, githubClient, pushToRepo } from "../github/service";
import type { Env } from "../../lib/env";
import type { PluginRow } from "./registry";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const USER_AGENT = "open-clone-plugin-registry";

export interface ImportedPluginSource {
  manifest: PluginManifest;
  code: string;
  /** source_ref に保存する JSON 文字列 */
  sourceRef: string;
  source: "gist" | "github";
  files: string[];
}

interface GistFile {
  filename: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

function githubHeaders(accept = "application/vnd.github+json"): HeadersInit {
  return { accept, "user-agent": USER_AGENT };
}

/** Gist URL / 生 ID から Gist ID を取り出す。 */
export function parseGistId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = /gist\.github(?:usercontent)?\.com\/(?:[^/]+\/)?([0-9a-f]{5,40})/i.exec(trimmed);
  if (urlMatch?.[1]) return urlMatch[1];
  if (/^[0-9a-f]{5,40}$/i.test(trimmed)) return trimmed;
  throw ApiError.validation("Gist の URL または ID を指定してください（例: https://gist.github.com/user/abcdef123456）");
}

function pickManifestKey(files: Record<string, GistFile>): string | null {
  const keys = Object.keys(files);
  const exact = keys.find((key) => key === PLUGIN_MANIFEST_FILENAME || key.endsWith(`/${PLUGIN_MANIFEST_FILENAME}`));
  if (exact) return exact;
  const anyJson = keys.find((key) => /(^|\/)(manifest|plugin|openclone\.plugin)\.json$/i.test(key));
  return anyJson ?? null;
}

function pickCodeKey(files: Record<string, GistFile>, manifest: PluginManifest): string | null {
  const keys = Object.keys(files);
  const entryBase = manifest.entry.split("/").pop() ?? PLUGIN_ENTRY_FILENAME;
  const exact = keys.find((key) => key === manifest.entry || key.endsWith(`/${manifest.entry}`));
  if (exact) return exact;
  const byBase = keys.find((key) => key.split("/").pop() === entryBase);
  if (byBase) return byBase;
  const anyJs = keys.find((key) => /\.(?:js|mjs)$/i.test(key));
  return anyJs ?? null;
}

/** ZodError の issues を型安全に取り出す（Zod のエラー型に依存しない）。 */
function zodIssues(error: unknown): unknown[] | undefined {
  if (error instanceof Error && "issues" in error) {
    const issues: unknown = error.issues;
    if (Array.isArray(issues)) return issues;
  }
  return undefined;
}

async function readManifestText(text: string, context: string): Promise<PluginManifest> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw ApiError.validation(`${context}: manifest が JSON として不正です`);
  }
  try {
    return normalizeManifest(json);
  } catch (error) {
    throw new ApiError(400, "VALIDATION", `${context}: manifest の検証に失敗しました`, {
      issues: zodIssues(error),
    });
  }
}

/** 公開 Gist から manifest + コードを取得する。 */
export async function fetchGistSource(gistId: string): Promise<ImportedPluginSource> {
  const response = await fetch(`${GITHUB_API}/gists/${encodeURIComponent(gistId)}`, {
    headers: githubHeaders(),
  });
  if (response.status === 404) throw ApiError.notFound("Gist が見つかりません（公開 Gist のみ取り込めます）");
  if (!response.ok) {
    throw new ApiError(502, "BAD_GATEWAY", `GitHub Gist API が ${response.status} を返しました`);
  }
  const payload = (await response.json()) as {
    id?: string;
    html_url?: string;
    description?: string | null;
    files?: Record<string, GistFile>;
  };
  const files = payload.files ?? {};
  const manifestKey = pickManifestKey(files);
  if (!manifestKey) {
    throw ApiError.validation("Gist に manifest.json が含まれていません（plugin.js と manifest.json が必要です）");
  }
  const manifestText = await readFileContent(files[manifestKey]!);
  const manifest = await readManifestText(manifestText, "Gist");
  const codeKey = pickCodeKey(files, manifest);
  if (!codeKey) {
    throw ApiError.validation(`Gist にコード（${manifest.entry}）が含まれていません`);
  }
  const code = (await readFileContent(files[codeKey]!)).trim();
  if (!code) throw ApiError.validation("Gist のコードが空です");

  return {
    manifest,
    code,
    source: "gist",
    sourceRef: JSON.stringify({
      type: "gist",
      id: payload.id ?? gistId,
      url: payload.html_url ?? `https://gist.github.com/${gistId}`,
    }),
    files: Object.keys(files),
  };
}

/** Gist のファイル内容（truncated の場合 raw_url から取得）。 */
async function readFileContent(file: GistFile): Promise<string> {
  if (typeof file.content === "string" && !file.truncated) return file.content;
  if (!file.raw_url) return file.content ?? "";
  const raw = await fetch(file.raw_url, { headers: githubHeaders("application/vnd.github.raw") });
  if (!raw.ok) throw new ApiError(502, "BAD_GATEWAY", "Gist のファイル取得に失敗しました");
  return raw.text();
}

export interface RepoRef {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
}

export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  const match = /github\.com\/([^/]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?$/.exec(trimmed);
  if (match?.[1] && match[2]) {
    return {
      owner: match[1],
      repo: match[2].replace(/\.git$/, ""),
      ref: match[3] ?? "HEAD",
      path: match[4] ? `${match[4].replace(/\/?$/, "/")}` : "",
    };
  }
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (short?.[1] && short[2]) return { owner: short[1], repo: short[2], ref: "HEAD", path: "" };
  throw ApiError.validation("リポジトリは 'owner/repo' か GitHub URL で指定してください");
}

/** 公開リポジトリから manifest + コードを取得する。 */
export async function fetchRepoSource(repo: RepoRef): Promise<ImportedPluginSource> {
  const base = `${GITHUB_RAW}/${repo.owner}/${repo.repo}/${repo.ref ?? "HEAD"}/${repo.path ?? ""}`;
  const manifestResponse = await fetch(`${base}${PLUGIN_MANIFEST_FILENAME}`, { headers: githubHeaders() });
  if (manifestResponse.status === 404) {
    throw ApiError.notFound(`リポジトリに ${PLUGIN_MANIFEST_FILENAME} が見つかりません`);
  }
  if (!manifestResponse.ok) {
    throw new ApiError(502, "BAD_GATEWAY", `GitHub raw が ${manifestResponse.status} を返しました`);
  }
  const manifest = await readManifestText(await manifestResponse.text(), "リポジトリ");
  const codeUrl = `${base}${manifest.entry || PLUGIN_ENTRY_FILENAME}`;
  const codeResponse = await fetch(codeUrl, { headers: githubHeaders() });
  if (!codeResponse.ok) {
    throw ApiError.notFound(`リポジトリにコード（${manifest.entry}）が見つかりません`);
  }
  const code = (await codeResponse.text()).trim();
  if (!code) throw ApiError.validation("リポジトリのコードが空です");

  return {
    manifest,
    code,
    source: "github",
    sourceRef: JSON.stringify({
      type: "repo",
      owner: repo.owner,
      repo: repo.repo,
      ref: repo.ref ?? "HEAD",
      path: repo.path ?? "",
      url: `https://github.com/${repo.owner}/${repo.repo}`,
    }),
    files: [PLUGIN_MANIFEST_FILENAME, manifest.entry],
  };
}

/** source_ref JSON（自前で保存した値）を安全に読み出す。 */
function parseSourceRef(sourceRef: string | null): { id?: string; owner?: string; repo?: string; ref?: string; path?: string } {
  if (!sourceRef) return {};
  let value: unknown;
  try {
    value = JSON.parse(sourceRef);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  // JSON.parse の戻りは unknown。自前保存したフラットな文字列マップなのでキーごとに typeof で絞る。
  const out: { id?: string; owner?: string; repo?: string; ref?: string; path?: string } = {};
  for (const key of ["id", "owner", "repo", "ref", "path"] as const) {
    const field: unknown = Reflect.get(value, key);
    if (typeof field === "string") out[key] = field;
  }
  return out;
}

/** source_ref から再度取り込む（更新検知）。 */
export async function fetchSourceByRef(source: string, sourceRef: string | null): Promise<ImportedPluginSource> {
  const ref = parseSourceRef(sourceRef);
  if (source === "gist" && ref.id) return fetchGistSource(ref.id);
  if (source === "github" && ref.owner && ref.repo) {
    return fetchRepoSource({ owner: ref.owner, repo: ref.repo, ref: ref.ref ?? "HEAD", path: ref.path ?? "" });
  }
  throw ApiError.validation("このプラグインには GitHub の取得元が設定されていません");
}

export interface GistExportResult {
  htmlUrl: string;
  sourceRef: string;
}

/** プラグインを Gist へ発行する（WP4 の github サービス契約を利用）。 */
export async function exportPluginToGist(
  env: Env,
  accountId: string,
  plugin: PluginRow,
  code: string,
  manifest: PluginManifest,
  options: { public: boolean; description?: string },
): Promise<GistExportResult> {
  let result: { id: string; htmlUrl: string };
  try {
    const client = await githubClient(env, accountId);
    result = await createGist(client, {
      description: options.description ?? `${manifest.name} ${manifest.version} — ${manifest.summary}`,
      public: options.public,
      files: {
        [PLUGIN_MANIFEST_FILENAME]: { content: JSON.stringify(manifest, null, 2) },
        [manifest.entry || PLUGIN_ENTRY_FILENAME]: { content: code },
        "README.md": {
          content: `# ${manifest.name}\n\n${manifest.summary}\n\nopen-clone plugin ${manifest.version}\n`,
        },
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "BAD_GATEWAY",
      "GitHub 連携（Gist 発行）に失敗しました。GitHub アカウント連携を確認してください",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return {
    htmlUrl: result.htmlUrl,
    sourceRef: JSON.stringify({ type: "gist", id: result.id, url: result.htmlUrl }),
  };
}

/** プラグインをユーザーのリポジトリへ push する（WP4 契約）。 */
export async function exportPluginToRepo(
  env: Env,
  accountId: string,
  plugin: PluginRow,
  code: string,
  manifest: PluginManifest,
  input: { owner: string; repo: string; path: string; message?: string },
): Promise<string[]> {
  const prefix = input.path.replace(/^\/+|\/+$/g, "");
  const join = (name: string): string => (prefix ? `${prefix}/${name}` : name);
  const message = input.message ?? `plugins: ${manifest.name} ${manifest.version}`;
  const written: string[] = [];
  try {
    const client = await githubClient(env, accountId);
    await pushToRepo(client, {
      owner: input.owner,
      repo: input.repo,
      path: join(PLUGIN_MANIFEST_FILENAME),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      message,
    });
    written.push(join(PLUGIN_MANIFEST_FILENAME));
    await pushToRepo(client, {
      owner: input.owner,
      repo: input.repo,
      path: join(manifest.entry || PLUGIN_ENTRY_FILENAME),
      content: code,
      message,
    });
    written.push(join(manifest.entry || PLUGIN_ENTRY_FILENAME));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "BAD_GATEWAY",
      "GitHub 連携（リポジトリへの push）に失敗しました。GitHub アカウント連携を確認してください",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return written;
}