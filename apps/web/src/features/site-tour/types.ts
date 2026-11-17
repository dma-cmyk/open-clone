// サイトツアーの型。画面ごとの手順（どこを指すか・何ができるか）を定義する。

/** ツアーを用意している画面。URL から自動判定する（`tourPageKeyForPath`）。 */
export type TourPageKey =
  | "home"
  | "board"
  | "thread"
  | "board-new"
  | "settings"
  | "admin"
  | "manage"
  | "help"
  | "help-admin"
  | "plugins"
  | "plugin-new"
  | "plugin-templates"
  | "plugin-view"
  | "plugins-board"
  | "plugins-review"
  | "plugin-tokens";

export interface TourStep {
  /** 手順の識別子（テスト・計測用）。 */
  id: string;
  /** 強調する要素の CSS セレクタ。画面に無ければその手順は飛ばす（複数一致は可視のものを使う）。 */
  selector: string;
  /**
   * 対象がまだ画面に無いときに、先に押す要素（例: スマホで畳まれている投稿欄の「書き込む」）。
   * 1 度だけ押してから測り直す。
   */
  reveal?: string;
  /** ツアーが開いた UI を閉じるための要素（終了時に 1 度だけ押す）。 */
  restore?: string;
  title: string;
  /** 2〜3 文の説明。実装にある機能だけを書く。 */
  body: string;
  /** 「もっと詳しく」で開くヘルプのアンカー（`/help/` または `/help/admin/`）。 */
  helpAnchor?: string;
  /**
   * この手順を案内してよい権限（レビュー 52 / T04・T09）。
   * 画面側が `setTourContext` で知らせた実際の権限で判定する。
   */
  requires?: "boardStaff" | "boardAdmin" | "siteAdmin" | "siteOwner" | "pluginAuthor";
}

/**
 * ツアーの一覧（ヘルプ `#tour`）で、行を出すか・どこを開くかを決めるための利用者の情報。
 * 一覧側がまとめて取得して各ツアーに渡す（取得中は管理系の行を出さない）。
 */
export interface TourListContext {
  loggedIn: boolean;
  siteOwner: boolean;
  siteSpecialAdmin: boolean;
  /** 管理人・副管理人・モデレーターを務める板のスラッグ。 */
  staffBoardSlugs: readonly string[];
  /** 管理人（板にプラグインを導入できる立場）を務める板のスラッグ。 */
  adminBoardSlugs: readonly string[];
}

export interface TourDefinition {
  /** 画面名（ツールチップの見出しに出す）。 */
  label: string;
  /** 最後の手順の後に出すヘルプ先。 */
  helpPath: string;
  steps: readonly TourStep[];
  /** 一覧に出す 1 行の説明。無いツアーは一覧に出さない。 */
  summary?: string;
  /** 一覧に出してよい人か（省略時は全員）。 */
  listVisible?: (ctx: TourListContext) => boolean;
  /**
   * 一覧から始めるときに開く URL。開ける先が無ければ null（行を無効にして理由を出す）。
   * 板・スレ・プラグイン詳細など、開く先を API で選ぶものは非同期でよい。無いツアーは一覧に出さない。
   */
  entry?: (ctx: TourListContext) => string | null | Promise<string | null>;
}