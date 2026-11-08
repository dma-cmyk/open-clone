// gallery — スレ内の画像 URL をサムネイル表示するサンプル。
register({
  slots: {
    "thread-head": async function ({ data, api, root }) {
      var threadId = (data && data.threadId) || (api.context && api.context.threadId);
      if (!threadId) return;
      var response = await api.data.posts(threadId);
      // API は { items: [...] } を返す（配列を直接返す実装にも耐える）
      var posts = (response && response.items) || (Array.isArray(response) ? response : []);
      var pattern = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"'<>]*)?/gi;
      var urls = [];
      for (var i = 0; i < posts.length; i++) {
        var found = String(posts[i].body || '').match(pattern);
        if (found) urls = urls.concat(found);
      }
      urls = urls.slice(0, 12);
      if (urls.length === 0) {
        root.textContent = '';
        return;
      }

      var box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 0;align-items:flex-start;';
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
});
