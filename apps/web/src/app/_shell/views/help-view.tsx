"use client";

// ヘルプ（一般向け）。`/help/`。節アンカーは設計50で固定（#basics … #tour）。
// 本文の数値・挙動はすべて実装から確認したものだけを書く（出典は報告書61の一覧）。
import { usePageTitle } from "@/lib/title";
import { TourList, reserveTourStart } from "@/features/site-tour";
import { useEffect, type ReactNode } from "react";
import {
  PLUGIN_PERMISSION_INFOS,
  PLUGIN_PLACED_SLOTS,
  PLUGIN_RISK_LABEL,
  PLUGIN_RISK_NOTE,
  pluginSlotAliases,
  pluginSlotInfo,
  type PluginRisk,
} from "shared";
import { navigate } from "../router";

/** 危険度の色だけでなく文字（危険度: 中 など）でも示す。 */
const RISK_CLASS: Record<PluginRisk, string> = {
  low: "oc-badge oc-badge-green",
  medium: "oc-badge oc-badge-yellow",
  high: "oc-badge oc-badge-red",
};

const RISK_BORDER: Record<PluginRisk, string> = {
  low: "var(--oc-border)",
  medium: "#d4a017",
  high: "var(--oc-danger)",
};

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
  { id: "basics", label: "掲示板の基本（板・スレ・レス）" },
  { id: "reading", label: "スレの読み方（レス番号・ID・アンカー・画像一覧）" },
  { id: "posting", label: "書き込み方" },
  { id: "board", label: "板の作り方と管理" },
  { id: "tsubuyaki", label: "つぶやき・実況・ブクマ" },
  { id: "account", label: "アカウント（無くてもできること・作るとできること）" },
  { id: "password", label: "パスワードを忘れたとき" },
  { id: "plugins", label: "プラグイン（使う・作る）" },
  { id: "plugin-permissions", label: "プラグインの権限と表示場所" },
  { id: "pet", label: "AI ペット（聞く・やってもらう）" },
  { id: "report", label: "通報・削除依頼・ルール" },
  { id: "admin", label: "管理者の種類（サイト運営と板の管理人）" },
  { id: "faq", label: "よくある質問" },
  { id: "tour", label: "ツアーの始め方" },
];

export function HelpView() {
  usePageTitle("ヘルプ");

  // 直リンク（/help/#posting など）で開いたとき、マウント後に該当節へスクロールする。
  // 静的エクスポートでは本文がマウント後に描画されるため、ブラウザ既定のスクロールは効かない。
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const target = document.getElementById(hash);
    if (target) target.scrollIntoView();
  }, []);

  // トップへ移ってトップのツアーを始める。開始待ち（画面の準備・権限・時間切れ）は
  // 予約を移動先の TourHost が受け取って行う（`pending-start.ts`）。ここでポーリングしない。
  const startTopTour = () => {
    reserveTourStart("home");
    navigate("/");
  };

  return (
    <div className="oc-stack">
      <div className="oc-panel">
        <h1 className="oc-panel-title" style={{ margin: 0 }}>
          <span>ヘルプ（使い方）</span>
        </h1>
        <div className="oc-panel-inner oc-stack" style={{ gap: 6 }}>
          <P>
            はじめての方へ。このページは「おーぷんクローン」の使い方を1枚にまとめたものです。
            下の目次から気になる節へ飛べます。用語（スレ・レス・sage など）は初出の場所で説明します。
          </P>
          <nav aria-label="ヘルプ目次">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {TOC.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <P>
            管理者・所有者の方は <a href="/help/admin/">管理者向けヘルプ</a> もご覧ください。
          </P>
        </div>
      </div>

      <Section id="basics" title="掲示板の基本（板・スレ・レス）">
        <P>
          <b>板</b>は話題の分野ごとの集まり（URL は <code>/b/板スラッグ</code>）、<b>スレ</b>（スレッド）は板の中の話題1つ、
          <b>レス</b>はその中に並ぶ投稿1件ずつのことです。トップ（<a href="/">板一覧</a>）から板に入り、
          スレタイをクリックするとレスが読めます。
        </P>
        <P>
          トップにはカテゴリでの絞り込みと「板を作る」ボタン、サイト内検索の入力欄があります。
          <a href="/ranking">ランキング</a>（勢い・レス数・同時接続）と<a href="/headline">ヘッドライン</a>
          （新着・勢いのあるスレ）もここから開けます。
        </P>
        <P>
          閲覧も書き込みも<b>アカウント無しでできます</b>。7日間まったく投稿のなかった板は自動で削除されます。
        </P>
      </Section>

      <Section id="reading" title="スレの読み方（レス番号・ID・アンカー・画像一覧）">
        <P>
          各レスには<b>レス番号</b>（1, 2, 3…）と<b>表示ID</b>（4文字）が付きます。表示IDは
          <b>板・日付（JST）・投稿元のIP</b>の組み合わせで決まるため、同じ人でも板や日が違えば別のIDになり、
          端末や本人を一意に保証するものではありません（同じIPから同じ板・同じ日に投稿すると同じIDになります）。
          名前欄に <code>名前#キー</code> と書いて投稿すると<b>トリップ</b>（◆＋10文字の記号）が付き、
          本人であることの目印になります（コテハン＝固定ハンドルの代わり）。
        </P>
        <P>
          本文の <code>&gt;&gt;2</code> のような<b>アンカー</b>（安価）はクリックすると引用先のプレビューが出ます。
          「引用」ボタンで自分の投稿に引用を挿入できます。
        </P>
        <P>
          レスの表示範囲は「全部」「1から」「最新50」「最新10」「逆順」で切り替えられます。
          「画像一覧」はスレ内の<b>添付ファイルを並べた一覧（ギャラリー）</b>です。レスが多いスレはページ送りになります。
        </P>
        <P>
          本文の <code>#タグ</code> はハッシュタグとして拾われます（1レス5個・1つ30文字まで）。
          見たくない語・ID・名前・トリップ・スレタイは<a href="/settings">設定</a>の「NG」タブで登録でき、
          「確認（マークして表示）／非表示／完全に無視」の3段階から選べます。レス ID の横の「×」で NG
          にした直後はトーストの「元に戻す」で取り消せ、非表示になったレスやスレの帯にある「NG を解除」「無視をやめる」でも戻せます。
        </P>
        <P>
          スレ一覧の「無視」は<b>そのスレだけ</b>を隠します（タイトルが似た別スレは隠れません）。無視したスレは
          <a href="/settings?tab=ng">設定の「NG」タブ</a>の「無視したスレ」に追加日時つきで並び、スレへのリンクと「解除」ボタンから戻せます。
          以前の「NG スレタイ」は部分一致のまま残ります。「完全に無視」で何も表示されないときは、板・スレの末尾に出る
          「NG で隠れている: n 件」からも設定へ移動できます。
        </P>
      </Section>

      <Section id="posting" title="書き込み方">
        <P>
          板の「スレを立てる」またはスレ下の返信欄から投稿します。名前・メール欄は省略できます。
          入力中の本文は<b>下書きとして端末に自動保存</b>され、再読み込みしても残ります（空にすれば空で保存）。
        </P>
        <P>
          本文の上限は<b>UTF-8 で4096バイト</b>です（日本語は1文字およそ3バイト）。フォームに文字数とバイト数、
          上限超過の警告が出ます。1スレのレス上限は既定で1000件（板ごとに10〜1000で変更可）です。
        </P>
        <P>
          <b>名前欄のコマンド</b>: 名前に <code>!ninja</code>（投稿数に応じた忍法帖Lv）、<code>!random</code>（0〜100の乱数・自動sage）、
          <code>!kuji</code>（おみくじ）、<code>!dama</code>（お年玉）、<code>!AA</code>（等幅表示）を書くと、投稿時にサーバーが名前へ付け足します。
          <code>!2d6</code> のように <code>!個数d面の数</code>（1〜10個・2〜1000面）を書くと、
          サーバーが振った出目が <code>【2d6:3+5=8】</code> の形で名前に付きます（1レス1個まで。1個なら <code>【1d6:4】</code>）。
          出目はサーバーが決めるので、名前欄に手で <code>【2d6:6+6=12】</code> や <code>【大吉】</code> と書いても本物にはなりません
          （名前の側の <code>【】</code> は <code>〔〕</code> に置き換わります）。スレ立て・レス・つぶやきのどこでも同じように働きます。
        </P>
        <P>
          <b>sage</b>（下げ）: チェックするかメール欄に sage と書くと、投稿してもスレが板の<b>新レス順</b>で先頭へ上がりません。
          なお<b>勢い順・レス数順</b>の並びは投稿数などで順位が変わるため、sage でもこれらの順位は動きます。
          盛り上がらせたくない話題のときに使います。
        </P>
        <P>
          <b>添付</b>: 画像・動画・音声・テキスト・PDFなどを付けられます（1回の投稿に10個まで）。
          保存先は板の設定で選べ、既定は Catbox（画像/動画/音声/テキスト/PDF/JSON、95MBまで）、
          他に一時保存の Litterbox、Cloudinary（画像/動画、10MBまで）、Gist / GitHub（テキスト系、1MBまで）があります。
          お絵かきエディタでその場で絵を描いて添付することもできます。
        </P>
        <P>
          <b>ロボット確認</b>（Turnstile）: 板の設定により、未ログイン時または全投稿時に確認が出ます（ふだんは自動で済み、怪しいと判定されたときだけチェックボックスが出ます）。
          未ログイン時だけ確認する板では、一度確認を通るとその板で一定時間（既定30分、板ごとに設定）レスとつぶやきの確認が省略されます。
          スレ立て・通報・添付は毎回確認します。連投・回数制限・アク禁・NGワードに当たると省略は取り消されます。
          板ごとの<b>連投制限</b>（秒）と、短時間の投稿回数制限（投稿3回/30秒・スレ立て2回/5分など）もあります。
        </P>
        <P>
          <b>投票</b>: 本文に <code>[ank:10m:選択肢A,選択肢B]</code> のように書くと投票を作れます
          （期間10秒〜30日、選択肢2〜10個）。投票は<b>1つのIPから1票</b>です（端末Cookieを変えても同じIPなら2票目は入りません）。
        </P>
        <P>
          <b>編集と本人削除</b>: 自分が書いたレス（同じブラウザ、またはログイン中の同じアカウント）は、
          あとから本文を編集したり削除したりできます。編集すると「編集済み」と表示され、編集前の本文は<b>履歴として誰でも見られます</b>。
          削除すると「投稿者により削除されました」と残り、レス番号や引用（&gt;&gt;n）はずれません。
          スレを立てた本人は、スレのタイトルと &gt;&gt;1 の本文の編集、スレの削除もできます（他の人のレスが付いたスレは本人では削除できません）。
          編集にも連投・回数制限・アク禁・ロボット確認が適用されます。できるかどうかと、できる時間は板ごとの設定で決まります。
        </P>
        <P>
          <b>引用スレ</b>: スレの「↗ 引用して新スレ」から、元のスレのカードを先頭に付けた新しいスレを立てられます
          （元のスレの「🔗 引用したスレ」で、引用したスレの一覧を見られます）。レスの中にこのサイトのスレの URL を書くと、
          タイトルとレス数のカードで表示されます。見られない板のスレは中身を出さずに表示されます。
        </P>
      </Section>

      <Section id="board" title="板の作り方と管理">
        <P>
          <a href="/boards/new">板を作る</a>からはアカウントが必要です（1アカウント既定5板まで）。
          板スラッグ（URLの一部）・板名・カテゴリ・説明・ルールのほか、テーマ色やバナー、
          Turnstile の要否と確認を省略する時間・連投制限・実況板にするか・画像/つぶやきの許可・ID非表示・レス上限・NGワード（200語まで）、
          レスとスレの本人編集・本人削除・引用スレの許可と、本人が編集・削除できる時間を設定できます。
          作った人が初代の<b>板管理人</b>になります。
        </P>
        <P>
          板の管理は <code>/b/板スラッグ/manage</code> から行います。タブは
          「基本設定・ルール・デザイン・スタッフ・プラグイン・AI管理者・通報」の7つです。
          スタッフは<b>管理人（admin）／副管理人（deputy）／モデレーター（moderator）</b>の3段階で任命できます。
        </P>
      </Section>

      <Section id="tsubuyaki" title="つぶやき・実況・ブクマ">
        <P>
          <b>つぶやき</b>: スレに紐づく100文字までの短い投稿です。スレ画面の「💬 つぶやき」で重ねて表示でき、
          流れる速さ・文字の大きさ・色は設定で変えられます（板の設定で無効になっている板もあります）。
        </P>
        <P>
          <b>実況</b>: スレ画面の「⚡ 実況」をONにすると新着レスを自動で取得します。
          自動追尾（画面を末尾へスクロール）は、設定の「自動追尾」がONで、かつ表示が末尾付近にあるときだけ働きます。
          実況板では同時接続数も表示されます。
        </P>
        <P>
          <b>ブクマ</b>: スレ画面の「★ ブクマ」で登録すると、トップと設定の「履歴・ブクマ」タブから辿れます。
          最近見たスレの履歴も同じタブにあり、一括消去もできます。
        </P>
      </Section>

      <Section id="account" title="アカウント（無くてもできること・作るとできること）">
        <P>
          <b>アカウント無しでできること</b>: 閲覧、スレ立て・レス・つぶやき、いいね（端末ごと1回）、
          通報、プラグインの個人用導入、NGや表示などの個人設定（端末に保存）。
        </P>
        <P>
          <b>アカウントを作るとできること</b>: 板の作成と管理、プラグインの作成・公開、GitHub連携（Gist等）、
          TOTP二段階認証とリカバリーコード、プラグイン作成トークンの発行。
        </P>
        <P>
          登録は表示名・メール・パスワード（8〜256文字）だけです。ログイン状態は30日間保たれます。
          パスワードの変更はアカウント画面のセキュリティから（現在のパスワードが必要）。
          パスワードを忘れたときは、<a href="#password">下の「パスワードを忘れたとき」</a>を見てください。
        </P>
      </Section>

      <Section id="password" title="パスワードを忘れたとき">
        <P>
          <b>復旧コードを作る</b>: 新規登録の最後（任意）か、アカウント画面の
          <a href="/account/security">セキュリティ</a>から作れます。作成・作り直しには
          <b>現在のパスワード</b>（TOTP を設定している場合は TOTP コードでも可）が必要です。
          コードは 10 個で各 1 回限り、<b>表示はそのときだけ</b>です。作り直すと古いコードはすべて無効になります。
          残りの枚数はセキュリティ画面に出ます。
        </P>
        <P>
          <b>復旧コードで再設定する</b>: <a href="/account/password-reset">パスワードを忘れたとき</a>で
          メールアドレス・復旧コード・新しいパスワードを入力します。ロボット確認は毎回必要です。
          成功するとコードは消費され、新しいパスワードになり、<b>ログイン中のセッションはすべて終了</b>します
          （自動ログインはしません）。TOTP を設定している場合は TOTP はそのままで、次のログインでコードが必要です。
        </P>
        <P>
          <b>復旧コードが無い場合</b>: 登録したメールアドレスから運営に連絡してください。運営（所有者）が本人確認のうえ、
          <b>1 回だけ使える再設定 URL</b>（24 時間有効）を登録メールアドレスへ送ります。
          運営の連絡先はサイト設定に表示されます（未設定の場合はサイトの管理者に確認してください）。
        </P>
        <P>
          <b>認証アプリ（TOTP）だけをなくした場合</b>: パスワードは覚えているなら
          <a href="/account/recovery">リカバリーコードで復旧</a>（メール＋パスワード＋コード）で TOTP をリセットできます。
        </P>
      </Section>

      <Section id="plugins" title="プラグイン（使う・作る）">
        <P>
          <b>使う</b>: <a href="/plugins">プラグイン一覧</a>の公開タブから<b>ログイン不要</b>で個人用に導入できます。
          導入の範囲は、匿名のときは<b>端末（ブラウザ）単位</b>、ログイン中は<b>アカウント単位</b>です
          （ログイン中は別の端末でも同じアカウントなら導入済みになります）。効果（表示の変換やボタン追加など）は
          導入した範囲のブラウザにだけ現れます。
        </P>
        <P>
          無効化・再有効化・アンインストールは、一覧の「導入済み」からプラグイン名を開き、
          <b>詳細ページの導入一覧</b>にあるボタンで行います。動作確認は
          <a href="/plugins/demo/">スレ表示デモ</a>で試せます。
        </P>
        <P>
          <b>作る</b>: ログインしていなくても、<b>自分専用（個人用）</b>のプラグインなら作成・保存・新しい版の追加ができます
          （1つのブラウザで10個まで、コード64KBまで、作成と版の追加は1日20回まで）。ログインせずに作ったものは
          <b>そのブラウザでだけ</b>編集でき、Cookie を消すと編集できなくなります。同じブラウザでログイン・新規登録すると
          アカウントに引き継がれます。公開申請・板やサイト全体への導入・外部通信やAIなどの権限にはログインが必要です。
          書き方や仕様は
          <a href="https://github.com/dma-cmyk/open-clone/blob/main/docs/plugin-guide.md" target="_blank" rel="noreferrer noopener">
            docs/plugin-guide.md
          </a>
          にまとまっています（テンプレートから作る方法や静的検査の説明があります）。
        </P>
      </Section>

      <Section id="plugin-permissions" title="プラグインの権限と表示場所">
        <P>
          プラグインを入れると、そのプラグインが<b>できること（権限）</b>と、<b>画面のどこに出るか（表示場所）</b>が決まります。
          導入する前に、プラグイン詳細の「権限と表示場所」で確認できます。危険度が中・高のものは色と文字の両方で目立たせています。
        </P>
        <h3 style={{ fontSize: 13, margin: "8px 0 2px" }}>権限（できること）</h3>
        <P>
          <b>危険度</b>: 低 = {PLUGIN_RISK_NOTE.low}／中 = {PLUGIN_RISK_NOTE.medium}／高 = {PLUGIN_RISK_NOTE.high}。
        </P>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {PLUGIN_PERMISSION_INFOS.map((info) => (
            <div
              key={info.permission}
              style={{
                borderLeft: `3px solid ${RISK_BORDER[info.risk]}`,
                padding: "3px 6px",
                background: info.risk === "high" ? "#fdecea" : info.risk === "medium" ? "#fff8e1" : "transparent",
              }}
            >
              <div className="oc-row" style={{ gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>{info.name}</b>
                <span className={RISK_CLASS[info.risk]}>危険度: {PLUGIN_RISK_LABEL[info.risk]}</span>
                <code style={{ fontSize: 10.5, color: "var(--oc-muted)" }}>{info.permission}</code>
              </div>
              <div style={{ fontSize: 12.5 }}>{info.description}</div>
            </div>
          ))}
        </div>
        <P>
          外部との通信（<code>net:fetch</code>）を使うプラグインは、通信先が詳細画面の「権限と表示場所」に表示されます。
          通信先が空のプラグインは外部と通信できません。
        </P>

        <h3 style={{ fontSize: 13, margin: "8px 0 2px" }}>表示場所（スロット）</h3>
        <P>実際に画面へ置かれる 10 か所です。プラグイン作者は manifest の <code>slots</code> で場所を指定します。</P>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {PLUGIN_PLACED_SLOTS.map((host) => {
            const info = pluginSlotInfo(host);
            const aliases = pluginSlotAliases(host);
            return (
              <div key={host} style={{ borderTop: "1px solid var(--oc-border)", padding: "4px 0" }}>
                <div className="oc-row" style={{ gap: 6 }}>
                  <b style={{ fontSize: 12.5 }}>{info.label}</b>
                  <code style={{ fontSize: 10.5, color: "var(--oc-muted)" }}>{host}</code>
                </div>
                <div style={{ fontSize: 12.5 }}>{info.description}</div>
                {aliases.length > 0 ? (
                  <div className="oc-small" style={{ color: "var(--oc-muted)" }}>
                    別名:{" "}
                    {aliases.map((alias) => (
                      <code key={alias} style={{ marginRight: 4 }}>
                        {alias}
                      </code>
                    ))}
                    （同じ場所に表示されます）
                  </div>
                ) : null}
              </div>
            );
          })}
          <div style={{ borderTop: "1px solid var(--oc-border)", padding: "4px 0" }}>
            <div className="oc-row" style={{ gap: 6 }}>
              <b style={{ fontSize: 12.5 }}>{pluginSlotInfo("plugin-page").label}</b>
              <code style={{ fontSize: 10.5, color: "var(--oc-muted)" }}>plugin-page</code>
            </div>
            <div style={{ fontSize: 12.5 }}>{pluginSlotInfo("plugin-page").description}</div>
          </div>
        </div>
        <P>
          書き方の詳細は
          <a
            href="https://github.com/dma-cmyk/open-clone/blob/main/docs/plugin-guide.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            docs/plugin-guide.md
          </a>
          にまとまっています。
        </P>
      </Section>

      <Section id="pet" title="AI ペット（聞く・やってもらう）">
        <P>
          画面の右下にいる <b>AI ペット</b> が、サイトの使い方の案内・掲示板の操作の代行・要約・
          自分用プラグインの作成を手伝います。ボタンを押すと会話のパネルが開きます。
          パネルは <b>「しまう」</b> で消せます。もう一度開くときは、ヘッダーの <b>「ペット」</b> を押してください。
        </P>
        <P>
          <b>使う準備</b>: 設定で、AI 事業者（OpenAI / Anthropic / Google Gemini / OpenRouter / DeepSeek /
          OpenAI 互換の URL）・モデル・API キーを入れます。キーは<b>この端末のブラウザにだけ</b>保存されます
          （「この端末に覚えておく」をオフにすると、タブを閉じるまで）。
          このサイトのサーバーは中継のたびにキーを受け取って事業者へ送るだけで、保存しません。
          料金は<b>あなたのキー</b>にかかります。モデルは「モデル一覧を取得」で一覧から検索して選ぶことも、
          名前を直接入れることもできます。
        </P>
        <P>
          <b>送られる内容</b>: 頼んだ文と、ペットが読んだページの文章（スレの本文など）が、選んだ AI 事業者に送られます。
          個人情報や秘密（パスワード・復旧コードなど）は書かないでください。
        </P>
        <P>
          <b>確認カード</b>: 書き込み・スレ立て・編集・削除・NG・プラグインの導入・板の管理など、
          掲示板に何かを残す・変える操作は、押す前に必ず確認カードが出ます。
          対象と内容を見て「実行」を押したときだけ行われ、「やめる」で取り消せます。
          削除など取り消せない操作は赤いカードになり、ボタンが「実行する（取り消せません）」になります。
          板の管理操作は、あなたがその板の管理人・副管理人・モデレーターでなければサーバーが拒否します
          （ペットでも権限は増えません）。パスワード・二段階認証・スタッフの任命などはペットに渡していません。
        </P>
        <P>
          <b>移動</b>: 「この板を開いて」のように頼むと、同じサイト内のページへ移動します。
          移動はその回の最後に行い、会話はそのまま残ります。
        </P>
        <P>
          <b>音声入力</b>: マイクのボタンで、話した言葉が入力欄の文字になります（対応しているブラウザのみ）。
          音声はブラウザの音声認識で文字にされ、Chrome では Google のサーバーに送られます。
          会話は<b>「消去」</b>で消せます（最大 40 件まで残ります）。
        </P>
      </Section>

      <Section id="report" title="通報・削除依頼・ルール">
        <P>
          問題のあるレスはレスの「通報」から届けられます（匿名可・ロボット確認あり・5回/5分の制限）。
          板のルールに違反している旨を理由から選んで書いてください。
        </P>
        <P>
          対応は板のスタッフ（モデレーター以上）またはサイト運営が行います。
          <b>全員から非表示</b>はモデレーター以上、<b>削除</b>は副管理人以上またはサイト運営だけができます。
          全員から非表示にしたレスは、板の管理画面の「非表示のレス」タブ、またはサイト管理画面の
          <a href="/admin/hidden-posts">非表示のレス</a>から確認して再表示できます。
          板のルールは板ページの「板ルールを見る」ボタンで展開表示されます。まずはそちらを確認してください。
        </P>
      </Section>

      <Section id="admin" title="管理者の種類（サイト運営と板の管理人）">
        <P>
          <b>サイト運営</b>: 所有者（owner）と特別管理人（special_admin）。サイト全体の設定・規制・監査・AI管理などを担います。
        </P>
        <P>
          <b>板のスタッフ</b>: 管理人（admin）・副管理人（deputy）・モデレーター（moderator）。
          その板の設定・スタッフ任命・通報対応・レスの非表示/削除・アクセス禁止などを担います。
        </P>
        <P>
          管理者・所有者向けの詳しいヘルプは <a href="/help/admin/">/help/admin/</a> にあります。
        </P>
      </Section>

      <Section id="faq" title="よくある質問">
        <P>
          <b>Q. 投稿ボタンを押しても送信されない。</b>{" "}
          A. ロボット確認が済んでいるか、連投制限の待ち時間中ではないか、本文が4096バイトを超えていないかを確認してください。
          エラー文に理由が出ます。
        </P>
        <P>
          <b>Q. レスが見えない。</b> A. 設定のNGで非表示になっているか、表示範囲（最新50など）の外かもしれません。
          「全部」に切り替えてみてください。スタッフに非表示にされたレスは通常見えません。
        </P>
        <P>
          <b>Q. パスワードを忘れた。</b> A. 復旧コードがあれば
          <a href="/account/password-reset">パスワードを忘れたとき</a>でメールアドレスとコードだけで再設定できます。
          コードが無い場合は、登録したメールアドレスから運営に連絡してください（運営が 1 回限りの再設定 URL を送ります）。
          詳しくは<a href="#password">「パスワードを忘れたとき」</a>を見てください。
        </P>
        <P>
          <b>Q. 検索の使い方は？</b> A. <a href="/search">検索</a>はスレタイ・全文・表示ID・画像の4種別です。
          全文は3文字以上で高速検索、2文字以下は部分一致になります。
        </P>
        <P>
          <b>Q. 投稿が消えた？</b> A. NG設定や通報対応で非表示/削除された可能性があります。
          通報は受け付けの通知が出るだけで、通報者向けの返信機能はありません。
          板のルール（板ページの「板ルールを見る」）と、設定のNG/表示を確認してください。
        </P>
      </Section>

      <Section id="tour" title="ツアーの始め方">
        <P>
          画面で順に案内する<b>使い方ツアー</b>があります。初めてサイトを開いたときには画面の隅に
          「はじめての方へ」の案内が出ます（閉じると二度と出ません）。ヘッダーの「使い方」から、
          今いる画面に合わせたツアーをいつでも始められます。
        </P>
        <P>
          下の一覧からは、ほかの画面のツアーも始められます。押すとその画面へ移動し、表示と権限の
          読み込みが済んでからツアーが始まります。<b>板</b>は勢いのある板、<b>スレ</b>はその板の新しいスレを
          自動で開きます（開ける板・スレが無いときは、その行は押せません）。
          <b>管理画面</b>と<b>板の管理</b>の行は、その権限がある人にだけ出ます。
        </P>
        <P>
          ツアー中は「次へ／戻る／終了」で進み、Escキーで終了、←→キーでも移動できます。
          吹き出しの<b>「目次」</b>を押すと、いまのツアーで案内する手順の一覧が出て、好きな手順へ移れます
          （目次を開いている間の Esc は目次だけを閉じます）。
          最後にこのヘルプの該当節へのリンクが出ます。
        </P>
        <TourList />
        <div className="oc-row">
          <button type="button" className="oc-btn oc-btn-primary" onClick={startTopTour}>
            トップページでツアーを始める
          </button>
          <span className="oc-note">トップページへ移動して、ツアーが始まります。</span>
        </div>
      </Section>
    </div>
  );
}
