// 画面ごとのツアー手順。
// ここに書く説明は **実装にある機能だけ**（`data-tour` を付けた要素と、その画面で実際に
// できる操作）に限定する。存在しない機能・未実装の操作は書かない。

import type { TourDefinition, TourListContext, TourPageKey, TourStep } from "./types";
// 一覧の「開く先」（板・スレの自動選択）で使う既存の公開 API。相対 import は単体テスト
// （vitest）が `@/` エイリアスを解決しないため。
import { api } from "../board-ui/api";
import { PLUGIN_TOUR_DEFINITIONS } from "./steps-plugins";

/** 一般向けヘルプの節（`/help/`。アンカーは設計 50 で固定）。 */
const HELP = "/help/";
/** 管理者向けヘルプの節（`/help/admin/`）。 */
const HELP_ADMIN = "/help/admin/";

/**
 * 一覧（ヘルプ `#tour`）から始めるときに開く先。
 * 板・スレは API で選ぶ（トップの板一覧と同じ並びの先頭 → その板の新しいスレ）。
 * 削除板は `/v1/boards` に出ない（K2）ため、自動選択にも残らない。
 */
async function firstBoardEntry(): Promise<string | null> {
  try {
    const boards = await api.listBoards();
    const board = boards.items[0];
    return board ? `/b/${encodeURIComponent(board.slug)}` : null;
  } catch {
    return null;
  }
}

async function firstThreadEntry(): Promise<string | null> {
  try {
    const boards = await api.listBoards();
    for (const board of boards.items) {
      try {
        const threads = await api.listThreads(board.slug, { sort: "created", limit: 1 });
        const thread = threads.items[0];
        if (thread) return `/b/${encodeURIComponent(board.slug)}/t/${thread.id}`;
      } catch {
        // 選んだ直後に板が消えた（404）等は次の板へ。
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** その人がスタッフを務める最初の板の管理画面（無ければ null）。 */
function firstStaffBoardEntry(context: TourListContext): string | null {
  const slug = context.staffBoardSlugs[0];
  return slug ? `/b/${encodeURIComponent(slug)}/manage` : null;
}

const HOME: TourDefinition = {
  label: "トップページ",
  summary: "サイト内検索・上のメニュー・板一覧・板の作成・ログイン・ランキングの入口を案内します。",
  entry: () => "/",
  helpPath: `${HELP}#basics`,
  steps: [
    {
      id: "site-search",
      selector: '[data-tour="site-search"]',
      title: "サイト内検索",
      body: "スレタイや本文からスレを探せます。検索結果はスレタイ・全文・ID・画像の種類を切り替えられます。",
      helpAnchor: "#reading",
    },
    {
      id: "site-nav",
      selector: '[data-tour="site-nav"]',
      title: "上のメニュー",
      body: "板一覧（トップ）・板を作る・設定へ移動できます。「プラグイン」「ランキング」「管理」は画面が広いときだけ表示されます。",
      helpAnchor: "#basics",
    },
    {
      id: "home-boards",
      selector: '[data-tour="home-boards"]',
      title: "板一覧",
      body: "板は「スレ」を入れる棚です。板名を押すとスレの一覧が開きます。カテゴリのボタンで絞り込めます。",
      helpAnchor: "#basics",
    },
    {
      id: "home-new-board",
      selector: '[data-tour="home-new-board"]',
      title: "板を作る",
      body: "誰でも板を作って管理人になれます。板の作成にはアカウントが必要です（ログインしていない場合は案内が出ます）。",
      helpAnchor: "#board",
    },
    {
      id: "site-account",
      selector: '[data-tour="site-account"]',
      title: "ログインしなくても使えます",
      body: "スレを読む・レスを書く・スレを立てる・自分専用のプラグインを作るはログインなしでできます。ここからログインすると板の作成・管理やプラグインの公開ができます。",
      helpAnchor: "#account",
    },
    {
      id: "home-ranking",
      selector: '[data-tour="home-ranking"]',
      title: "ランキング・ヘッドライン",
      body: "勢いのあるスレをランキングで、新着スレをヘッドラインで見られます。どちらもログイン不要です。",
      helpAnchor: "#reading",
    },
  ],
};

const BOARD: TourDefinition = {
  label: "板",
  summary: "板のルール・板の中の検索・並び替え・スレ一覧・スレ立てを案内します。",
  entry: firstBoardEntry,
  helpPath: `${HELP}#basics`,
  steps: [
    {
      id: "board-rules",
      selector: '[data-tour="board-rules"]',
      title: "板のルール",
      body: "この板で守ることを確認できます。押すと開閉します。",
      helpAnchor: "#report",
    },
    {
      id: "board-search",
      selector: '[data-tour="board-search"]',
      title: "板の中を検索",
      body: "この板のスレタイを絞り込めます。検索中は「解除」で元の一覧に戻せます。",
      helpAnchor: "#reading",
    },
    {
      id: "board-sort",
      selector: '[data-tour="board-sort"]',
      title: "並び替え",
      body: "勢い・新レス・新スレ・レス数の順に並べ替えられます。検索と組み合わせても一致するスレは変わりません。",
      helpAnchor: "#reading",
    },
    {
      id: "board-list",
      selector: '[data-tour="board-list"]',
      title: "スレ一覧",
      body: "スレのタイトルを押すと本文が開きます。右側の「最新50」「最新10」などで表示するレスを選べます。",
      helpAnchor: "#reading",
    },
    {
      id: "board-new-thread",
      selector: '[data-tour="board-new-thread"]',
      title: "スレを立てる",
      body: "下の欄にスレタイと本文を書いて「スレを立てる」で作成します。ログインは不要です。",
      helpAnchor: "#posting",
    },
  ],
};

const THREAD: TourDefinition = {
  label: "スレ",
  summary: "スレの見出し・スレ内検索・表示範囲・実況・レス操作・書き込みフォームを案内します。",
  entry: firstThreadEntry,
  helpPath: `${HELP}#reading`,
  steps: [
    {
      id: "thread-head",
      selector: '[data-tour="thread-head"]',
      title: "スレの見出し",
      body: "スレタイとレス数、どの板のスレかが分かります。板名を押すと板の一覧へ戻ります。",
      helpAnchor: "#reading",
    },
    {
      id: "thread-search",
      selector: '[data-tour="thread-search"]',
      title: "スレ内検索",
      body: "このスレの本文だけを絞り込めます。「解除」で元に戻ります。",
      helpAnchor: "#reading",
    },
    {
      id: "thread-range",
      selector: '[data-tour="thread-range"]',
      title: "表示するレス",
      body: "「1-100」「最新50」「全部」「画像一覧」で表示範囲を切り替えます。右端に最終投稿の時刻が出ます。",
      helpAnchor: "#reading",
    },
    {
      id: "thread-tools",
      selector: '[data-tour="thread-tools"]',
      title: "実況・つぶやき・ブクマ",
      body: "実況を入れると新着を自動で受け取ります。つぶやきは流れるコメント、ブクマはこの端末に保存されます。",
      helpAnchor: "#tsubuyaki",
    },
    {
      id: "thread-posts",
      selector: '[data-tour="thread-posts"]',
      title: "レス番号・ID・アンカー",
      body: "レス番号を押すと引用（>>n）が入ります。ID を押すとその ID のレスだけを表示します。下の「引用」「通報」も使えます。",
      helpAnchor: "#reading",
    },
    {
      id: "thread-post-actions",
      selector: '[data-tour="thread-post-actions"]',
      title: "通報と削除依頼",
      body: "問題のあるレスは「通報」から理由を選んで送れます。板の管理人は、この画面から「全員から非表示」「削除」も行えます。全員から非表示にしたレスは、板の管理画面の「非表示のレス」から再表示できます。",
      helpAnchor: "#report",
    },
    {
      id: "post-form-body",
      reveal: ".oc-form-openbar",
      restore: ".oc-form-collapse",
      selector: '[data-tour="post-form-body"]',
      title: "書き込みフォーム",
      body: "本文を書いて「投稿する」で送信します。名前・メール欄（sage）は任意です。",
      helpAnchor: "#posting",
    },
    {
      id: "post-form-name",
      reveal: ".oc-form-openbar",
      restore: ".oc-form-collapse",
      selector: '[data-tour="post-form-name"]',
      title: "名前と sage",
      body: "名前を空欄にすると「名無しさん」になります。sage を入れるとスレが「新レス」順で上に上がりません。レス数は増え、勢い順・レス数順の並びは投稿数などで動きます。",
      helpAnchor: "#posting",
    },
    {
      id: "post-form-tools",
      reveal: ".oc-form-openbar",
      restore: ".oc-form-collapse",
      selector: '[data-tour="post-form-tools"]',
      title: "画像・お絵かき",
      body: "「画像/ファイル」から添付できます。お絵かきを押すとその場で絵を描いて添付できます。",
      helpAnchor: "#posting",
    },
    {
      id: "post-form-turnstile",
      reveal: ".oc-form-openbar",
      restore: ".oc-form-collapse",
      selector: '[data-tour="post-form-turnstile"]',
      title: "ロボット確認",
      body: "板の設定が「未ログインのみ要求」ならログインしていないときだけ、「全投稿で要求」ならログイン中でも表示されます。未ログインのみの板では、一度通ると板ごとに一定時間（既定30分）レスとつぶやきの確認が省略され、この欄は出なくなります。スレ立ては毎回確認します。",
      helpAnchor: "#posting",
    },
    {
      id: "post-form-count",
      reveal: ".oc-form-openbar",
      restore: ".oc-form-collapse",
      selector: '[data-tour="post-form-count"]',
      title: "文字数の上限",
      body: "本文は 4096 バイトまでです。日本語は 1 文字あたり約 3 バイトなので、目安として 1300 文字前後まで書けます。",
      helpAnchor: "#posting",
    },
  ],
};

const BOARD_NEW: TourDefinition = {
  label: "板を作る",
  summary: "板の作成フォーム（スラッグ・板名・カテゴリ）を案内します。",
  entry: () => "/boards/new",
  helpPath: `${HELP}#board`,
  steps: [
    {
      id: "board-new-form",
      selector: '[data-tour="board-new-form"]',
      title: "板の作成",
      body: "板スラッグ（URL の /b/ 以降）・板名・カテゴリを入れて作成します。作成にはアカウントが必要です。",
      helpAnchor: "#board",
    },
  ],
};

const SETTINGS: TourDefinition = {
  label: "設定",
  summary: "設定の NG（見たくない語・ID・名前・スレタイ）の登録を案内します。",
  entry: () => "/settings",
  helpPath: `${HELP}#reading`,
  steps: [
    {
      id: "settings-ng",
      selector: '[data-tour="settings-ng"]',
      title: "NG 設定",
      body: "見たくないワード・ID・名前・トリップ・スレタイを登録できます。「無視したスレ」もここに追加日時つきで並び、いつでも解除できます。設定はこの端末にだけ保存されます。",
      helpAnchor: "#reading",
    },
  ],
};

const ADMIN: TourDefinition = {
  label: "管理画面",
  summary: "管理メニューと、ダッシュボード・ユーザー・板・通報・AI などの各画面を順に案内します。",
  listVisible: (ctx) => ctx.siteOwner || ctx.siteSpecialAdmin,
  entry: () => "/admin",
  helpPath: HELP_ADMIN,
  steps: [
    {
      id: "admin-nav",
      selector: '[data-tour="admin-nav"]',
      title: "管理メニュー",
      body: "サイト運営の各画面へ移動します。所有者はすべて、特別管理人は所有者専用の項目以外が表示されます。",
      helpAnchor: "#roles",
    },
    {
      id: "admin-dashboard",
      selector: '[data-tour="admin-nav-dashboard"]',
      title: "ダッシュボード",
      body: "ユーザー・板・通報・AI の状況をまとめて確認できます。カードを押すと各画面へ移ります。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-users",
      selector: '[data-tour="admin-nav-users"]',
      title: "ユーザーと規制",
      body: "アカウントの検索・停止と、サイト全体／板単位の規制を管理します。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-boards",
      selector: '[data-tour="admin-nav-boards"]',
      title: "板の横断確認",
      body: "全板の一覧から、それぞれの板の管理画面へ移動できます。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-reports",
      selector: '[data-tour="admin-nav-reports"]',
      title: "通報の処理",
      body: "利用者から届いた通報を確認します。「レス」のタブでレスを全員から非表示・削除し、「プラグイン」のタブで通報のあったプラグインを確認して対応済み・却下にします。非表示にしたレスは「非表示のレス」の画面から戻せます。アクセス禁止（規制）は「規制」の画面で行います。",
      helpAnchor: "#board-staff",
    },
    {
      id: "admin-hidden-posts",
      selector: '[data-tour="admin-nav-hidden-posts"]',
      title: "非表示のレス",
      body: "全板の「全員から非表示」にしたレスを新しい順に確認し、その場で再表示できます。板のスラッグで絞り込めます。非表示・再表示は監査ログに残ります。",
      helpAnchor: "#board-staff",
    },
    {
      id: "admin-ai",
      selector: '[data-tour="admin-nav-ai"]',
      title: "AI 管理",
      body: "AI 管理者の稼働状況・承認キュー・緊急停止を扱います。高リスクの操作は承認が必要です。",
      helpAnchor: "#ai",
    },
    {
      id: "admin-invites",
      selector: '[data-tour="admin-nav-invites"]',
      title: "特別管理人の招待（所有者のみ）",
      body: "就任キーを発行して特別管理人を招きます。任命後の停止・復帰は「特別管理人」の画面で行います。",
      helpAnchor: "#owner",
    },
    {
      id: "admin-settings",
      selector: '[data-tour="admin-nav-settings"]',
      title: "サイト設定（表示のみ）",
      body: "登録の可否や Turnstile など、サイト全体の設定を確認できます。変更できるのはサイト所有者だけです。",
      helpAnchor: "#owner",
    },
    {
      id: "admin-special-admins",
      selector: '[data-tour="admin-nav-special-admins"]',
      title: "特別管理人（所有者のみ）",
      body: "特別管理人の権限停止・復帰・TOTP のリセットを行います。特別管理人はサイト設定の変更や任免はできません。",
      helpAnchor: "#owner",
      requires: "siteOwner",
    },
    {
      id: "admin-suspensions",
      selector: '[data-tour="admin-nav-suspensions"]',
      title: "規制",
      body: "サイト全体・板単位のアクセス禁止を管理します。通報画面の「非表示・削除」とは別の画面です。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-audit",
      selector: '[data-tour="admin-nav-audit"]',
      title: "監査ログ",
      body: "自分の管理操作の履歴（誰がいつ何をしたか）を確認できます。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-usage",
      selector: '[data-tour="admin-nav-usage"]',
      title: "使用量",
      body: "D1 の行数・セッション数など、無料枠に対する使用量を確認します。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-ai-queue",
      selector: '[data-tour="admin-nav-ai-queue"]',
      title: "AI 承認キュー",
      body: "AI 管理者が提案した高リスク操作を承認・却下します。",
      helpAnchor: "#ai",
    },
    {
      id: "admin-ai-stop",
      selector: '[data-tour="admin-nav-ai"]',
      title: "AI の緊急停止",
      body: "「AI 管理」の画面から AI の動作を止められます。停止中は AI による操作が一切実行されません。",
      helpAnchor: "#ai",
    },
    {
      id: "admin-plugins",
      selector: '[data-tour="admin-nav--plugins"]',
      title: "プラグイン管理",
      body: "公開プラグインの一覧・検索・導入と、自分のプラグインの管理ができます。",
      helpAnchor: "#plugin-review",
    },
    {
      id: "admin-all-boards",
      selector: '[data-tour="admin-nav--b"]',
      title: "全板一覧",
      body: "全板をまとめて確認するためのメニューです。「板一覧」の管理画面（/admin/boards）とは別の入口です。",
      helpAnchor: "#site-admin",
    },
    {
      id: "admin-help",
      selector: '[data-tour="admin-help"]',
      title: "管理者向けヘルプと再認証",
      body: "権限の一覧・板の管理・審査・AI・二段階認証の説明は管理者向けヘルプにまとまっています。サイト設定の変更など一部の操作では、実行前に TOTP での再認証を求められます。",
      helpAnchor: "#security",
    },
  ],
};

const MANAGE: TourDefinition = {
  label: "板の管理",
  summary: "板の管理メニュー・設定・スタッフ・通報の画面を案内します（スタッフの板だけ）。",
  listVisible: (ctx) => ctx.staffBoardSlugs.length > 0,
  entry: firstStaffBoardEntry,
  helpPath: HELP_ADMIN,
  steps: [
    {
      id: "manage-tabs",
      requires: "boardStaff",
      selector: '[data-tour="manage-tabs"]',
      title: "板の管理メニュー",
      body: "板の設定・ルール・デザイン・スタッフ・プラグイン・AI・通報・非表示のレスを切り替えます。設定の保存とスタッフの任命は板の管理人だけができます。",
      helpAnchor: "#board-staff",
    },
    {
      id: "manage-panel",
      requires: "boardAdmin",
      selector: '[data-tour="manage-panel"]',
      title: "設定の中身",
      body: "選んだタブの設定がここに出ます。保存すると板に反映されます。",
      helpAnchor: "#board-staff",
    },
    {
      id: "manage-staff",
      requires: "boardAdmin",
      selector: '[data-tour="manage-tab-staff"]',
      title: "スタッフ",
      body: "板の管理人が副管理人・モデレーターを任命できます。モデレーターは通報の確認とレスの非表示ができ、削除は副管理人以上です。",
      helpAnchor: "#roles",
    },
    {
      id: "manage-reports",
      requires: "boardStaff",
      selector: '[data-tour="manage-tab-reports"]',
      title: "通報",
      body: "この板に届いた通報を確認し、レスを全員から非表示にできます。削除は副管理人以上です。非表示にしたレスは「非表示のレス」タブから再表示できます。アクセス禁止（規制）の操作はこの管理画面にはありません。",
      helpAnchor: "#board-staff",
    },
    {
      id: "manage-hidden-posts",
      requires: "boardStaff",
      selector: '[data-tour="manage-tab-hidden"]',
      title: "非表示のレス",
      body: "この板で全員から非表示にしたレスの一覧です。本文の抜粋・非表示にした人と日時を確認し、その場で再表示できます。通報の処理から非表示にしたレスもここに出ます。",
      helpAnchor: "#board-staff",
    },
    {
      id: "manage-help",
      requires: "boardStaff",
      selector: '[data-tour="manage-help"]',
      title: "管理者向けヘルプ",
      body: "板の管理・権限・通報の流れは管理者向けヘルプにまとまっています。",
      helpAnchor: "#board-staff",
    },
  ],
};

const HELP_PAGE: TourDefinition = {
  label: "ヘルプ",
  summary: "このヘルプの使い方（用語や操作の探し方）を案内します。",
  entry: () => "/help/",
  helpPath: HELP,
  steps: [
    {
      id: "help-body",
      selector: "main",
      title: "ヘルプ",
      body: "掲示板の用語と操作をまとめています。分からない言葉は目次から探せます。",
      helpAnchor: "#faq",
    },
  ],
};

const HELP_ADMIN_PAGE: TourDefinition = {
  label: "管理者向けヘルプ",
  summary: "所有者・特別管理人・板の管理人の権限と操作をまとめたヘルプを案内します。",
  entry: () => "/help/admin/",
  helpPath: HELP_ADMIN,
  steps: [
    {
      id: "help-admin-body",
      selector: "main",
      title: "管理者向けヘルプ",
      body: "所有者・特別管理人・板の管理人の権限と操作をまとめています。",
      helpAnchor: "#roles",
    },
  ],
};

export const TOUR_DEFINITIONS: Record<TourPageKey, TourDefinition> = {
  home: HOME,
  board: BOARD,
  thread: THREAD,
  "board-new": BOARD_NEW,
  settings: SETTINGS,
  admin: ADMIN,
  manage: MANAGE,
  help: HELP_PAGE,
  "help-admin": HELP_ADMIN_PAGE,
  ...PLUGIN_TOUR_DEFINITIONS,
};

/**
 * 一覧（ヘルプ `#tour`）に並べるツアー。`TOUR_DEFINITIONS` から作るので、
 * 後からキーを足しても一覧にそのまま載る（キーは手で列挙しない）。
 * 並び順だけ下の希望順で決め、知らないキー（後から足した画面）は末尾に回す。
 */
const LIST_ORDER: readonly TourPageKey[] = [
  "home",
  "board",
  "thread",
  "board-new",
  "settings",
  "admin",
  "manage",
  "help",
  "help-admin",
];

export interface TourListEntry {
  page: TourPageKey;
  definition: TourDefinition;
}

export const TOUR_LIST_DEFINITIONS: readonly TourListEntry[] = (() => {
  const rank = new Map<TourPageKey, number>(LIST_ORDER.map((page, index) => [page, index]));
  const entries: TourListEntry[] = [];
  for (const page of Object.keys(TOUR_DEFINITIONS) as TourPageKey[]) {
    const definition = TOUR_DEFINITIONS[page];
    // 一覧に出すのは説明と開く先のあるツアーだけ（型の契約）。
    if (!definition.summary || typeof definition.entry !== "function") continue;
    entries.push({ page, definition });
  }
  // Array#sort は安定なので、順位の同じ（未知の）キーは定義順のまま残る。
  return entries.sort((a, b) => (rank.get(a.page) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.page) ?? Number.MAX_SAFE_INTEGER));
})();

/** その画面のツアー定義（未対応の画面は null）。 */
export function tourDefinitionOf(key: TourPageKey): TourDefinition {
  return TOUR_DEFINITIONS[key];
}

/**
 * 画面に出ている手順だけに絞る（ログイン状態・板の設定で出ない部品を飛ばす）。
 * `reveal` 付きの手順（スマホで畳まれている投稿欄など）は、押して開けば出るので残す。
 * `isVisible` を差し替えられるようにして単体テストできる形にしている。
 */
export function resolveSteps(
  definition: TourDefinition,
  isVisible: (selector: string) => boolean,
  context: {
    boardStaff?: boolean;
    canManageBoard?: boolean;
    siteOwner?: boolean;
    siteSpecialAdmin?: boolean;
    pluginAuthor?: boolean;
  } = {},
): TourStep[] {
  const allowed = (step: TourStep): boolean => {
    switch (step.requires) {
      case "boardStaff":
        return Boolean(context.boardStaff);
      case "boardAdmin":
        return Boolean(context.canManageBoard);
      case "siteAdmin":
        return Boolean(context.siteOwner || context.siteSpecialAdmin);
      case "siteOwner":
        return Boolean(context.siteOwner);
      case "pluginAuthor":
        return Boolean(context.pluginAuthor);
      default:
        return true;
    }
  };
  return definition.steps.filter((step) => allowed(step) && (Boolean(step.reveal) || isVisible(step.selector)));
}

export type { TourStep } from "./types";