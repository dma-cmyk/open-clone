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
  | "help-admin";

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
  requires?: "boardStaff" | "boardAdmin" | "siteAdmin" | "siteOwner";
}

export interface TourDefinition {
  /** 画面名（ツールチップの見出しに出す）。 */
  label: string;
  /** 最後の手順の後に出すヘルプ先。 */
  helpPath: string;
  steps: readonly TourStep[];
}