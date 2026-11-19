#!/usr/bin/env node
// 外部サービス（Catbox / Cloudinary / GitHub / Turnstile）のローカルスタブ。
//
// 使い方:
//   node e2e/scripts/stub-server.mjs            # E2E_STUB_PORT（既定 8898）で起動
//   E2E_STUB_PORT=9000 node e2e/scripts/stub-server.mjs
//
// テストからの制御:
//   GET  /__health     稼働確認
//   POST /__reset      リクエストログを空にする
//   GET  /__requests   受けたリクエストのログ（JSON）
//
// 実 API と同じ形の応答を返す。外部サービスへは一切接続しない。
// 本番コードのエンドポイントを差し替えるには base URL 環境変数（例: GITHUB_API_BASE）を使う。
// 未対応の差し替えが必要なら、スタブの応答をここに追加する。
import http from "node:http";

const PORT = Number(process.env.E2E_STUB_PORT ?? process.argv[2] ?? 8898);
const HOST = process.env.E2E_STUB_HOST ?? "127.0.0.1";
/** アップロード応答に載せる URL の基底。実 CDN へブラウザを飛ばさない（C-9）。 */
const PUBLIC_URL = (process.env.E2E_STUB_PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/$/, "");

/** @type {Array<{method:string,url:string,headers:Record<string,string|string[]|undefined>,body:string,at:number}>} */
const requests = [];
const MAX_LOG = 500;
let counter = 0;

/**
 * siteverify が受け付けた Turnstile トークン（使い切り）。本物の siteverify は
 * 同じトークンの 2 回目を `timeout-or-duplicate` で拒否する。
 * 公式テストキーの固定ダミートークンだけは、実 siteverify のテストキーと同じく常に成功
 * させる（E2E の API 直叩きは板・スレ作成で同じ値を使い回すため）。
 */
const consumedTurnstileTokens = new Map();
const TURNSTILE_TOKEN_TTL_MS = 5 * 60 * 1000;
const ALWAYS_OK_TURNSTILE_TOKENS = new Set([
  "1x00000000000000000000AA",
  "1x00000000000000000000BB",
  "1x00000000000000000000FF",
  // 公式テストキーが実際に発行する固定ダミートークン（毎回同じ値）。
  "XXXX.DUMMY.TOKEN.XXXX",
]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

/**
 * AI ペット中継の最後の要求（`GET /pet/__last?key=<キー>` が返す）。
 * 並列試験（pc / mobile、workers=2）で `__last` を取り合わないよう、**API キーごと**に持つ。
 * キーは試験ごとに一意なので、`/__reset` では消さない（他の worker の read を消してしまう）。
 */
const petLastRequests = new Map();
/** テストが増えてもメモリを食い過ぎないための上限（古いキーから捨てる）。 */
const MAX_PET_LAST_REQUESTS = 500;
/** ツール呼び出し id の連番（`call_1`, `call_2`, …）。 */
let petCallSeq = 0;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...CORS_HEADERS,
  });
  res.end(text);
}

/** 64x64 の緑枠画像（アップロード結果の表示確認用。外部 CDN へは飛ばさない）。 */
const STUB_IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAbUlEQVR4nO3PAQnAMBDAwFqYhamdlnqal5koHD8CEZBb93ONbvGDAPrgJGC/e0QBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXQBdAF0AXT/BUwsgG484AP0IJc0LCn5qgAAAABJRU5ErkJggg==",
  "base64",
);

function sendBinary(res, status, contentType, bytes) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
    ...CORS_HEADERS,
  });
  res.end(bytes);
}

/**
 * リクエストボディからフォームフィールドを取り出す。
 * Worker の Turnstile 検証は `FormData`（multipart/form-data）で送るため、
 * urlencoded だけでなく multipart のパートも読む（E2E_TURNSTILE_STUB=1 で実測）。
 */
function formField(body, name) {
  const urlencoded = new RegExp(`(?:^|&)${name}=([^&]*)`).exec(body);
  if (urlencoded) return decodeURIComponent(urlencoded[1].replace(/\+/g, " "));
  const multipart = new RegExp(`name="${name}"\\r?\\n(?:[^\\r\\n]*\\r?\\n)*\\r?\\n([\\s\\S]*?)\\r?\\n--`).exec(body);
  return multipart ? multipart[1] : "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // 95MB の proxy テストでもメモリを食い潰さないよう上限を設ける。
      if (size > 8 * 1024 * 1024) {
        reject(new Error("stub request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** multipart の filename/content-type から拡張子を推測する。 */
function guessExtension(body, contentType) {
  if (/\.(png|jpe?g|gif|webp|mp4|webm|txt|zip|pdf)\b/i.test(body)) {
    const match = body.match(/\.(png|jpe?g|gif|webp|mp4|webm|txt|zip|pdf)\b/i);
    if (match) return `.${match[1].toLowerCase()}`;
  }
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("video/mp4")) return ".mp4";
  if (contentType.includes("text/")) return ".txt";
  return ".bin";
}

function catboxUpload(body, contentType) {
  const id = nextId("e2e");
  const ext = guessExtension(body, contentType);
  if (/e2e-fail/i.test(body)) {
    // 失敗系テスト用（呼び出し側がファイル名に e2e-fail を含める）
    return { status: 412, body: "Upload failed (stub e2e-fail)" };
  }
  return { status: 200, body: `${PUBLIC_URL}/files/${id}${ext}` };
}

function cloudinaryUpload(cloudName, resourceType) {
  const id = nextId("e2e");
  const ext = resourceType === "video" ? "mp4" : "png";
  return {
    public_id: id,
    version: Math.floor(Date.now() / 1000),
    format: ext,
    resource_type: resourceType,
    secure_url: `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/v1/${id}.${ext}`,
    url: `http://res.cloudinary.com/${cloudName}/${resourceType}/upload/v1/${id}.${ext}`,
    bytes: 12345,
    width: 640,
    height: 480,
  };
}

function githubUser() {
  return {
    login: "e2e-user",
    id: 424242,
    node_id: "MDQ6VXNlcjQyNDI0Mg==",
    avatar_url: "https://avatars.githubusercontent.com/u/424242?v=4",
    html_url: "https://github.com/e2e-user",
    type: "User",
    name: "E2E User",
  };
}

function githubGist(id) {
  return {
    id,
    description: "e2e gist",
    public: false,
    html_url: `https://gist.github.com/e2e-user/${id}`,
    files: {
      "plugin.js": {
        filename: "plugin.js",
        type: "application/javascript",
        language: "JavaScript",
        raw_url: `https://gist.githubusercontent.com/e2e-user/${id}/raw/plugin.js`,
        size: 128,
        content: "// e2e stub gist\n",
      },
    },
    owner: githubUser(),
    created_at: "2026-11-08T00:00:00Z",
    updated_at: "2026-11-08T00:00:00Z",
  };
}

function githubRateLimit() {
  return {
    resources: {
      core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 },
      search: { limit: 30, remaining: 30, reset: Math.floor(Date.now() / 1000) + 60, used: 0 },
      graphql: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 },
    },
    rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 },
  };
}

// ---- AI ペット中継（E2E スタブ） ----
//
// 設計 00 §5.1 の決まり: 動きは「最後のメッセージ」で決める。anthropic は最後の user の
// tool_result ブロックを tool 扱いにする。API キーが `bad-key` なら常に 401。
// 最後に受けた要求は `GET /pet/__last` で返す（system と tools が届いたかの確認用）。

/** 要求ヘッダーから API キーを読む（OpenAI 形式は Bearer、Anthropic 形式は x-api-key）。 */
function petApiKey(headers) {
  const authorization = String(headers.authorization ?? "");
  const bearer = /^Bearer\s+(.+)$/.exec(authorization);
  if (bearer) return bearer[1];
  const header = headers["x-api-key"];
  return typeof header === "string" ? header : "";
}

/** OpenAI / Anthropic の content（文字列 or ブロック配列）から本文を取り出す。 */
function petText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/** ツール呼び出し id から名前を探す（tool 結果の本文に載せる）。 */
function petToolName(messages, id) {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (Array.isArray(message.tool_calls)) {
      const call = message.tool_calls.find((entry) => entry && entry.id === id);
      if (call && call.function && typeof call.function.name === "string") return call.function.name;
    }
    if (Array.isArray(message.content)) {
      const block = message.content.find((entry) => entry && entry.type === "tool_use" && entry.id === id);
      if (block && typeof block.name === "string") return block.name;
    }
  }
  return "tool";
}

/** 「最後のメッセージ」を user の文か tool の結果かに分ける。 */
function petLastStep(body, protocol) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object") return { kind: "empty" };
  if (protocol === "openai" && last.role === "tool") {
    return { kind: "tool", name: petToolName(messages, last.tool_call_id), content: petText(last.content) };
  }
  if (protocol === "anthropic" && last.role === "user" && Array.isArray(last.content)) {
    const result = last.content.find((block) => block && block.type === "tool_result");
    if (result) {
      return { kind: "tool", name: petToolName(messages, result.tool_use_id), content: petText(result.content) };
    }
  }
  return { kind: "user", text: petText(last.content) };
}

/** `{name, arguments}` の配列を、id・JSON 文字列・anthropic 用 input にそろえる。 */
function petToolSpecs(specs) {
  return specs.map((entry) => {
    const name = entry && typeof entry.name === "string" ? entry.name : "unknown_tool";
    const argumentsJson =
      entry && typeof entry.arguments === "string" ? entry.arguments : JSON.stringify((entry && entry.arguments) ?? {});
    let input = {};
    try {
      input = JSON.parse(argumentsJson);
    } catch {
      input = {};
    }
    petCallSeq += 1;
    return { id: `call_${petCallSeq}`, name, arguments: argumentsJson, input };
  });
}

function petOpenAiReply(body, content, toolCalls, finishReason) {
  return {
    id: `chatcmpl-stub-${nextId("x")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "stub-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  };
}

function petAnthropicReply(body, blocks, stopReason) {
  return {
    id: `msg_stub_${nextId("x")}`,
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : "stub-model",
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
  };
}

/** 最後のメッセージから、この返事を決める。 */
function petDecide(body, protocol) {
  const step = petLastStep(body, protocol);
  if (step.kind === "tool") {
    return { kind: "text", text: `ツール結果(${step.name}): ${Array.from(step.content).slice(0, 300).join("")}` };
  }
  const text = step.kind === "user" ? step.text : "";
  const tool = /^#tool\s+(\S+)\s*([\s\S]*)$/.exec(text);
  if (tool) {
    const args = tool[2].trim().length > 0 ? tool[2].trim() : "{}";
    return { kind: "tools", tools: petToolSpecs([{ name: tool[1], arguments: args }]) };
  }
  const tools = /^#tools\s+([\s\S]*)$/.exec(text);
  if (tools) {
    try {
      const parsed = JSON.parse(tools[1]);
      if (Array.isArray(parsed)) return { kind: "tools", tools: petToolSpecs(parsed) };
    } catch {
      // JSON でない `#tools` は普通の文として返す。
    }
  }
  const slow = /^#slow\s+(\d+)\s*([\s\S]*)$/.exec(text);
  if (slow) return { kind: "slow", waitMs: Number(slow[1]), text: slow[2] };
  const error = /^#error\s+(\d{3})$/.exec(text);
  if (error) return { kind: "error", status: Number(error[1]) };
  return { kind: "text", text: `了解: ${text}` };
}

/** `/pet/*` を処理する。処理したら true。 */
async function handlePet(req, res, url, body) {
  const { pathname, searchParams } = url;
  if (pathname === "/pet/__last") {
    const key = searchParams.get("key");
    if (key === null || key.length === 0) {
      sendJson(res, 400, { ok: false, error: "key_required" });
      return true;
    }
    sendJson(res, 200, petLastRequests.get(key) ?? null);
    return true;
  }

  const isOpenAiChat = pathname === "/pet/openai/chat/completions";
  const isAnthropicChat = pathname === "/pet/anthropic/messages";
  const isOpenAiModels = pathname === "/pet/openai/models";
  const isAnthropicModels = pathname === "/pet/anthropic/models";
  if (!isOpenAiChat && !isAnthropicChat && !isOpenAiModels && !isAnthropicModels) return false;

  let parsed = {};
  try {
    parsed = body.length > 0 ? JSON.parse(body) : {};
  } catch {
    parsed = {};
  }
  const key = petApiKey(req.headers);
  petLastRequests.set(key, { path: pathname, headers: req.headers, body: parsed });
  if (petLastRequests.size > MAX_PET_LAST_REQUESTS) {
    const oldest = petLastRequests.keys().next().value;
    if (oldest !== undefined) petLastRequests.delete(oldest);
  }

  if (key === "bad-key") {
    sendJson(res, 401, { error: { message: "Incorrect API key provided: bad-key" } });
    return true;
  }

  if (isOpenAiModels) {
    sendJson(res, 200, { data: [{ id: "stub-mini" }, { id: "stub-large" }, { id: "stub-vision" }] });
    return true;
  }
  if (isAnthropicModels) {
    sendJson(res, 200, { data: [{ id: "stub-claude", display_name: "Stub Claude" }], has_more: false });
    return true;
  }

  const protocol = isAnthropicChat ? "anthropic" : "openai";
  const decision = petDecide(parsed, protocol);

  if (decision.kind === "error") {
    sendJson(res, decision.status, { error: { message: `bad request for key ${key}` } });
    return true;
  }
  if (decision.kind === "slow") {
    await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
    sendJson(
      res,
      200,
      protocol === "anthropic"
        ? petAnthropicReply(parsed, [{ type: "text", text: decision.text }], "end_turn")
        : petOpenAiReply(parsed, decision.text, null, "stop"),
    );
    return true;
  }
  if (decision.kind === "tools") {
    if (protocol === "anthropic") {
      sendJson(
        res,
        200,
        petAnthropicReply(
          parsed,
          decision.tools.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
          "tool_use",
        ),
      );
    } else {
      sendJson(
        res,
        200,
        petOpenAiReply(
          parsed,
          null,
          decision.tools.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
          "tool_calls",
        ),
      );
    }
    return true;
  }
  sendJson(
    res,
    200,
    protocol === "anthropic"
      ? petAnthropicReply(parsed, [{ type: "text", text: decision.text }], "end_turn")
      : petOpenAiReply(parsed, decision.text, null, "stop"),
  );
  return true;
}

async function handle(req, res, url, body) {
  const { pathname, searchParams } = url;
  const method = req.method ?? "GET";
  const contentType = String(req.headers["content-type"] ?? "");

  // ---- 制御 ----
  if (pathname === "/__health") {
    sendJson(res, 200, { ok: true, service: "e2e-stub", requests: requests.length });
    return;
  }
  if (pathname === "/__reset") {
    // ペットの `__last` はキーごとに一意なので消さない（並列 worker の read を消さない）。
    requests.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/__requests") {
    sendJson(res, 200, { ok: true, requests });
    return;
  }

  // ---- アップロード結果（スタブ自身が配信。実 CDN への GET を防ぐ） ----
  if (pathname.startsWith("/files/") && method === "GET") {
    sendBinary(res, 200, "image/png", STUB_IMAGE_PNG);
    return;
  }

  // ---- Catbox ----
  if (pathname === "/user/api.php" || pathname === "/catbox/user/api.php") {
    const reqtype = searchParams.get("reqtype") ?? (body.includes("reqtype=fileupload") ? "fileupload" : "");
    if (reqtype === "deletefiles" || reqtype === "delete") {
      sendText(res, 200, "OK");
      return;
    }
    if (reqtype === "albumcreate") {
      sendText(res, 200, `https://catbox.moe/c/${nextId("e2ealbum")}`);
      return;
    }
    const result = catboxUpload(body, contentType);
    sendText(res, result.status, result.body);
    return;
  }

  // ---- Cloudinary ----
  if (pathname.startsWith("/v1_1/")) {
    const parts = pathname.split("/").filter(Boolean);
    // /v1_1/<cloud>/<resource>/<action>
    const cloudName = parts[1] ?? "e2e-cloud";
    const resourceType = parts[2] ?? "image";
    const action = parts[3] ?? "upload";
    if (action === "destroy") {
      sendJson(res, 200, { result: "ok" });
      return;
    }
    if (action === "upload") {
      sendJson(res, 200, cloudinaryUpload(cloudName, resourceType));
      return;
    }
  }

  // ---- Turnstile ----
  if (pathname === "/turnstile/v0/siteverify" || pathname === "/siteverify") {
    const token = formField(body, "response");
    const now = Date.now();
    // 期限切れ（本物は 300 秒）の記録は捨てる。トークンは 1 回だけ通す。
    for (const [key, at] of consumedTurnstileTokens) {
      if (now - at > TURNSTILE_TOKEN_TTL_MS) consumedTurnstileTokens.delete(key);
    }
    const rejected = token === "" || /fail|invalid|timeout/i.test(token);
    let success = !rejected;
    let errorCodes = rejected ? ["invalid-input-response"] : undefined;
    if (success && !ALWAYS_OK_TURNSTILE_TOKENS.has(token)) {
      if (consumedTurnstileTokens.has(token)) {
        // 本物と同じ: 使用済みトークンの再送は timeout-or-duplicate。
        success = false;
        errorCodes = ["timeout-or-duplicate"];
      } else {
        consumedTurnstileTokens.set(token, now);
      }
    }
    sendJson(res, 200, {
      success,
      ...(success ? {} : { "error-codes": errorCodes }),
      challenge_ts: new Date().toISOString(),
      hostname: "127.0.0.1",
      action: "e2e",
      cdata: "",
    });
    return;
  }

  // ---- GitHub OAuth / API ----
  if (pathname === "/login/oauth/access_token") {
    sendJson(res, 200, {
      access_token: "gho_e2e_dummy_token",
      token_type: "bearer",
      scope: "gist public_repo",
    });
    return;
  }
  if (pathname === "/api/v3/login/oauth/access_token") {
    sendJson(res, 200, {
      access_token: "gho_e2e_dummy_token",
      token_type: "bearer",
      scope: "gist public_repo",
    });
    return;
  }

  // GitHub API は /user などの実 API パスと /api/v3/user の両方を受ける。
  const ghPath = pathname.replace(/^\/api\/v3/, "");
  if (ghPath === "/user" && method === "GET") {
    sendJson(res, 200, githubUser());
    return;
  }
  if (ghPath === "/user/repos" && method === "GET") {
    sendJson(res, 200, [
      {
        id: 1001,
        name: "e2e-repo",
        full_name: "e2e-user/e2e-repo",
        private: false,
        html_url: "https://github.com/e2e-user/e2e-repo",
        default_branch: "main",
        permissions: { admin: true, push: true, pull: true },
      },
    ]);
    return;
  }
  if (ghPath === "/rate_limit" && method === "GET") {
    sendJson(res, 200, githubRateLimit());
    return;
  }
  if (ghPath === "/gists" && method === "POST") {
    sendJson(res, 201, githubGist(nextId("gist")));
    return;
  }
  const gistMatch = /^\/gists\/([^/]+)$/.exec(ghPath);
  if (gistMatch) {
    const id = gistMatch[1];
    if (method === "GET") {
      sendJson(res, 200, githubGist(id));
      return;
    }
    if (method === "PATCH") {
      sendJson(res, 200, githubGist(id));
      return;
    }
    if (method === "DELETE") {
      res.writeHead(204, { ...CORS_HEADERS });
      res.end();
      return;
    }
  }
  const contentMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(ghPath);
  if (contentMatch && (method === "PUT" || method === "GET")) {
    const [, owner, repo, filePath] = contentMatch;
    const content = Buffer.from(body || `// ${filePath}\n`).toString("base64");
    sendJson(res, method === "PUT" ? 201 : 200, {
      name: filePath.split("/").pop(),
      path: filePath,
      sha: "e2e-sha",
      size: body.length,
      content,
      encoding: "base64",
      html_url: `https://github.com/${owner}/${repo}/blob/main/${filePath}`,
      commit: { sha: "e2e-commit-sha" },
    });
    return;
  }
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(ghPath);
  if (repoMatch && method === "GET") {
    const [, owner, repo] = repoMatch;
    sendJson(res, 200, {
      id: 1001,
      name: repo,
      full_name: `${owner}/${repo}`,
      private: false,
      default_branch: "main",
      html_url: `https://github.com/${owner}/${repo}`,
      permissions: { admin: true, push: true, pull: true },
    });
    return;
  }

  // ---- AI ペット中継 ----
  if (pathname.startsWith("/pet/")) {
    if (await handlePet(req, res, url, body)) return;
    sendJson(res, 404, { ok: false, error: "stub_not_found", method, path: pathname });
    return;
  }

  // ---- フォールバック ----
  sendJson(res, 404, {
    ok: false,
    error: "stub_not_found",
    method,
    path: pathname,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS_HEADERS });
    res.end();
    return;
  }

  let body = "";
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { ok: false, error: "payload_too_large" });
    return;
  }

  if (!url.pathname.startsWith("/__")) {
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      headers: req.headers,
      body: body.slice(0, 4096),
      at: Date.now(),
    });
    if (requests.length > MAX_LOG) requests.splice(0, requests.length - MAX_LOG);
  }

  try {
    await handle(req, res, url, body);
  } catch (error) {
    console.error("[e2e-stub] handler error", error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "stub_internal" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e-stub] listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}