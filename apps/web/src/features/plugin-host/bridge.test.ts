// ホストブリッジの権限判定・RPC ディスパッチ・sandbox 生成のユニットテスト（WP3 受入条件④⑤）。

import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_RPC_PERMISSIONS,
  normalizeManifest,
  type PluginManifest,
  type PluginPermission,
} from "shared";
import { authorizeRpc, createRpcDispatcher, sanitizeDraftPatch, type GithubConsentRequest } from "./bridge";
import { pluginApi, PluginApiError } from "./api";
import { buildSandboxCsp, PLUGIN_IFRAME_SANDBOX } from "./csp";
import { buildPluginSrcdoc, escapeHtmlText } from "./bootstrap";
import { applyAllPostRenderRules, applyPostRenderRules, escapeHtml } from "./render-rules";
import type { RpcHostContext } from "./bridge";

function manifest(permissions: PluginPermission[]): PluginManifest {
  return normalizeManifest({
    name: "test-plugin",
    version: "1.0.0",
    summary: "テスト",
    scope: ["personal"],
    permissions,
    connectAllowlist: permissions.includes("net:fetch") ? ["https://api.example.com"] : [],
    slots: permissions.includes("ui:slot") ? ["thread-head"] : [],
    threadState: permissions.includes("storage:thread")
      ? [{ key: "main", kind: "tally" as const, who: "anyone" as const }]
      : [],
  });
}

function dispatcher(permissions: PluginPermission[], overrides?: RpcHostContext["overrides"]) {
  const calls: string[] = [];
  const ctx: RpcHostContext = {
    pluginId: "plugin-1",
    version: "1.0.0",
    manifest: manifest(permissions),
    permissions,
    scope: "personal",
    preview: true,
    overrides,
    handlers: {
      onResize: (height) => calls.push(`resize:${height}`),
      onTitle: (title) => calls.push(`title:${title}`),
      onNotify: (message, level) => calls.push(`notify:${level}:${message}`),
      onLog: (args) => calls.push(`log:${args.join(",")}`),
      onEventSubscribe: (topics) => calls.push(`subscribe:${topics.join(",")}`),
    },
  };
  return { dispatch: createRpcDispatcher(ctx), calls };
}

describe("authorizeRpc: manifest 権限の全種", () => {
  it("権限不要メソッドは未宣言でも許可される", () => {
    for (const [method, permission] of Object.entries(PLUGIN_RPC_PERMISSIONS)) {
      if (permission !== null) continue;
      expect(authorizeRpc([], method)).toEqual({ allowed: true, permission: null });
    }
  });

  it("権限が必要なメソッドは宣言時のみ許可される", () => {
    for (const [method, permission] of Object.entries(PLUGIN_RPC_PERMISSIONS)) {
      if (permission === null) continue;
      const denied = authorizeRpc([], method);
      expect(denied.allowed, `${method} は権限なしで拒否される`).toBe(false);
      if (denied.allowed) throw new Error("unreachable");
      expect(denied.reason).toContain(permission);

      const allowed = authorizeRpc([permission as PluginPermission], method);
      expect(allowed.allowed, `${method} は ${permission} 宣言時に許可される`).toBe(true);
    }
  });

  it("未知メソッドは拒否する", () => {
    expect(authorizeRpc([...PLUGIN_PERMISSIONS], "system.exec")).toMatchObject({ allowed: false });
    expect(authorizeRpc([...PLUGIN_PERMISSIONS], "__proto__")).toMatchObject({ allowed: false });
    expect(authorizeRpc([...PLUGIN_PERMISSIONS], "constructor")).toMatchObject({ allowed: false });
  });

  it("ui.resize / log / handshake は無条件で許可（権限不要）", () => {
    for (const method of ["ui.resize", "ui.setTitle", "log", "handshake"]) {
      expect(authorizeRpc([], method).allowed).toBe(true);
    }
  });
});

describe("RPC ディスパッチャ", () => {
  it("handshake に応答する", async () => {
    const { dispatch } = dispatcher([]);
    const response = await dispatch({ v: 1, id: 1, method: "handshake", params: { nonce: "n" } });
    expect(response).toMatchObject({ v: 1, id: 1, ok: true });
  });

  it("未宣言権限の呼び出しは PERMISSION_DENIED", async () => {
    const { dispatch } = dispatcher([]);
    const response = await dispatch({ v: 1, id: 2, method: "net.fetch", params: { url: "https://api.example.com" } });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("PERMISSION_DENIED");
      expect(response.error.message).toContain("net:fetch");
    }
  });

  it("未知メソッドは PERMISSION_DENIED（unauthorized）", async () => {
    const { dispatch } = dispatcher([...PLUGIN_PERMISSIONS]);
    const response = await dispatch({ v: 1, id: 3, method: "document.cookie" });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("PERMISSION_DENIED");
  });

  it("ui.resize / notify / log をハンドラへ中継する", async () => {
    const { dispatch, calls } = dispatcher(["notify"]);
    await dispatch({ v: 1, id: 4, method: "ui.resize", params: { height: 120 } });
    await dispatch({ v: 1, id: 5, method: "notify", params: { message: "こんにちは", level: "warn" } });
    await dispatch({ v: 1, id: 6, method: "log", params: { args: ["a", 1] } });
    expect(calls).toContain("resize:120");
    expect(calls).toContain("notify:warn:こんにちは");
    expect(calls).toContain("log:a");
  });

  it("notify は 10 秒に 5 件まで（超えた分は捨てて RATE_LIMITED）", async () => {
    const { dispatch, calls } = dispatcher(["notify"]);
    for (let index = 0; index < 5; index += 1) {
      const response = await dispatch({ v: 1, id: 50 + index, method: "notify", params: { message: `m${index}` } });
      expect(response.ok).toBe(true);
    }
    const blocked = await dispatch({ v: 1, id: 56, method: "notify", params: { message: "over" } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("RATE_LIMITED");
    expect(calls.filter((call) => call.startsWith("notify:"))).toHaveLength(5);
    expect(calls).not.toContain("notify:info:over");
  });

  it("upload.start はホストのアップローダ結果を返す", async () => {
    let opened = 0;
    const dispatch = createRpcDispatcher({
      pluginId: "plugin-1",
      version: "1.0.0",
      manifest: manifest(["upload:start"]),
      permissions: ["upload:start"],
      scope: "personal",
      handlers: {
        onUploadRequest: async () => {
          opened += 1;
          return { started: true, url: "https://files.example/upload.png" };
        },
      },
    });
    const response = await dispatch({ v: 1, id: 21, method: "upload.start", params: {} });
    expect(response).toMatchObject({
      ok: true,
      result: { started: true, url: "https://files.example/upload.png" },
    });
    expect(opened).toBe(1);
  });

  it("ai.complete は同意が無ければ外部送信せず、同意後のみ API へ中継する", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ ok: true, data: { text: "AI 応答", model: "m" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const base = {
        pluginId: "plugin-1",
        version: "1.0.0",
        manifest: manifest(["ai:complete"]),
        permissions: ["ai:complete"] as PluginPermission[],
        scope: "personal" as const,
        threadId: 7,
      };
      const noHandler = createRpcDispatcher({ ...base, handlers: {} });
      const missing = await noHandler({ v: 1, id: 22, method: "ai.complete", params: { prompt: "hi" } });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("CONSENT_REQUIRED");
      expect(requests).toHaveLength(0);

      const denied = createRpcDispatcher({ ...base, handlers: { onAiConsent: async () => false } });
      const refused = await denied({ v: 1, id: 23, method: "ai.complete", params: { prompt: "hi" } });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("CONSENT_DENIED");
      expect(requests).toHaveLength(0);

      const allowed = createRpcDispatcher({ ...base, handlers: { onAiConsent: async () => true } });
      const ok = await allowed({ v: 1, id: 24, method: "ai.complete", params: { prompt: "hi" } });
      expect(ok).toMatchObject({ ok: true, result: { text: "AI 応答", model: "m" } });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain("/ai/complete");
      expect(requests[0]!.body).toMatchObject({
        pluginId: "plugin-1",
        version: "1.0.0",
        scope: "personal",
        threadId: 7,
        prompt: "hi",
        consent: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("github.gist は同意が無ければ書き込まず、拒否は CANCELED、同意後のみ表示した値で送る", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(JSON.stringify({ ok: true, data: { id: "g1", htmlUrl: "https://gist.example/g1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const base = {
        pluginId: "plugin-1",
        version: "1.0.0",
        manifest: manifest(["github:gist"]),
        permissions: ["github:gist"] as PluginPermission[],
        scope: "personal" as const,
        preview: false,
      };
      const noHandler = createRpcDispatcher({ ...base, handlers: {} });
      const missing = await noHandler({
        v: 1,
        id: 40,
        method: "github.gist",
        params: { filename: "a.txt", content: "hello", public: false },
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("CONSENT_REQUIRED");
      expect(requests).toHaveLength(0);

      const seen: GithubConsentRequest[] = [];
      let allow = false;
      const withHandler = createRpcDispatcher({
        ...base,
        handlers: {
          onGithubConsent: async (request) => {
            seen.push(request);
            return allow;
          },
        },
      });
      const refused = await withHandler({
        v: 1,
        id: 41,
        method: "github.gist",
        params: { filename: "a.txt", content: "hello", public: false },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("CANCELED");
      expect(requests).toHaveLength(0);
      expect(seen[0]).toMatchObject({
        pluginName: "test-plugin",
        kind: "gist",
        payload: { filename: "a.txt", content: "hello", public: false },
      });
      // 窓に出した内容は、送信前に差し替えられない
      expect(Object.isFrozen(seen[0]!.payload)).toBe(true);

      allow = true;
      const gist = await withHandler({
        v: 1,
        id: 42,
        method: "github.gist",
        params: { filename: "a.txt", content: "hello", public: false },
      });
      expect(gist).toMatchObject({ ok: true, result: { id: "g1" } });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain("/github/files/gists");
      expect(requests[0]!.method).toBe("POST");
      // 表示した filename / content / public がそのまま送られる
      expect(requests[0]!.body).toMatchObject({
        public: false,
        files: { "a.txt": { content: "hello" } },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("github.repo も同意が無ければ書き込まず、同意後のみ表示した値で送る", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(JSON.stringify({ ok: true, data: { htmlUrl: "https://github.com/o/r/blob/main/p.js" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const base = {
        pluginId: "plugin-1",
        version: "1.0.0",
        manifest: manifest(["github:repo"]),
        permissions: ["github:repo"] as PluginPermission[],
        scope: "personal" as const,
        preview: false,
      };
      const noHandler = createRpcDispatcher({ ...base, handlers: {} });
      const missing = await noHandler({
        v: 1,
        id: 43,
        method: "github.repo",
        params: { owner: "o", repo: "r", path: "p.js", content: "code" },
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("CONSENT_REQUIRED");
      expect(requests).toHaveLength(0);

      const seen: GithubConsentRequest[] = [];
      let allow = false;
      const withHandler = createRpcDispatcher({
        ...base,
        handlers: {
          onGithubConsent: async (request) => {
            seen.push(request);
            return allow;
          },
        },
      });
      const refused = await withHandler({
        v: 1,
        id: 44,
        method: "github.repo",
        params: { owner: "o", repo: "r", path: "p.js", content: "code" },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("CANCELED");
      expect(requests).toHaveLength(0);
      expect(seen[0]).toMatchObject({
        pluginName: "test-plugin",
        kind: "repo",
        payload: { owner: "o", repo: "r", path: "p.js", content: "code" },
      });
      expect(Object.isFrozen(seen[0]!.payload)).toBe(true);

      allow = true;
      const pushed = await withHandler({
        v: 1,
        id: 45,
        method: "github.repo",
        params: { owner: "o", repo: "r", path: "p.js", content: "code", message: "更新" },
      });
      expect(pushed.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain("/github/files/repo/o/r/content");
      expect(requests[0]!.method).toBe("PUT");
      expect(requests[0]!.body).toMatchObject({ path: "p.js", content: "code", message: "更新" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("プレビューでは storage がメモリ内で完結する", async () => {
    const { dispatch } = dispatcher(["storage:shared"]);
    const set = await dispatch({ v: 1, id: 7, method: "storage.set", params: { key: "k", value: "v" } });
    expect(set.ok).toBe(true);
    const get = await dispatch({ v: 1, id: 8, method: "storage.get", params: { key: "k" } });
    expect(get).toMatchObject({ ok: true, result: "v" });
    const list = await dispatch({ v: 1, id: 9, method: "storage.list", params: {} });
    expect(list).toMatchObject({ ok: true, result: { k: "v" } });
    const removed = await dispatch({ v: 1, id: 10, method: "storage.delete", params: { key: "k" } });
    expect(removed.ok).toBe(true);
    const empty = await dispatch({ v: 1, id: 11, method: "storage.get", params: { key: "k" } });
    expect(empty).toMatchObject({ ok: true, result: null });
  });

  it("プレビューでは外部通信・投稿・GitHub を拒否する", async () => {
    const permissions: PluginPermission[] = ["net:fetch", "data:write:post", "github:gist"];
    const { dispatch } = dispatcher(permissions);
    const net = await dispatch({ v: 1, id: 12, method: "net.fetch", params: { url: "https://api.example.com/x" } });
    expect(net.ok).toBe(false);
    if (!net.ok) expect(net.error.code).toBe("PREVIEW");
    const post = await dispatch({ v: 1, id: 13, method: "data.post.create", params: { body: "x" } });
    expect(post.ok).toBe(false);
    const gist = await dispatch({ v: 1, id: 14, method: "github.gist", params: { filename: "a", content: "b" } });
    expect(gist.ok).toBe(false);
  });

  it("overrides が指定メソッドを差し替える", async () => {
    const { dispatch } = dispatcher(["data:read:thread"], {
      "data.thread.get": async () => ({ id: 42, title: "sample" }),
    });
    const response = await dispatch({ v: 1, id: 15, method: "data.thread.get", params: {} });
    expect(response).toMatchObject({ ok: true, result: { id: 42, title: "sample" } });
  });

  it("data.post.create はホストの確認が無ければ投稿しない", async () => {
    const context: RpcHostContext = {
      pluginId: "plugin-1",
      version: "1.0.0",
      manifest: manifest(["data:write:post"]),
      permissions: ["data:write:post"],
      scope: "personal",
      boardId: 7,
      threadId: 3,
      handlers: {},
    };
    const response = await createRpcDispatcher(context)({
      v: 1,
      id: 20,
      method: "data.post.create",
      params: { name: "!1d6", body: "x" },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("CONFIRM_REQUIRED");
  });

  it("data.post.create は確認後にだけ、ホストが得たトークンを付けて投稿する", async () => {
    const post = vi.spyOn(pluginApi, "createPost").mockResolvedValue({ postId: 1, num: 2 });
    try {
      const confirmations: Array<{ attempt: number; name: string; body: string }> = [];
      const context: RpcHostContext = {
        pluginId: "plugin-1",
        version: "1.0.0",
        manifest: manifest(["data:write:post"]),
        permissions: ["data:write:post"],
        scope: "personal",
        boardId: 7,
        boardSlug: "b-7",
        threadId: 3,
        handlers: {
          onPostConfirm: async (request) => {
            confirmations.push({ attempt: request.attempt, name: request.name, body: request.body });
            return { confirmed: true, turnstileToken: "tok-1" };
          },
        },
      };
      const response = await createRpcDispatcher(context)({
        v: 1,
        id: 21,
        method: "data.post.create",
        params: { name: "!2d6", body: "サイコロ" },
      });
      expect(response.ok).toBe(true);
      expect(confirmations).toEqual([{ attempt: 1, name: "!2d6", body: "サイコロ" }]);
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ boardId: 7, threadId: 3, name: "!2d6", body: "サイコロ" }),
        "tok-1",
      );

      // 拒否されたら投稿しない。
      post.mockClear();
      const denied = createRpcDispatcher({
        ...context,
        handlers: { onPostConfirm: async () => ({ confirmed: false }) },
      });
      const rejected = await denied({ v: 1, id: 22, method: "data.post.create", params: { body: "x" } });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("CANCELED");
      expect(post).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
    }
  });

  it("Turnstile で落ちたときだけ、確認をやり直して 1 回再送する", async () => {
    const post = vi
      .spyOn(pluginApi, "createPost")
      .mockRejectedValueOnce(new PluginApiError(400, "TURNSTILE_FAILED", "Turnstile トークンが必要です"))
      .mockResolvedValueOnce({ postId: 2, num: 3 });
    try {
      const attempts: Array<number | undefined> = [];
      const context: RpcHostContext = {
        pluginId: "plugin-1",
        version: "1.0.0",
        manifest: manifest(["data:write:post"]),
        permissions: ["data:write:post"],
        scope: "personal",
        boardId: 7,
        handlers: {
          onPostConfirm: async (request) => {
            attempts.push(request.attempt);
            return { confirmed: true, turnstileToken: `tok-${request.attempt}` };
          },
        },
      };
      const response = await createRpcDispatcher(context)({
        v: 1,
        id: 23,
        method: "data.post.create",
        params: { body: "x" },
      });
      expect(response.ok).toBe(true);
      expect(attempts).toEqual([1, 2]);
      expect(post).toHaveBeenNthCalledWith(2, expect.anything(), "tok-2");
    } finally {
      post.mockRestore();
    }
  });
});

describe("sandbox の不変条件", () => {
  it("iframe sandbox は allow-scripts のみ（allow-same-origin なし）", () => {
    expect(PLUGIN_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(PLUGIN_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("CSP は全禁止・connect-src 'none'", () => {
    const csp = buildSandboxCsp(manifest([]));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("api.example.com");
  });

  it("net:fetch 宣言時のみ allowlist が img-src に入る（connect-src は常に none）", () => {
    const csp = buildSandboxCsp(manifest(["net:fetch"]));
    expect(csp).toContain("img-src data: blob: https://api.example.com");
    expect(csp).toContain("connect-src 'none'");
  });

  it("srcdoc はプラグインコードを textarea(RCDATA) にエスケープ埋込する", () => {
    const code = `if (a && b) { document.write("</script><script>alert(1)</script>"); }`;
    const srcdoc = buildPluginSrcdoc({ manifest: manifest([]), code, csp: buildSandboxCsp(manifest([])) });
    // コードは <textarea> 内（実体参照がデコードされる RCDATA）に置く。
    // script raw text では `&&` 等が復元されずプラグインが構文エラーになるため使わない。
    expect(srcdoc).toContain('<textarea id="oc-plugin-code" hidden readonly>');
    expect(srcdoc).toContain("&lt;/script&gt;");
    expect(srcdoc).toContain("&amp;&amp;");
    expect(srcdoc).not.toContain("</script><script>alert(1)");
    // 実際の script タグはブートストラップの 1 つだけ
    expect(srcdoc.split("<script").length - 1).toBe(1);
    expect(escapeHtmlText("<&>")).toBe("&lt;&amp;&gt;");
    // エスケープは code を 1 文字も落とさない（ブラウザ側で原文に戻る）
    const embedded = srcdoc.slice(
      srcdoc.indexOf('<textarea id="oc-plugin-code" hidden readonly>') +
        '<textarea id="oc-plugin-code" hidden readonly>'.length,
      srcdoc.indexOf("</textarea>"),
    );
    expect(
      embedded
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    ).toBe(code);
  });
});

describe("sanitizeDraftPatch", () => {
  it("文字列フィールドのみ通し、cancel を解釈する", () => {
    expect(sanitizeDraftPatch({ body: "変更後", cancel: true, evil: 1 })).toEqual({
      body: "変更後",
      cancel: true,
    });
    expect(sanitizeDraftPatch({ body: 123, name: null })).toEqual({});
    expect(sanitizeDraftPatch("文字列")).toBeNull();
    expect(sanitizeDraftPatch(null)).toBeNull();
  });
});

describe("宣言的レンダー規則", () => {
  const spoiler = {
    pattern: "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]",
    flags: "g",
    template: "$1",
    kind: "spoiler" as const,
  };

  it("キャプチャを安全な span に変換する", () => {
    const result = applyPostRenderRules("[spoiler]秘密[/spoiler]", [spoiler]);
    expect(result.matched).toBe(true);
    expect(result.html).toBe(
      '<span class="oc-plugin-render oc-plugin-render-spoiler" data-plugin-rule="1">秘密</span>',
    );
  });

  it("本文・テンプレート・キャプチャの HTML をエスケープする（XSS 不可）", () => {
    const rule = {
      pattern: "\\[b\\]([\\s\\S]*?)\\[/b\\]",
      flags: "g",
      template: "<b>$1</b>",
      kind: "text" as const,
    };
    const result = applyPostRenderRules("[b]<img src=x onerror=alert(1)>[/b]", [rule]);
    expect(result.html).not.toContain("<img");
    expect(result.html).not.toContain("<b>");
    expect(result.html).toContain("&lt;b&gt;");
    expect(result.html).toContain("&lt;img");
  });

  it("不正な正規表現は無視し、元テキストをエスケープして返す", () => {
    const result = applyPostRenderRules("<script>x</script>", [
      { pattern: "([", flags: "g", template: "$1", kind: "text" },
    ]);
    expect(result.matched).toBe(false);
    expect(result.html).toBe("&lt;script&gt;x&lt;/script&gt;");
  });

  it("複数プラグインの規則を順に適用する", () => {
    const dice = { pattern: "1d6", flags: "g", template: "🎲", kind: "dice" as const };
    const result = applyAllPostRenderRules("1d6 と [spoiler]x[/spoiler]", [[dice], [spoiler]]);
    expect(result.html).toContain("oc-plugin-render-dice");
    expect(result.html).toContain("oc-plugin-render-spoiler");
  });

  it("escapeHtml は 5 文字を実体参照にする", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});