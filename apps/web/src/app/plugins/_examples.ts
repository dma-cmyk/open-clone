// エディタの「サンプルを読み込む」用テンプレート。
// examples/plugins/ の公式サンプルと同じ内容。

import type { PluginPostRenderRule, PluginPermission, PluginScope, PluginSlotName } from "shared";

export interface PluginTemplate {
  id: string;
  label: string;
  name: string;
  version: string;
  summary: string;
  description: string;
  scopes: PluginScope[];
  permissions: PluginPermission[];
  connectAllowlist: string[];
  slots: PluginSlotName[];
  render: PluginPostRenderRule[];
  code: string;
}

export const PLUGIN_TEMPLATES: PluginTemplate[] = [
  {
    id: "spoiler",
    label: "スポイラー（宣言的レンダー規則のみ）",
    name: "spoiler",
    version: "1.0.0",
    summary: "レス内の [spoiler]〜[/spoiler] をクリックで開くネタバレ表示にする",
    description: "manifest.render.post だけで動作する最小サンプル。権限は不要です。",
    scopes: ["personal", "board", "site"],
    permissions: [],
    connectAllowlist: [],
    slots: [],
    render: [
      {
        pattern: "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]",
        flags: "g",
        template: "$1",
        kind: "spoiler",
      },
    ],
    code: `// spoiler — manifest.render.post（宣言的レンダー規則）のみで動く。
// 表示変換はホストが実行するため、プラグイン JS は何もしない。
register({});`,
  },
  {
    id: "dice",
    label: "サイコロ（レス下のボタン）",
    name: "dice",
    version: "1.0.0",
    summary: "レスごとに 1d6 のサイコロを振れるボタンを追加",
    description: "スロット UI と crypto 乱数のサンプル。",
    scopes: ["personal", "board", "site"],
    permissions: ["ui:slot"],
    connectAllowlist: [],
    slots: ["thread-post-footer"],
    render: [],
    code: `register({
  slots: {
    "thread-post-footer": function ({ data, api, root }) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;';

      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = '🎲 1d6';
      button.style.cssText = 'font-size:12px;padding:1px 8px;cursor:pointer;';

      var output = document.createElement('span');
      button.addEventListener('click', function () {
        var buffer = new Uint32Array(1);
        crypto.getRandomValues(buffer);
        var value = (buffer[0] % 6) + 1;
        output.textContent = '→ ' + value + (value === 6 ? ' ✨' : '');
        api.ui.resize(Math.max(document.documentElement.scrollHeight, 1));
      });

      wrap.appendChild(button);
      wrap.appendChild(output);
      root.appendChild(wrap);
    }
  }
});`,
  },
  {
    id: "gallery",
    label: "画像ギャラリー（スレ頭）",
    name: "gallery",
    version: "1.0.0",
    summary: "スレ内の画像 URL をサムネイル一覧で表示する",
    description: "data:read:thread でレスを取得して画像 URL を集めます。",
    scopes: ["personal", "board", "site"],
    permissions: ["ui:slot", "data:read:thread", "net:fetch"],
    connectAllowlist: ["https://files.catbox.moe"],
    slots: ["thread-head"],
    render: [],
    code: `register({
  slots: {
    "thread-head": async function ({ data, api, root }) {
      var threadId = (data && data.threadId) || (api.context && api.context.threadId);
      if (!threadId) return;
      var posts = await api.data.posts(threadId);
      var pattern = /https?:\\/\\/[^\\s"'<>]+\\.(?:png|jpe?g|gif|webp)(?:\\?[^\\s"'<>]*)?/gi;
      var urls = [];
      for (var i = 0; i < posts.length; i++) {
        var found = String(posts[i].body || '').match(pattern);
        if (found) urls = urls.concat(found);
      }
      urls = urls.slice(0, 12);
      if (urls.length === 0) { root.textContent = ''; return; }

      var box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 0;';
      var title = document.createElement('div');
      title.textContent = '🖼 画像 ' + urls.length + ' 件';
      title.style.cssText = 'width:100%;font-size:12px;color:#555;';
      box.appendChild(title);

      urls.forEach(function (url) {
        var link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'display:block;width:96px;height:72px;border:1px solid #ccc;border-radius:4px;overflow:hidden;background:#f4f4f4;';
        var image = document.createElement('img');
        image.src = url;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        image.addEventListener('error', function () {
          link.textContent = '画像を開く';
          link.style.fontSize = '11px';
        });
        link.appendChild(image);
        box.appendChild(link);
      });
      root.appendChild(box);
    }
  }
});`,
  },
  {
    id: "gist-embed",
    label: "Gist 埋め込み（net:fetch）",
    name: "gist-embed",
    version: "1.0.0",
    summary: "レスに貼られた Gist URL を取得してコード表示する",
    description: "net:fetch プロキシのサンプル。api.github.com のみ許可します。",
    scopes: ["personal", "board", "site"],
    permissions: ["ui:slot", "net:fetch"],
    connectAllowlist: ["https://api.github.com"],
    slots: ["thread-post-inline"],
    render: [],
    code: `register({
  slots: {
    "thread-post-inline": async function ({ data, api, root }) {
      var post = (data && data.post) || {};
      var match = String(post.body || '').match(/https:\\/\\/gist\\.github\\.com\\/[^\\s/]+\\/([0-9a-f]{5,40})/i);
      if (!match) return;

      var box = document.createElement('div');
      box.style.cssText = 'border:1px solid #ddd;border-radius:4px;padding:6px;margin-top:4px;background:#f7f7f7;';
      box.textContent = 'Gist を読み込み中… (' + match[1] + ')';
      root.appendChild(box);

      try {
        var response = await api.net.fetch({ url: 'https://api.github.com/gists/' + encodeURIComponent(match[1]) });
        if (response.status !== 200) {
          box.textContent = 'Gist の取得に失敗しました（HTTP ' + response.status + '）';
          return;
        }
        var gist = JSON.parse(response.body);
        var names = Object.keys(gist.files || {});
        if (names.length === 0) { box.textContent = 'Gist にファイルがありません'; return; }
        var file = gist.files[names[0]];
        box.textContent = '';

        var header = document.createElement('div');
        header.textContent = names[0] + (gist.description ? ' — ' + gist.description : '');
        header.style.cssText = 'font-size:12px;color:#555;margin-bottom:4px;';
        box.appendChild(header);

        var pre = document.createElement('pre');
        pre.textContent = String(file.content || '').slice(0, 4000);
        pre.style.cssText = 'margin:0;font-size:11px;overflow:auto;max-height:220px;background:#fff;padding:6px;border:1px solid #eee;';
        box.appendChild(pre);
      } catch (error) {
        box.textContent = 'Gist の取得に失敗しました: ' + ((error && error.message) || error);
      }
    }
  }
});`,
  },
];