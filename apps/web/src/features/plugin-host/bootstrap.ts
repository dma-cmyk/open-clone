// iframe 内で最初に実行されるブートストラップ。
// - postMessage RPC クライアント（plugin → host）
// - ホストからの init / invoke / event / beforePost / kill の処理
// - プラグインコード（HTML エスケープされた text/plain）を Blob URL で実行
// 依存を持たない素の JavaScript 文字列として iframe の srcdoc に埋め込む。

export const PLUGIN_BOOTSTRAP_SCRIPT = String.raw`(function () {
  'use strict';
  var V = 1;
  var pending = new Map();
  var seq = 0;
  var definition = null;
  var config = null;
  var api = null;
  var started = false;
  var killed = false;
  var renderGeneration = 0;

  function post(message) { parent.postMessage(message, '*'); }

  function makeError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function call(method, params) {
    if (killed) return Promise.reject(makeError('KILLED', 'プラグインは停止されました'));
    var id = ++seq;
    var deferred = Promise.withResolvers();
    var timer = setTimeout(function () {
      if (pending.has(id)) {
        pending.delete(id);
        deferred.reject(makeError('TIMEOUT', 'RPC タイムアウト: ' + method));
      }
    }, 15000);
    pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timer: timer });
    post({ v: V, id: id, method: method, params: params });
    return deferred.promise;
  }

  function makeApi(cfg) {
    return {
      plugin: { id: cfg.pluginId, version: cfg.version, manifest: cfg.manifest },
      context: cfg.context,
      permissions: cfg.permissions || [],
      ui: {
        resize: function (height) { return call('ui.resize', { height: height }); },
        setTitle: function (title) { return call('ui.setTitle', { title: title }); }
      },
      data: {
        thread: function (threadId) { return call('data.thread.get', { threadId: threadId }); },
        board: function (target) { return call('data.board.get', target || {}); },
        posts: function (threadId) { return call('data.posts.list', { threadId: threadId }); },
        createPost: function (draft) { return call('data.post.create', draft); }
      },
      storage: {
        get: function (key) { return call('storage.get', { key: key }); },
        set: function (key, value) { return call('storage.set', { key: key, value: value }); },
        delete: function (key) { return call('storage.delete', { key: key }); },
        list: function () { return call('storage.list', {}); }
      },
      net: { fetch: function (input) { return call('net.fetch', input); } },
      upload: { start: function (options) { return call('upload.start', options || {}); } },
      github: {
        createGist: function (input) { return call('github.gist', input); },
        pushFile: function (input) { return call('github.repo', input); }
      },
      events: {
        subscribe: function (topics) { return call('events.subscribe', { topics: topics }); }
      },
      notify: {
        show: function (message, options) {
          return call('notify', { message: message, level: (options && options.level) || 'info' });
        }
      },
      ai: {
        complete: function (prompt, options) { return call('ai.complete', { prompt: prompt, options: options || {} }); }
      },
      log: function () {
        var args = Array.prototype.slice.call(arguments).map(function (value) {
          try { return typeof value === 'string' ? value : JSON.stringify(value); }
          catch (error) { return String(value); }
        });
        return call('log', { args: args });
      }
    };
  }

  function root() { return document.getElementById('root'); }

  function measure() {
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0,
      1
    );
    call('ui.resize', { height: height }).catch(function () {});
  }

  function showError(message) {
    var el = root();
    if (el) el.textContent = 'プラグインエラー: ' + message;
    measure();
  }

  function renderSlot(params) {
    var el = root();
    if (!el) return;
    // 再描画（データ更新・再マウント）で内容が重複しないよう、毎回まっさらな
    // コンテナを渡す。非同期ハンドラの遅延 append は切り離された旧コンテナへ向かう。
    var generation = ++renderGeneration;
    el.textContent = '';
    var handler = definition && definition.slots && definition.slots[params.slot];
    if (!handler) { measure(); return; }
    var container = document.createElement('div');
    container.setAttribute('data-oc-slot-view', String(generation));
    el.appendChild(container);
    try {
      var result = handler({ slot: params.slot, data: params.data, api: api, root: container });
      Promise.resolve(result)
        .then(function (value) {
          if (generation !== renderGeneration) return;
          if (typeof value === 'string') el.innerHTML = value;
          measure();
        })
        .catch(function (error) {
          if (generation !== renderGeneration) return;
          showError(String((error && error.message) || error));
        });
    } catch (error) {
      showError(String((error && error.message) || error));
    }
  }

  function emitEvent(params) {
    var handler = definition && definition.events && definition.events[params.type];
    if (!handler) return;
    try { handler(params.event, api); } catch (error) { console.error('event handler failed', error); }
  }

  function handleBeforePost(data) {
    var hook = definition && definition.hooks && definition.hooks.beforePost;
    if (!hook) { post({ v: V, id: data.id, ok: true, result: null }); return; }
    Promise.resolve()
      .then(function () { return hook(data.params && data.params.draft, api); })
      .then(function (result) { post({ v: V, id: data.id, ok: true, result: result || null }); })
      .catch(function (error) {
        post({
          v: V,
          id: data.id,
          ok: false,
          error: { code: 'HOOK_ERROR', message: String((error && error.message) || error) }
        });
      });
  }

  function start() {
    if (started || !definition || !config) return;
    started = true;
    api = makeApi(config);
    globalThis.plugin = api;
    try {
      var result = definition.activate ? definition.activate(api) : null;
      Promise.resolve(result).catch(function (error) { console.error('activate failed', error); });
    } catch (error) {
      console.error('activate failed', error);
    }
  }

  globalThis.register = function (def) {
    if (killed) return;
    definition = def || {};
    start();
  };

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== V) return;

    if (typeof data.ok === 'boolean' && data.id !== undefined && data.id !== null) {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.result);
      else {
        entry.reject(makeError(
          (data.error && data.error.code) || 'RPC_ERROR',
          (data.error && data.error.message) || 'RPC エラー'
        ));
      }
      return;
    }

    if (data.method === 'init') {
      config = data.params;
      if (config && config.nonce) call('handshake', { nonce: config.nonce }).catch(function () {});
      start();
      return;
    }
    if (data.method === 'invoke') { renderSlot(data.params); return; }
    if (data.method === 'event') { emitEvent(data.params); return; }
    if (data.method === 'beforePost' && data.id !== undefined) { handleBeforePost(data); return; }
    if (data.method === 'kill') {
      killed = true;
      try {
        if (definition && definition.onKill) {
          definition.onKill((data.params && data.params.reason) || 'stopped');
        }
      } catch (error) { /* ignore */ }
      pending.forEach(function (item) {
        clearTimeout(item.timer);
        item.reject(makeError('KILLED', 'プラグインは停止されました'));
      });
      pending.clear();
      var el = root();
      if (el) el.textContent = '';
    }
  });

  var codeElement = document.getElementById('oc-plugin-code');
  if (codeElement) {
    // <textarea> の value は実体参照がデコード済みの原文（script raw text では復元できない）
    var source = ('value' in codeElement ? codeElement.value : codeElement.textContent) || '';
    var blob = new Blob([source], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    var script = document.createElement('script');
    script.src = url;
    script.onload = function () { URL.revokeObjectURL(url); };
    script.onerror = function () {
      URL.revokeObjectURL(url);
      showError('コードの読み込みに失敗しました');
    };
    document.body.appendChild(script);
  }
})();`;

/** サンドボックスの文書（srcdoc）を組み立てる。 */
export function buildPluginSrcdoc(options: {
  manifest: { permissions: readonly string[]; connectAllowlist: readonly string[] };
  code: string;
  csp: string;
}): string {
  const escapedCode = escapeHtmlText(options.code);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${options.csp}">
<meta name="referrer" content="no-referrer">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; color: inherit;
    font-family: inherit; font-size: 13px; line-height: 1.5; overflow: hidden; }
  #root { width: 100%; }
  a { color: #228811; }
  .oc-spoiler { background: #333; color: #333; border-radius: 2px; padding: 0 2px; }
  .oc-spoiler:hover, .oc-spoiler:focus { color: #fff; background: #444; }
</style>
</head>
<body>
<div id="root"></div>
<textarea id="oc-plugin-code" hidden readonly>${escapedCode}</textarea>
<script>${PLUGIN_BOOTSTRAP_SCRIPT}</script>
</body>
</html>`;
}

/**
 * コード埋め込み用のエスケープ。
 * `<textarea>` は RCDATA なので実体参照がデコードされ、`&`・`<`・`>` を含む
 * 任意の JavaScript が原文どおり復元される（`</textarea>` もテキストとして安全）。
 * `<script type="text/plain">` は raw text で実体参照がデコードされないため使わない。
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}