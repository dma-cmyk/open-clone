// dice — レスごとにサイコロを振るサンプル。
register({
  slots: {
    "thread-post-footer": function ({ data, api, root }) {
      var post = (data && data.post) || {};
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;';

      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = '🎲 1d6';
      button.style.cssText = 'font-size:12px;padding:1px 8px;cursor:pointer;';

      var output = document.createElement('span');
      output.textContent = '';

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
      return undefined;
    }
  }
});
