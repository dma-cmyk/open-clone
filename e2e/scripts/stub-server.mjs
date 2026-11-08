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

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

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
    const decoded = token;
    const success = decoded !== "" && !/fail|invalid|timeout/i.test(decoded);
    sendJson(res, 200, {
      success,
      ...(success ? {} : { "error-codes": ["invalid-input-response"] }),
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