// 掲示板 API のクライアント側型。CONTRACTS/WP1 合意済みの REST 契約を写したもの。
// API 応答は将来フィールドが増えても壊れないよう、全て optional を許容し normalize で既定値を埋める。

export type BoardId = string | number;

export interface BoardSummary {
  id: BoardId;
  slug: string;
  name: string;
  category: string;
  description?: string;
  threadCount?: number;
  postCount?: number;
  lastPostAt?: number | null;
}

/** shared/schemas/board.ts の boardDesignSchema に対応。 */
export interface BoardDesign {
  themeColor?: string;
  accentColor?: string;
  bannerUrl?: string | null;
  /** 板ごとの追加 CSS（サーバ保存のみ。描画時の適用は行わない） */
  css?: string;
}

/** shared/schemas/board.ts の boardSettingsSchema に対応。 */
export interface BoardSettings {
  cooldownSeconds?: number;
  turnstile?: "off" | "anonymous" | "always";
  /** ロボット確認を省略する時間（分）。0 = 毎回。レス・つぶやきだけが対象（報告書 81）。 */
  turnstilePassMinutes?: number;
  ngWords?: string[];
  ngWordAction?: "reject" | "mask";
  live?: boolean;
  noId?: boolean;
  allowImages?: boolean;
  tsubuyaki?: boolean;
  maxPosts?: number;
  uploader?: string | null;
  forceSage?: boolean;
  allowPostEdit?: boolean;
  allowPostDelete?: boolean;
  allowThreadEdit?: boolean;
  allowThreadDelete?: boolean;
  allowQuoteThread?: boolean;
  selfEditWindowMinutes?: number;
  maxBoardsPerAccount?: number | null;
}

export interface StaffEntry {
  accountId: string;
  name: string;
  level: "admin" | "deputy" | "moderator";
}

export interface BoardDetail extends BoardSummary {
  rulesMd?: string;
  design?: BoardDesign;
  settings?: BoardSettings;
  createdAt?: number;
  ownerAccountId?: string;
  staff?: StaffEntry[];
  canManage?: boolean;
}

export interface ThreadSummary {
  id: number;
  title: string;
  postCount: number;
  lastPostAt?: number | null;
  createdAt?: number;
  live?: boolean;
  pinned?: boolean;
  excerpt?: string;
  speed?: number;
}

export interface ThreadDetail {
  id: number;
  title: string;
  boardSlug: string;
  boardName?: string;
  postCount: number;
  maxPosts?: number;
  live?: boolean;
  pinned?: boolean;
  status?: string;
  quoteSourceId?: number | null;
  /** 板の状態（active/deleted。R74-05: インラインカードの閲覧ゲート用） */
  boardStatus?: string;
  createdAt?: number;
  lastPostAt?: number;
}

/** 引用元スレのカード（API GET /v1/threads/:id の quoteSource）。 */
export interface QuotedThreadCard {
  threadId: number;
  boardId: number | null;
  boardSlug: string | null;
  boardName: string | null;
  title: string;
  postCount: number;
  status: string;
  createdAt: number | null;
  unavailable: boolean;
}

/** 引用したスレの一覧の要素（API GET /v1/threads/:id/quotes）。 */
export interface ThreadQuoteRef {
  id: number;
  boardId: number;
  boardSlug: string;
  boardName: string;
  title: string;
  postCount: number;
  status: string;
  createdAt: number;
}

/** 編集履歴の 1 件。 */
export interface PostEditHistoryItem {
  id: number;
  postId: number;
  previousBody: string;
  editedAt: number;
}

export interface AttachmentRef {
  id?: string;
  url: string;
  contentType?: string;
  size?: number;
  name?: string;
  filename?: string;
}

export interface Post {
  id: number;
  num: number;
  name: string;
  trip?: string;
  cap?: string;
  mail?: string;
  sage?: boolean;
  body: string;
  /** Unix 秒。API が ISO 文字列を返した場合も normalize で秒に揃える。 */
  createdAt: number;
  idHash?: string;
  isOp?: boolean;
  isSub?: boolean;
  attachments?: AttachmentRef[];
  likeCount?: number;
  liked?: boolean;
  backlinks?: number[];
  kind?: "post" | "tsubuyaki";
  provider?: string;
  aiAgent?: { id?: string; name?: string } | null;
  hidden?: boolean;
  editedCount?: number;
  selfDeleted?: boolean;
  mine?: boolean;
}

export interface ThreadPage {
  thread: ThreadDetail;
  posts: Post[];
  hasMore?: boolean;
  quoteSource?: QuotedThreadCard | null;
}

export interface BoardListResponse {
  items: BoardSummary[];
  categories: string[];
}

export interface ThreadListResponse {
  items: ThreadSummary[];
  nextCursor?: string | null;
}

export interface RealtimeEvent {
  type: string;
  channel: string;
  seq?: number;
  at?: number;
  data?: unknown;
}

export const REASONS = [
  { value: "abuse", label: "荒らし・嫌がらせ" },
  { value: "spam", label: "宣伝・スパム" },
  { value: "offtopic", label: "板・スレ違い" },
  { value: "adult", label: "エロ・グロ" },
  { value: "csam", label: "児童ポルノ" },
  { value: "illegal", label: "違法行為" },
  { value: "other", label: "その他" },
] as const;

export type ReportReason = (typeof REASONS)[number]["value"];

export interface ReportItem {
  id: string | number;
  boardId?: number;
  boardSlug?: string;
  threadId?: number;
  threadTitle?: string;
  postIds?: number[];
  /** 対象レス番号の指定（`all` / `3,4,8` など）。 */
  nums?: string;
  reason?: string;
  comment?: string;
  status?: string;
  handledBy?: string | null;
  handledAt?: number | null;
  note?: string | null;
  createdAt?: number;
}

export const THREAD_MODES = [
  { value: "", label: "のーまる" },
  { value: "!no_id", label: "ID 非表示" },
  { value: "!sage", label: "強制 sage" },
  { value: "!oekaki", label: "お絵描き限定" },
  { value: "!timer", label: "タイマー（1時間で消滅）" },
] as const;