-- 0612: 公式プラグインサンプルの seed（レビュー B14/B8）。
-- examples/plugins/ の spoiler / dice / gallery / gist-embed を「公開・承認済み」の
-- レジストリ登録として投入し、ログインしていない匿名ユーザーでも導入できる公開プラグインを確保する。
--
-- 冪等・非破壊:
--  * すべて NOT EXISTS で「同じ name の plugins 行が無いときだけ」挿入する。
--    本番に同名プラグイン（ユーザー作成の spoiler など）がある場合は何も書かず、既存行を壊さない。
--  * 2 回適用しても NOT EXISTS が効くため 2 重登録されない。
--
-- 所有者・審査記録の整合:
--  * owner_account_id = NULL（公式提供。UI は "(サイト)" 表示）。アカウント行は作らない
--    （accounts への FK 参照を作らないため、他テーブルのクリーンアップを壊さない）
--  * plugin_versions.status = 'approved'（公開済み版として配信）・created_by = NULL
--  * plugin_reviews に scope='site', scope_ref='', status='approved', reviewer_type='system' の
--    承認行を残す（site 導入には承認済み review が必要なため）。reviewer_id = NULL

-- spoiler（存在しないときだけ登録）
INSERT INTO plugins (
  id, owner_account_id, name, summary, description, manifest_json, scopes,
  status, visibility, latest_version, source, source_ref,
  install_count, report_count, flagged, license, kill_seq,
  created_at, updated_at, published_at
)
SELECT '01OFFICIALPLUGINSEED0000000001', NULL, 'spoiler', 'レス内の [spoiler]〜[/spoiler] をクリックで開くネタバレ表示にする',
  '宣言的レンダー規則のみで動作するサンプル。JavaScript は実行しません。', '{"name":"spoiler","version":"1.0.0","summary":"レス内の [spoiler]〜[/spoiler] をクリックで開くネタバレ表示にする","description":"宣言的レンダー規則のみで動作するサンプル。JavaScript は実行しません。","scope":["personal","board","site"],"permissions":[],"connectAllowlist":[],"entry":"plugin.js","slots":[],"hooks":[],"render":{"post":[{"pattern":"\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]","flags":"g","template":"$1","kind":"spoiler"}]},"author":"open-clone","license":"MIT"}', ',board,personal,site,',
  'published', 'public', '1.0.0', 'local', NULL,
  0, 0, 0, 'MIT', 0,
  1760000000, 1760000000, 1760000000
WHERE NOT EXISTS (SELECT 1 FROM plugins WHERE name = 'spoiler');

INSERT INTO plugin_versions (
  plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at
)
SELECT '01OFFICIALPLUGINSEED0000000001', '1.0.0', '// spoiler — 宣言的レンダー規則のみで動くプラグイン。
// 表示変換は manifest.render.post をホストが実行するため、JS は何もしない。
// （コードは必須のため空登録だけ行う）
register({});', 'bef69f1ada0671c75cf3528aa079ff14cdf0e3ab41c23e34a6b938175a484801',
  '{"name":"spoiler","version":"1.0.0","summary":"レス内の [spoiler]〜[/spoiler] をクリックで開くネタバレ表示にする","description":"宣言的レンダー規則のみで動作するサンプル。JavaScript は実行しません。","scope":["personal","board","site"],"permissions":[],"connectAllowlist":[],"entry":"plugin.js","slots":[],"hooks":[],"render":{"post":[{"pattern":"\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]","flags":"g","template":"$1","kind":"spoiler"}]},"author":"open-clone","license":"MIT"}', 'official sample seed', 'approved', NULL, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000001')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_versions WHERE plugin_id = '01OFFICIALPLUGINSEED0000000001' AND version = '1.0.0'
  );

INSERT INTO plugin_reviews (
  id, plugin_id, version, scope, scope_ref, status, reviewer_type, reviewer_id, note,
  static_result_json, risk_level, created_at, decided_at
)
SELECT 'official-review-spoiler', '01OFFICIALPLUGINSEED0000000001', '1.0.0',
  'site', '', 'approved', 'system', NULL,
  '公式サンプルの初期 seed（1.0.0）',
  '{"allowed":true,"reasons":[],"riskScore":0}',
  'low', 1760000000, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000001')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_reviews
    WHERE plugin_id = '01OFFICIALPLUGINSEED0000000001' AND version = '1.0.0' AND scope = 'site'
  );

-- dice（存在しないときだけ登録）
INSERT INTO plugins (
  id, owner_account_id, name, summary, description, manifest_json, scopes,
  status, visibility, latest_version, source, source_ref,
  install_count, report_count, flagged, license, kill_seq,
  created_at, updated_at, published_at
)
SELECT '01OFFICIALPLUGINSEED0000000002', NULL, 'dice', 'レスごとに 1d6 / 2d10 などのサイコロを振れるボタンを追加',
  'スロット UI と乱数（crypto）のサンプル。スレッド表示のレス下にボタンを出します。', '{"name":"dice","version":"1.0.0","summary":"レスごとに 1d6 / 2d10 などのサイコロを振れるボタンを追加","description":"スロット UI と乱数（crypto）のサンプル。スレッド表示のレス下にボタンを出します。","scope":["personal","board","site"],"permissions":["ui:slot"],"connectAllowlist":[],"entry":"plugin.js","slots":["thread-post-footer"],"hooks":[],"author":"open-clone","license":"MIT"}', ',board,personal,site,',
  'published', 'public', '1.0.0', 'local', NULL,
  0, 0, 0, 'MIT', 0,
  1760000000, 1760000000, 1760000000
WHERE NOT EXISTS (SELECT 1 FROM plugins WHERE name = 'dice');

INSERT INTO plugin_versions (
  plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at
)
SELECT '01OFFICIALPLUGINSEED0000000002', '1.0.0', '// dice — レスごとにサイコロを振るサンプル。
register({
  slots: {
    "thread-post-footer": function ({ data, api, root }) {
      var post = (data && data.post) || {};
      var wrap = document.createElement(''div'');
      wrap.style.cssText = ''display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;'';

      var button = document.createElement(''button'');
      button.type = ''button'';
      button.textContent = ''🎲 1d6'';
      button.style.cssText = ''font-size:12px;padding:1px 8px;cursor:pointer;'';

      var output = document.createElement(''span'');
      output.textContent = '''';

      button.addEventListener(''click'', function () {
        var buffer = new Uint32Array(1);
        crypto.getRandomValues(buffer);
        var value = (buffer[0] % 6) + 1;
        output.textContent = ''→ '' + value + (value === 6 ? '' ✨'' : '''');
        api.ui.resize(Math.max(document.documentElement.scrollHeight, 1));
      });

      wrap.appendChild(button);
      wrap.appendChild(output);
      root.appendChild(wrap);
      return undefined;
    }
  }
});', '1f7b796c0215a78da81c0d047a589ce54907700063556f7b7848b6be3b5f399f',
  '{"name":"dice","version":"1.0.0","summary":"レスごとに 1d6 / 2d10 などのサイコロを振れるボタンを追加","description":"スロット UI と乱数（crypto）のサンプル。スレッド表示のレス下にボタンを出します。","scope":["personal","board","site"],"permissions":["ui:slot"],"connectAllowlist":[],"entry":"plugin.js","slots":["thread-post-footer"],"hooks":[],"author":"open-clone","license":"MIT"}', 'official sample seed', 'approved', NULL, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000002')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_versions WHERE plugin_id = '01OFFICIALPLUGINSEED0000000002' AND version = '1.0.0'
  );

INSERT INTO plugin_reviews (
  id, plugin_id, version, scope, scope_ref, status, reviewer_type, reviewer_id, note,
  static_result_json, risk_level, created_at, decided_at
)
SELECT 'official-review-dice', '01OFFICIALPLUGINSEED0000000002', '1.0.0',
  'site', '', 'approved', 'system', NULL,
  '公式サンプルの初期 seed（1.0.0）',
  '{"allowed":true,"reasons":[],"riskScore":0}',
  'low', 1760000000, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000002')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_reviews
    WHERE plugin_id = '01OFFICIALPLUGINSEED0000000002' AND version = '1.0.0' AND scope = 'site'
  );

-- gallery（存在しないときだけ登録）
INSERT INTO plugins (
  id, owner_account_id, name, summary, description, manifest_json, scopes,
  status, visibility, latest_version, source, source_ref,
  install_count, report_count, flagged, license, kill_seq,
  created_at, updated_at, published_at
)
SELECT '01OFFICIALPLUGINSEED0000000003', NULL, 'gallery', 'スレ内の画像 URL をサムネイル一覧で表示する',
  'data:read:thread でレスを取得し、画像 URL をギャラリー表示します。外部画像は net:fetch の allowlist で許可したホストのみ読み込みます。', '{"name":"gallery","version":"1.0.0","summary":"スレ内の画像 URL をサムネイル一覧で表示する","description":"data:read:thread でレスを取得し、画像 URL をギャラリー表示します。外部画像は net:fetch の allowlist で許可したホストのみ読み込みます。","scope":["personal","board","site"],"permissions":["ui:slot","data:read:thread","net:fetch"],"connectAllowlist":["https://files.catbox.moe"],"entry":"plugin.js","slots":["thread-head"],"hooks":[],"author":"open-clone","license":"MIT"}', ',board,personal,site,',
  'published', 'public', '1.0.0', 'local', NULL,
  0, 0, 0, 'MIT', 0,
  1760000000, 1760000000, 1760000000
WHERE NOT EXISTS (SELECT 1 FROM plugins WHERE name = 'gallery');

INSERT INTO plugin_versions (
  plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at
)
SELECT '01OFFICIALPLUGINSEED0000000003', '1.0.0', '// gallery — スレ内の画像 URL をサムネイル表示するサンプル。
register({
  slots: {
    "thread-head": async function ({ data, api, root }) {
      var threadId = (data && data.threadId) || (api.context && api.context.threadId);
      if (!threadId) return;
      var response = await api.data.posts(threadId);
      // API は { items: [...] } を返す（配列を直接返す実装にも耐える）
      var posts = (response && response.items) || (Array.isArray(response) ? response : []);
      var pattern = /https?:\/\/[^\s"''<>]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"''<>]*)?/gi;
      var urls = [];
      for (var i = 0; i < posts.length; i++) {
        var found = String(posts[i].body || '''').match(pattern);
        if (found) urls = urls.concat(found);
      }
      urls = urls.slice(0, 12);
      if (urls.length === 0) {
        root.textContent = '''';
        return;
      }

      var box = document.createElement(''div'');
      box.style.cssText = ''display:flex;flex-wrap:wrap;gap:6px;padding:4px 0;align-items:flex-start;'';
      var title = document.createElement(''div'');
      title.textContent = ''🖼 画像 '' + urls.length + '' 件'';
      title.style.cssText = ''width:100%;font-size:12px;color:#555;'';
      box.appendChild(title);

      urls.forEach(function (url) {
        var link = document.createElement(''a'');
        link.href = url;
        link.target = ''_blank'';
        link.rel = ''noopener noreferrer'';
        link.style.cssText = ''display:block;width:96px;height:72px;border:1px solid #ccc;border-radius:4px;overflow:hidden;background:#f4f4f4;'';
        var image = document.createElement(''img'');
        image.src = url;
        image.loading = ''lazy'';
        image.referrerPolicy = ''no-referrer'';
        image.style.cssText = ''width:100%;height:100%;object-fit:cover;'';
        image.addEventListener(''error'', function () {
          link.textContent = ''画像を開く'';
          link.style.fontSize = ''11px'';
        });
        link.appendChild(image);
        box.appendChild(link);
      });

      root.appendChild(box);
    }
  }
});', 'e82cbd4ea3518df096a7a74faa0be874b738202701afbe24b8cf66dddaf4f67b',
  '{"name":"gallery","version":"1.0.0","summary":"スレ内の画像 URL をサムネイル一覧で表示する","description":"data:read:thread でレスを取得し、画像 URL をギャラリー表示します。外部画像は net:fetch の allowlist で許可したホストのみ読み込みます。","scope":["personal","board","site"],"permissions":["ui:slot","data:read:thread","net:fetch"],"connectAllowlist":["https://files.catbox.moe"],"entry":"plugin.js","slots":["thread-head"],"hooks":[],"author":"open-clone","license":"MIT"}', 'official sample seed', 'approved', NULL, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000003')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_versions WHERE plugin_id = '01OFFICIALPLUGINSEED0000000003' AND version = '1.0.0'
  );

INSERT INTO plugin_reviews (
  id, plugin_id, version, scope, scope_ref, status, reviewer_type, reviewer_id, note,
  static_result_json, risk_level, created_at, decided_at
)
SELECT 'official-review-gallery', '01OFFICIALPLUGINSEED0000000003', '1.0.0',
  'site', '', 'approved', 'system', NULL,
  '公式サンプルの初期 seed（1.0.0）',
  '{"allowed":true,"reasons":[],"riskScore":0}',
  'low', 1760000000, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000003')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_reviews
    WHERE plugin_id = '01OFFICIALPLUGINSEED0000000003' AND version = '1.0.0' AND scope = 'site'
  );

-- gist-embed（存在しないときだけ登録）
INSERT INTO plugins (
  id, owner_account_id, name, summary, description, manifest_json, scopes,
  status, visibility, latest_version, source, source_ref,
  install_count, report_count, flagged, license, kill_seq,
  created_at, updated_at, published_at
)
SELECT '01OFFICIALPLUGINSEED0000000004', NULL, 'gist-embed', 'レスに貼られた Gist URL を取得してコード表示する',
  'net:fetch プロキシのサンプル。manifest の connectAllowlist に api.github.com だけを許可します。', '{"name":"gist-embed","version":"1.0.0","summary":"レスに貼られた Gist URL を取得してコード表示する","description":"net:fetch プロキシのサンプル。manifest の connectAllowlist に api.github.com だけを許可します。","scope":["personal","board","site"],"permissions":["ui:slot","net:fetch"],"connectAllowlist":["https://api.github.com"],"entry":"plugin.js","slots":["thread-post-inline"],"hooks":[],"author":"open-clone","license":"MIT"}', ',board,personal,site,',
  'published', 'public', '1.0.0', 'local', NULL,
  0, 0, 0, 'MIT', 0,
  1760000000, 1760000000, 1760000000
WHERE NOT EXISTS (SELECT 1 FROM plugins WHERE name = 'gist-embed');

INSERT INTO plugin_versions (
  plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at
)
SELECT '01OFFICIALPLUGINSEED0000000004', '1.0.0', '// gist-embed — レス内の Gist URL を取得してコードブロック表示するサンプル。
register({
  slots: {
    "thread-post-inline": async function ({ data, api, root }) {
      var post = (data && data.post) || {};
      var match = String(post.body || '''').match(/https:\/\/gist\.github\.com\/[^\s/]+\/([0-9a-f]{5,40})/i);
      if (!match) return;

      var box = document.createElement(''div'');
      box.style.cssText = ''border:1px solid #ddd;border-radius:4px;padding:6px;margin-top:4px;background:#f7f7f7;'';
      box.textContent = ''Gist を読み込み中… ('' + match[1] + '')'';
      root.appendChild(box);

      try {
        var response = await api.net.fetch({ url: ''https://api.github.com/gists/'' + encodeURIComponent(match[1]) });
        if (response.status !== 200) {
          box.textContent = ''Gist の取得に失敗しました（HTTP '' + response.status + ''）'';
          return;
        }
        var gist = JSON.parse(response.body);
        var names = Object.keys(gist.files || {});
        if (names.length === 0) {
          box.textContent = ''Gist にファイルがありません'';
          return;
        }
        var file = gist.files[names[0]];
        box.textContent = '''';

        var header = document.createElement(''div'');
        header.textContent = names[0] + (gist.description ? '' — '' + gist.description : '''');
        header.style.cssText = ''font-size:12px;color:#555;margin-bottom:4px;'';
        box.appendChild(header);

        var pre = document.createElement(''pre'');
        pre.textContent = String(file.content || '''').slice(0, 4000);
        pre.style.cssText = ''margin:0;font-size:11px;overflow:auto;max-height:220px;background:#fff;padding:6px;border:1px solid #eee;'';
        box.appendChild(pre);
      } catch (error) {
        box.textContent = ''Gist の取得に失敗しました: '' + ((error && error.message) || error);
      }
    }
  }
});', '9b0322c9543161ae7769f3bd9939d80a6cdaf1c8b7e92c5569f488e947977f04',
  '{"name":"gist-embed","version":"1.0.0","summary":"レスに貼られた Gist URL を取得してコード表示する","description":"net:fetch プロキシのサンプル。manifest の connectAllowlist に api.github.com だけを許可します。","scope":["personal","board","site"],"permissions":["ui:slot","net:fetch"],"connectAllowlist":["https://api.github.com"],"entry":"plugin.js","slots":["thread-post-inline"],"hooks":[],"author":"open-clone","license":"MIT"}', 'official sample seed', 'approved', NULL, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000004')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_versions WHERE plugin_id = '01OFFICIALPLUGINSEED0000000004' AND version = '1.0.0'
  );

INSERT INTO plugin_reviews (
  id, plugin_id, version, scope, scope_ref, status, reviewer_type, reviewer_id, note,
  static_result_json, risk_level, created_at, decided_at
)
SELECT 'official-review-gist-embed', '01OFFICIALPLUGINSEED0000000004', '1.0.0',
  'site', '', 'approved', 'system', NULL,
  '公式サンプルの初期 seed（1.0.0）',
  '{"allowed":true,"reasons":[],"riskScore":0}',
  'low', 1760000000, 1760000000
WHERE EXISTS (SELECT 1 FROM plugins WHERE id = '01OFFICIALPLUGINSEED0000000004')
  AND NOT EXISTS (
    SELECT 1 FROM plugin_reviews
    WHERE plugin_id = '01OFFICIALPLUGINSEED0000000004' AND version = '1.0.0' AND scope = 'site'
  );

