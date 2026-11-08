// gist-embed — レス内の Gist URL を取得してコードブロック表示するサンプル。
register({
  slots: {
    "thread-post-inline": async function ({ data, api, root }) {
      var post = (data && data.post) || {};
      var match = String(post.body || '').match(/https:\/\/gist\.github\.com\/[^\s/]+\/([0-9a-f]{5,40})/i);
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
        if (names.length === 0) {
          box.textContent = 'Gist にファイルがありません';
          return;
        }
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
});
