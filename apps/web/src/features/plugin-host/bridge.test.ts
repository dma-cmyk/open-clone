// ホストブリッジの権限判定・RPC ディスパッチ・sandbox 生成のユニットテスト（WP3 受入条件④⑤）。

import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_RPC_PERMISSIONS,
  normalizeManifest,
  type PluginManifest,
  type PluginPermission,
} from "shared";
import { authorizeRpc, createRpcDispatcher, sanitizeDraftPatch } from "./bridge";
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