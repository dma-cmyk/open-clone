// サイトフッタ。
export function SiteFooter() {
  return (
    <footer className="oc-footer">
      <a href="#top" className="oc-sp-totop">
        トップへ戻る
      </a>
      <div className="oc-footer-links">
        <a href="/">板一覧</a>
        <a href="/plugins">プラグイン</a>
        <a href="/api/v1/compat">専ブラ互換</a>
        <a href="/settings">設定</a>
        <a href="/admin">運営</a>
      </div>
      <p>
        おーぷんクローン — AI運営型・匿名掲示板。投稿は各投稿者の責任で行われます。既存サービスとは無関係の独立サイトです。
      </p>
      <p className="oc-tiny">
        ロゴ・アイコン・CSS はすべて本サイト独自のものです。トリップのキーに他サービスのパスワードを使わないでください。
      </p>
    </footer>
  );
}