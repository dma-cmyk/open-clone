"use client";

// 管理者・所有者向けヘルプ。`/help/admin/`。節アンカーは設計50（追加依頼）で固定。
// 本文の数値・挙動はすべて実装から確認したものだけを書く（出典は報告書61の一覧）。
import { usePageTitle } from "@/lib/title";
import { useEffect, type ReactNode } from "react";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="oc-panel" style={{ scrollMarginTop: 56 }}>
      {/* M01: 外観は .oc-panel-title のまま、見出し要素（h2）で意味付けする */}
      <h2 className="oc-panel-title" style={{ margin: 0 }}>
        <span>{title}</span>
      </h2>
      <div className="oc-panel-inner oc-stack" style={{ gap: 6 }}>
        {children}
      </div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0 }}>{children}</p>;
}

const TOC: Array<{ id: string; label: string }> = [
  { id: "roles", label: "管理者の種類と権限の一覧" },
  { id: "board-staff", label: "板の管理（設定・スタッフ・通報・削除・アク禁・プラグイン）" },
  { id: "site-admin", label: "サイト運営の管理画面の各タブ" },
  { id: "owner", label: "所有者だけの操作" },
  { id: "plugin-review", label: "プラグイン審査" },
  { id: "ai", label: "AI 管理（登録・権限上限・承認キュー・緊急停止・MCP）" },
  { id: "security", label: "二段階認証・再認証・リカバリーコード・パスワードを忘れたとき" },
];

export function HelpAdminView() {
  usePageTitle("管理者ヘルプ");

  // 直リンク（/help/admin/#roles など）で開いたとき、マウント後に該当節へスクロールする。
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const target = document.getElementById(hash);
    if (target) target.scrollIntoView();
  }, []);

  return (
    <div className="oc-stack">
      <div className="oc-panel">
        <h1 className="oc-panel-title" style={{ margin: 0 }}>
          <span>管理者・所有者向けヘルプ</span>
        </h1>
        <div className="oc-panel-inner oc-stack" style={{ gap: 6 }}>
          <P>
            サイト運営（所有者・特別管理人）と板のスタッフ（管理人・副管理人・モデレーター）向けの説明です。
            一般の利用者向けは <a href="/help/">ヘルプ</a> をご覧ください。管理画面は <a href="/admin">/admin</a>、
            板の管理は <code>/b/板スラッグ/manage</code> です。
          </P>
          <nav aria-label="管理者ヘルプ目次">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {TOC.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>

      <Section id="roles" title="管理者の種類と権限の一覧">
        <P>
          <b>サイト運営</b>は2種類です。<b>所有者（owner）</b>: サイト設定の変更・特別管理人の招待/停止/復帰などすべて。
          <b>特別管理人（special_admin）</b>: 所有者専用の操作を除くサイト運営全般。
          なお<b>サイト設定の画面は特別管理人も参照できます</b>（編集と保存は所有者のみ）。
        </P>
        <P>
          <b>板のスタッフ</b>は3段階で、できる操作が違います。<b>管理人（admin）</b>: 板設定・ルール・デザインの変更、
          スタッフ任命・解任、板へのプラグイン導入など板の運営全般。<b>副管理人（deputy）</b>: 通報の処理と
          レスの非表示/復帰・<b>削除</b>はできますが、<b>板設定の変更・スタッフ任命・板へのプラグイン導入はできません</b>。
          <b>モデレーター（moderator）</b>: 通報の処理とレスの<b>非表示/復帰</b>ができます（削除・設定変更・任命は不可）。
        </P>
        <P>
          板の管理画面（<code>/b/板スラッグ/manage</code>）はスタッフ全員が開けますが、権限の無い操作は
          サーバー側で拒否されます（例: モデレーターと副管理人は通報一覧を見られても設定変更は403、
          副管理人のスタッフ任命も403）。板ページの「板管理」リンクが出るのは canManage（板の管理人またはサイト運営）だけです。
        </P>
      </Section>

      <Section id="board-staff" title="板の管理（設定・スタッフ・通報・削除・アク禁・プラグイン）">
        <P>
          板の管理（<code>/b/板スラッグ/manage</code>）のタブは7つ: <b>基本設定</b>（板名・カテゴリ・説明・連投制限0〜3600秒・
          Turnstile と確認を省略する時間（0〜1440分、既定30・0で毎回）・実況・画像/つぶやき許可・ID非表示・レス上限10〜1000・NGワード200語まで・
          レスとスレの本人編集／本人削除／引用スレの許可（既定はすべて許可）と本人が編集・削除できる時間（分、既定0＝無制限））、<b>ルール</b>、<b>デザイン</b>
          （テーマ色・アクセント色・バナー）、<b>スタッフ</b>（任命・解任）、<b>プラグイン</b>（板への導入と停止。
          <b>導入は管理人のみ</b>、板内の停止は板スタッフなら可能）、
          <b>AI管理者</b>（その板のAIエージェント登録と権限上限）、<b>通報</b>（対応）。
          板設定・ルール・デザインの変更とスタッフ任命は<b>管理人（またはサイト運営）のみ</b>で、副管理人・モデレーターは拒否されます。
        </P>
        <P>
          <b>通報対応</b>: 却下・対応済みのほか、非表示（モデレーター以上）・削除（副管理人以上/サイト運営）を選べます。
          レスを直接削除する操作も副管理人以上です。削除は取り消せません。
        </P>
        <P>
          <b>アクセス禁止（アク禁）</b>は2系統あります。
          ①<b>板のアクセス禁止</b>（API: <code>/v1/boards/&lt;slug&gt;/bans</code>）: 端末（device）・IP・アカウントの3種を
          板単位（site=true でサイト全体）で設定できます。権限は板単位ならモデレーター以上、サイト全体は owner / 特別管理人。
          <b>現在は管理画面にこの設定UIはなく、API 経由の操作です</b>（一覧の取得もAPI）。
          ②<b>サイト運営の規制画面</b>（/admin/suspensions）: 対象は<b>アカウントID・メールアドレス・端末ハッシュ</b>の3つで、
          サイト全体または板IDを指定します（IPの入力欄はありません）。作成・解除・削除はTOTPの再認証が必要です。
        </P>
      </Section>

      <Section id="site-admin" title="サイト運営の管理画面の各タブ">
        <P>
          <a href="/admin">/admin</a> のメニュー: <b>ダッシュボード</b>、<b>招待管理</b>（所有者のみ表示）、
          <b>特別管理人</b>（所有者のみ表示）、<b>ユーザー</b>、<b>板一覧</b>、<b>規制</b>（アク禁の一覧と解除）、
          <b>監査ログ</b>、<b>サイト設定</b>（<b>所有者は編集、特別管理人は参照のみ</b>）、<b>使用量</b>、<b>AI管理</b>、
          <b>AI承認キュー</b>、<b>通報</b>、<b>プラグイン管理</b>。
        </P>
        <P>
          操作の前に<b>TOTPの再認証（ステップアップ）</b>が求められるのは: 規制の作成・解除・削除、
          サイト設定の変更、特別管理人の停止/復帰/TOTPリセット、招待キーの<b>発行</b>です。
          招待の<b>一覧表示と失効</b>は所有者権限だけで使え、再認証は不要です。
        </P>
      </Section>

      <Section id="owner" title="所有者だけの操作">
        <P>
          所有者（owner）だけが使える操作: <b>サイト設定の変更</b>（site_config。板数の上限など。特別管理人は参照のみ）、
          <b>特別管理人の招待キー発行・停止・復帰・TOTPリセット</b>、<b>招待管理</b>（招待の一覧表示と失効も所有者のみ）。
          このうち<b>サイト設定の変更、特別管理人の停止/復帰/TOTPリセット、招待キーの発行</b>はTOTPの再認証が必要です
          （招待の一覧表示と失効は再認証不要）。
        </P>
        <P>
          特別管理人の招待はキーを発行して相手に渡し、相手が表示名・メール・パスワード・TOTPコードを送って就任します。
          所有者アカウントの初期作成は <code>/admin/owner/setup/</code> から1度だけ行います（作成後は409）。
        </P>
      </Section>

      <Section id="plugin-review" title="プラグイン審査">
        <P>
          公開申請のあったプラグインの審査は<b>所有者と特別管理人</b>が行えます（/plugins の審査キュー）。
          静的検査の結果（リスクスコア・禁止表現）とコードを確認して承認/却下します。
          サイト全体（siteスコープ）への導入もサイト運営の承認が必要です。
        </P>
      </Section>

      <Section id="ai" title="AI 管理（登録・権限上限・承認キュー・緊急停止・MCP）">
        <P>
          <b>AI管理者</b>は板ごと・サイト全体で登録でき、操作の<b>権限上限（risk_cap）</b>（low / medium / high）を設定します。
          操作ごとのリスクは low（閲覧・検索・監視など。自分自身の停止や自分の承認待ち取下げなど権限を増やさない操作も含む）／
          medium（投稿など可逆・限定付き）／ high（不可逆・全体影響）に分類されています。
        </P>
        <P>
          実行のされ方は次のとおりです。<b>low 操作</b>: 通常は自動実行。<b>medium 操作</b>: 権限上限が low のAIは
          自動実行されず<b>人の承認キュー</b>に入り、承認されれば実行されます（上限が medium 以上なら設定どおり自動またはキュー）。
          <b>high 操作</b>: 権限上限が high のAIだけが要求でき、<b>常に人の承認キュー</b>に入ります。
          上限が high 未満のAIの high 操作は<b>拒否（deny）</b>されます。板のポリシーで deny に設定された操作も拒否されます。
        </P>
        <P>
          <b>承認キュー</b>（/admin/ai/queue）で medium/high の操作を承認・却下します。
          <b>緊急停止</b>はAI管理画面の「全AIを緊急停止」で即座に止められ、解除はサイト管理者のみです。
        </P>
        <P>
          <b>MCP接続</b>: 外部のAIエージェント（Claude Code / Codex / OMP など）から <code>/mcp</code> エンドポイントで
          掲示板を操作できます。すべての呼び出しはRESTと同じ政策エンジンを通り、権限上限と承認キューが適用されます。
          接続方法は docs/mcp.md を参照してください。
        </P>
      </Section>

      <Section id="security" title="二段階認証・再認証・リカバリーコード・パスワードを忘れたとき">
        <P>
          <b>TOTP二段階認証</b>: アカウント画面の「TOTP二段階認証」から登録します（6桁・30秒ごと）。
          連続5回失敗で15分ロックされます。高リスク操作の前にはTOTPの再認証（ステップアップ）が求められます。
        </P>
        <P>
          <b>リカバリーコード</b>: TOTP登録時に10個発行されます。TOTP端末を失ったときは
          <b>メール＋パスワード＋リカバリーコード</b>で復旧できます（復旧後はTOTPの再登録が必要）。
          コードの再発行も再認証必須です。
        </P>
        <P>
          <b>パスワードを忘れたとき</b>: 現状、<b>自分で再設定する機能はありません</b>（メール送信の仕組みが無いため）。
          パスワードもリカバリーコードも使えない場合、復旧は<b>サイト運営側（所有者）によるデータベース操作などの
          運営作業</b>が必要になります。サイト内に手順画面や既存の文書手順は用意されていません。
          パスワードは <code>pbkdf2-sha256$反復回数$salt$hash</code> の形式（PBKDF2-SHA256・10万回）で保存されます。
        </P>
      </Section>
    </div>
  );
}
