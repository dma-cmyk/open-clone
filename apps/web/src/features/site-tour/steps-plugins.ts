// プラグイン画面のツアー手順。
// 説明は各画面の実装にある機能だけを書く。権限が要る操作の手順は `requires` で絞る。

import { pluginApi } from "../plugin-host/api";
import type { TourDefinition } from "./types";

/** 一般向けヘルプの節。 */
const HELP = "/help/";
/** 管理者向けヘルプの節。 */
const HELP_ADMIN = "/help/admin/";

const PLUGINS: TourDefinition = {
  label: "プラグイン一覧",
  helpPath: `${HELP}#plugins`,
  summary: "検索・導入・GitHub / Gist からの取り込み",
  entry: () => "/plugins/",
  steps: [
    {
      id: "plugins-actions",
      selector: '[data-tour="plugins-actions"]',
      title: "作り方と審査の入口",
      body: "「テンプレートから作る」「コードを書いて作成」からプラグインを作れます。審査キューはサイトの所有者・特別管理人だけが使います。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugins-tabs",
      selector: '[data-tour="plugins-tabs"]',
      title: "公開・自分・導入済み",
      body: "公開プラグインを探す／自分のプラグイン（表示にはログインが必要）／このブラウザやアカウントに導入済みの一覧を切り替えます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugins-search",
      selector: '[data-tour="plugins-search"]',
      title: "検索と絞り込み",
      body: "名前・説明の検索、スコープ（個人用・板用・サイト全体）、並び順（更新順・人気順・新着順）で絞り込めます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugins-list",
      selector: '[data-tour="plugins-list"]',
      title: "プラグイン一覧",
      body: "名前を押すと詳細が開きます。「個人用に導入」はログイン不要で、このブラウザにだけ適用されます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugins-import",
      selector: '[data-tour="plugins-import"]',
      title: "GitHub / Gist から取り込む（任意）",
      body: "公開 Gist や公開リポジトリ（manifest.json + plugin.js）から下書きとして取り込めます。GitHub を使わなくても作成・公開できます。",
      helpAnchor: "#plugins",
    },
  ],
};

const PLUGIN_NEW: TourDefinition = {
  label: "プラグインを作る",
  helpPath: `${HELP}#plugins`,
  summary: "コードを書いて作成し、版を追加する",
  entry: () => "/plugins/new/",
  steps: [
    {
      id: "plugin-editor-anon-note",
      selector: '[data-tour="plugin-editor-anon-note"]',
      title: "ログインせずに作るとき",
      body: "保存したプラグインはこのブラウザでだけ編集でき、Cookie を消すと編集できなくなります。コードは 64KB までで、公開申請や板への導入にはアカウントが必要です。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-editor-manifest",
      selector: '[data-tour="plugin-editor-manifest"]',
      title: "manifest（名前・権限・スコープ）",
      body: "名前（slug）・バージョン・概要・説明と、適用スコープ・権限・UI スロット・許可オリジン・宣言的レンダー規則を決めます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-editor-code",
      selector: '[data-tour="plugin-editor-code"]',
      title: "コード（plugin.js）",
      body: "エディタにプラグイン本体を書きます。右上にバイト数が出ます（ログインなしは 64KB、ログイン中は 512KB まで）。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-editor-actions",
      selector: '[data-tour="plugin-editor-actions"]',
      title: "保存・プレビュー・静的検査・公開申請",
      body: "下書きを保存し、プレビュー実行や静的検査を行います。公開範囲を選び、保存後に「公開申請」で検索に載せられます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-editor-preview",
      selector: '[data-tour="plugin-editor-preview"]',
      title: "プレビュー（sandbox）",
      body: "サンプルデータで実行し、通知やログを確認できます。外部通信・投稿・GitHub はプレビューでは無効です。",
      helpAnchor: "#plugins",
    },
  ],
};

const PLUGIN_TEMPLATES: TourDefinition = {
  label: "テンプレートから作る",
  helpPath: `${HELP}#plugins`,
  summary: "フォームに入力するだけでプラグインを作る",
  entry: () => "/plugins/templates/",
  steps: [
    {
      id: "plugin-templates-anon-note",
      selector: '[data-tour="plugin-templates-anon-note"]',
      title: "ログインせずに保存するとき",
      body: "このブラウザでだけ編集でき、Cookie を消すと編集できなくなります。公開申請や板への導入にはアカウントが必要です。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-templates-code-link",
      selector: '[data-tour="plugin-templates-code-link"]',
      title: "コードを直接書きたいとき",
      body: "フォームで作らず、エディタでコードを書いて作ることもできます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-templates-pick",
      selector: '[data-tour="plugin-templates-pick"]',
      title: "テンプレートを選ぶ",
      body: "テンプレートごとに説明・種類・必要な権限が表示されます。「これで作る」で入力フォームへ進みます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-templates-note",
      selector: '[data-tour="plugin-templates-note"]',
      title: "作ったあとの扱い",
      body: "保存すると非公開の個人用として、このブラウザに導入されます。板・サイト全体への公開は保存後の詳細画面から申請します。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-templates-form",
      selector: '[data-tour="plugin-templates-form"]',
      title: "項目を埋める",
      body: "テンプレートの項目を入力します。必須項目や形式はその場で検証され、エラーは項目のそばに出ます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-templates-preview",
      selector: '[data-tour="plugin-templates-preview"]',
      title: "プレビューと検査結果",
      body: "「プレビュー」で動作結果と静的検査を表示します。検査に合格しないと保存できません。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-templates-save",
      selector: '[data-tour="plugin-templates-save"]',
      title: "自分用に導入して保存",
      body: "保存すると非公開のプラグインになり、このブラウザに個人用として導入されます。",
      helpAnchor: "#plugins",
    },
  ],
};

const PLUGIN_VIEW: TourDefinition = {
  label: "プラグイン詳細",
  helpPath: `${HELP}#plugins`,
  summary: "導入・更新・通報・バージョンの確認",
  entry: async () => {
    try {
      const page = await pluginApi.list({ limit: 50 });
      const official = page.items.find((item) => item.ownership === "official");
      return official ? `/plugins/view/?id=${encodeURIComponent(official.id)}` : null;
    } catch {
      return null;
    }
  },
  steps: [
    {
      id: "plugin-detail-basic",
      selector: '[data-tour="plugin-detail-basic"]',
      title: "基本情報",
      body: "公開状態・バージョン・公開範囲・導入数・通報数と、所有者・スコープ・更新日時を確認できます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-detail-permissions",
      selector: '[data-tour="plugin-detail-permissions"]',
      title: "権限と表示場所",
      body: "このプラグインができること（権限）と危険度、外部通信の通信先、画面のどこに出るか（表示場所）を確認できます。導入する前に目を通してください。",
      helpAnchor: "#plugin-permissions",
    },
    {
      id: "plugin-detail-install",
      selector: '[data-tour="plugin-detail-install"]',
      title: "インストール",
      body: "「個人用にインストール」はログイン不要でこのブラウザにだけ適用されます。板用は板の管理人、サイト全体は所有者・特別管理人が実行できます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-detail-report",
      selector: '[data-tour="plugin-detail-report"]',
      title: "通報",
      body: "悪意のあるコード・スパム・動作しないなどを選んで運営へ通報できます。",
      helpAnchor: "#report",
    },
    {
      id: "plugin-detail-versions",
      selector: '[data-tour="plugin-detail-versions"]',
      title: "バージョン",
      body: "公開済みのバージョンと状態、更新日時、コードのハッシュを確認できます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-detail-owner",
      requires: "pluginAuthor",
      selector: '[data-tour="plugin-detail-owner"]',
      title: "作者向けの操作",
      body: "作者は公開申請・停止（キルスイッチ）・fork・削除を行えます。他の人の導入があるプラグインは削除できず、停止を使います。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-detail-github",
      requires: "pluginAuthor",
      selector: '[data-tour="plugin-detail-github"]',
      title: "GitHub / Gist（作者向け・任意）",
      body: "作者は公開 Gist への発行、リポジトリへの push、取得元からの同期を行えます。GitHub 未連携ならエラーになります。",
      helpAnchor: "#plugins",
    },
  ],
};

const PLUGINS_BOARD: TourDefinition = {
  label: "板のプラグイン設定",
  helpPath: `${HELP_ADMIN}#board-staff`,
  summary: "板にプラグインを導入・停止する（板の管理人）",
  listVisible: (ctx) => ctx.adminBoardSlugs.length > 0,
  entry: (ctx) => {
    const slug = ctx.adminBoardSlugs[0];
    return slug ? `/plugins/board/?slug=${encodeURIComponent(slug)}` : null;
  },
  steps: [
    {
      id: "plugins-board-target",
      selector: '[data-tour="plugins-board-target"]',
      title: "対象の板",
      body: "?slug= で指定した板を API から解決し、板名・スラッグ・ID を確認します。解決できないときは板 ID を入力します。",
      helpAnchor: "#board-staff",
    },
    {
      id: "plugins-board-install",
      selector: '[data-tour="plugins-board-install"]',
      title: "プラグインを導入",
      body: "プラグイン ID または名前を入れて「導入」を押すと、この板に板用スコープで導入されます。導入には板の管理人（admin）権限が必要です。",
      helpAnchor: "#board-staff",
    },
    {
      id: "plugins-board-installed",
      selector: '[data-tour="plugins-board-installed"]',
      title: "この板のプラグイン",
      body: "導入済みの一覧から、この板での停止やアンインストールができます。サイト全体で停止中のものは効果がありません。",
      helpAnchor: "#board-staff",
    },
  ],
};

const PLUGINS_REVIEW: TourDefinition = {
  label: "プラグイン審査",
  helpPath: `${HELP_ADMIN}#plugin-review`,
  summary: "サイト公開の申請を審査する（所有者・特別管理人）",
  listVisible: (ctx) => ctx.siteOwner || ctx.siteSpecialAdmin,
  entry: () => "/plugins/review/",
  steps: [
    {
      id: "plugins-review-filters",
      selector: '[data-tour="plugins-review-filters"]',
      title: "審査の状態",
      body: "未審査・承認済み・却下済みを切り替え、「再読み込み」で最新の申請を取得します。",
      helpAnchor: "#plugin-review",
    },
    {
      id: "plugins-review-list",
      selector: '[data-tour="plugins-review-list"]',
      title: "申請の内容と判定",
      body: "静的検査の結果・リスク・申請日時を確認し、審査メモを書いて「承認」または「却下」します。詳細からプラグイン本体も開けます。",
      helpAnchor: "#plugin-review",
    },
  ],
};

const PLUGIN_TOKENS: TourDefinition = {
  label: "プラグイン作成トークン",
  helpPath: `${HELP}#account`,
  summary: "AI から自分のプラグインを作るためのトークン",
  listVisible: (ctx) => ctx.loggedIn,
  entry: () => "/account/plugin-tokens/",
  steps: [
    {
      id: "plugin-tokens-issue",
      selector: '[data-tour="plugin-tokens-issue"]',
      title: "トークンを発行する",
      body: "識別名を付けて発行します。発行には TOTP 二段階認証が必要で、平文はこの画面で一度だけ表示されます。",
      helpAnchor: "#account",
    },
    {
      id: "plugin-tokens-guide",
      selector: '[data-tour="plugin-tokens-guide"]',
      title: "接続手順",
      body: "Claude Code やその他の MCP クライアントに、API の URL と発行したトークンを設定します。動作確認ではテンプレート一覧の取得を試します。",
      helpAnchor: "#account",
    },
    {
      id: "plugin-tokens-list",
      selector: '[data-tour="plugin-tokens-list"]',
      title: "発行済みのトークン",
      body: "識別名・prefix・作成日・期限・最終使用を確認し、個別または「すべて失効」で無効にできます。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-tokens-drafts",
      selector: '[data-tour="plugin-tokens-drafts"]',
      title: "AI が作った下書きの確認",
      body: "AI が作った下書きは「自分のプラグイン」に表示されます。コードと静的検査を確認してから導入・公開してください。",
      helpAnchor: "#plugins",
    },
    {
      id: "plugin-tokens-safety",
      selector: '[data-tour="plugin-tokens-safety"]',
      title: "トークンの取り扱い",
      body: "トークンはパスワードと同じです。漏れたときはすぐに失効し、期限が切れたら再発行します。",
      helpAnchor: "#account",
    },
  ],
};

export const PLUGIN_TOUR_DEFINITIONS = {
  plugins: PLUGINS,
  "plugin-new": PLUGIN_NEW,
  "plugin-templates": PLUGIN_TEMPLATES,
  "plugin-view": PLUGIN_VIEW,
  "plugins-board": PLUGINS_BOARD,
  "plugins-review": PLUGINS_REVIEW,
  "plugin-tokens": PLUGIN_TOKENS,
} as const;