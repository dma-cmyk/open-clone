// 上限値・予約語の共通定数。変更は後方互換のみ可（WORKPACKAGES §1）。

// --- 掲示板 ---
/** 投稿本文の最大バイト数（UTF-8） */
export const POST_BODY_MAX_BYTES = 4096;
/** スレのレス上限（一般） */
export const THREAD_MAX_POSTS = 1000;
/** スレのレス上限（スレ主） */
export const THREAD_MAX_POSTS_OWNER = 1005;
/** 板の自動削除までの無投稿日数（おーぷぬ準拠） */
export const BOARD_AUTODELETE_DAYS = 7;
/** アカウントが作成できる板数の既定 */
export const BOARD_CREATE_LIMIT_PER_ACCOUNT = 5;
/** 表示IDの文字数（open2ch 実測 4 文字） */
export const DISPLAY_ID_LENGTH = 4;
/** トリップ桁数（2ch 互換 10 桁） */
export const TRIP_LENGTH = 10;
/** つぶやきの本文上限 */
export const TSUBUYAKI_MAX_BYTES = 100 * 3; // 100 文字（UTF-8 安全側バイト数で判定する実装に委ねる）
export const TSUBUYAKI_MAX_CHARS = 100;
/** 投票の選択肢上限 */
export const POLL_MAX_OPTIONS = 10;
/** ハッシュタグ: 1レス最大個数・最長 */
export const HASHTAG_MAX_PER_POST = 5;
export const HASHTAG_MAX_CHARS = 30;

// --- プラグイン ---
/** プラグインコード最大（D1 行 2MB 制限内の安全側） */
export const PLUGIN_CODE_MAX_BYTES = 512 * 1024;
/** plugin_state の scope あたり容量上限 */
export const PLUGIN_STATE_MAX_BYTES = 64 * 1024;
/** プラグイン AI 連携（ai:complete）の入力・出力上限。外部 API の課金と悪用を抑える。 */
export const PLUGIN_AI_PROMPT_MAX_CHARS = 4000;
export const PLUGIN_AI_SYSTEM_MAX_CHARS = 2000;
export const PLUGIN_AI_MAX_TOKENS = 512;
export const PLUGIN_AI_OUTPUT_MAX_CHARS = 8000;
/** 端末×プラグイン単位の日次上限（UTC 日）。 */
export const PLUGIN_AI_DAILY_LIMIT = 100;

// --- プラグイン作成支援（個人用トークン + テンプレート。報告書 28 §3.3/§5.2/§8.0） ---
/** プラグイン作成トークンの接頭辞。`ocai_`（AI 運営）と相互に受け付けない。 */
export const PLUGIN_TOKEN_PREFIX = "ocp_";
/** トークンの有効日数（発行から固定。延長は再発行）。 */
export const PLUGIN_TOKEN_TTL_DAYS = 90;
/** 1 アカウントあたりの同時有効トークン数。 */
export const PLUGIN_TOKEN_MAX_PER_ACCOUNT = 5;
/** トークン名の最大文字数。 */
export const PLUGIN_TOKEN_NAME_MAX_CHARS = 100;
/** 一覧表示用 prefix に含める接頭辞以降の文字数（`ocp_` + 8 文字）。 */
export const PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS = 8;
/** トークン経路の日次上限（UTC 日）。kind は下の PLUGIN_AUTHOR_USAGE_KINDS。 */
export const PLUGIN_AUTHOR_DAILY_LIMITS = {
  create: 10,
  version: 60,
  check: 120,
  publish: 20,
} as const;
export type PluginAuthorUsageKind = keyof typeof PLUGIN_AUTHOR_DAILY_LIMITS;
export const PLUGIN_AUTHOR_USAGE_KINDS = [
  "create",
  "version",
  "check",
  "publish",
] as const satisfies readonly PluginAuthorUsageKind[];
/** 本人が保有できる status='draft' のプラグイン数。 */
export const PLUGIN_AUTHOR_DRAFT_LIMIT = 50;
/** トークン経路で受け付けるコードの上限（既存 PLUGIN_CODE_MAX_BYTES より厳しい）。 */
export const PLUGIN_AUTHOR_CODE_MAX_BYTES = 64 * 1024;
/** テンプレート生成コードの上限（CI のユニットテストで保証する）。 */
export const PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES = 32 * 1024;

// --- アップロード ---
/** Worker プロキシ中継の実質上限（CF Free 受信ボディ 100MB 制限より安全側） */
export const UPLOAD_PROXY_MAX_BYTES = 95 * 1024 * 1024;
/** Cloudinary direct の既定上限 */
export const UPLOAD_CLOUDINARY_MAX_BYTES = 10 * 1024 * 1024;
/** アップロード履歴の表示件数（open2ch 準拠） */
export const UPLOAD_HISTORY_LIMIT = 50;

// --- 認証 ---
/** 端末 Cookie 名 */
export const DEVICE_COOKIE = "oc_did";
/** セッション Cookie 名 */
export const SESSION_COOKIE = "oc_sess";
/** セッション有効日数（スライディング） */
export const SESSION_TTL_DAYS = 30;
/** PBKDF2-SHA256 反復回数。Workers Free の PBKDF2 上限 100k・CPU 10ms 制約からの確定値（DESIGN §A-1） */
export const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
/** TOTP パラメータ（RFC 6238 / 要件固定） */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
/** TOTP 連続失敗ロック */
export const TOTP_MAX_FAILURES = 5;
export const TOTP_LOCK_MINUTES = 15;
export const RECOVERY_CODE_COUNT = 10;
/** 特別管理人就任キーの既定有効時間 */
export const INVITE_TTL_HOURS = 72;
/**
 * 就任キー accept の TOTP 失敗許容（キー単位・IP 単位）。DESIGN §5.5 のログイン TOTP と同水準。
 * キー単位で上限に達したらキーを失効させる（総当たりを現実的に不可能にする）。
 */
export const INVITE_TOTP_MAX_FAILURES = 5;
export const INVITE_TOTP_IP_MAX_FAILURES = 10;
export const INVITE_TOTP_FAILURE_WINDOW_SECONDS = 15 * 60;
/** prepare-totp の発行上限（キー単位・IP 単位・15 分窓）。 */
export const INVITE_PREPARE_MAX_PER_KEY = 5;
export const INVITE_PREPARE_MAX_PER_IP = 10;

/**
 * 所有者ブートストラップ（`POST /v1/admin/owner/setup`）の誤キー試行上限（IP 単位・15 分窓）。
 * 正しいキーでの初回セットアップは 1 回で通るため妨げない（誤キーだけを数える）。
 * L-1（報告書 24）。
 */
export const OWNER_SETUP_MAX_FAILURES = 5;
export const OWNER_SETUP_FAILURE_WINDOW_SECONDS = 15 * 60;

// --- リアルタイム ---
/** WS ticket の有効秒数・単回使用 */
export const RT_TICKET_TTL_SECONDS = 30;
/** RealtimeHub DO が保持するイベントのリングバッファ件数 */
export const RT_RING_BUFFER_SIZE = 100;

// --- レート制限（RateLimiter DO の窓定義。秒/回数） ---
export const RATE_LIMITS = {
  post: { windowSeconds: 30, max: 3 },
  threadCreate: { windowSeconds: 300, max: 2 },
  tsubuyaki: { windowSeconds: 10, max: 5 },
  login: { windowSeconds: 300, max: 10 },
  register: { windowSeconds: 86_400, max: 5 },
  report: { windowSeconds: 300, max: 5 },
  upload: { windowSeconds: 86_400, max: 50 },
  aiAction: { windowSeconds: 60, max: 30 },
  /** プラグイン AI 連携（端末×プラグイン）。日次上限は plugin_ai_usage で別途制御。 */
  pluginAi: { windowSeconds: 60, max: 10 },
  /** プラグイン作成トークン（トークン単位）。日次上限は plugin_author_usage で別途制御。 */
  pluginAuthor: { windowSeconds: 60, max: 30 },
  /**
   * IP 単位の併用窓（Cookie を保存しないクライアントでも有効。H-3）。
   * pipeline では匿名（accountId なし）のみに適用する。ログイン済みは account/device で
   * 追跡・停止できるため、家庭・社内 NAT の正規利用を巻き込まない。
   * 匿名 1 IP あたり投稿 40/5分（≒11.5k/日）・スレ作成 12/5分・つぶやき 30/分を上限とする。
   * Cookie を毎回ランダムにしても IP 窓で頭打ちになる。
   */
  postIp: { windowSeconds: 300, max: 40 },
  threadCreateIp: { windowSeconds: 300, max: 12 },
  tsubuyakiIp: { windowSeconds: 60, max: 30 },
  uploadIp: { windowSeconds: 86_400, max: 100 },
  /**
   * 読み取り系の IP 窓。専ブラの通常運用を妨げない値:
   * - compat は subject.txt / dat / SETTING を数秒おきに取得する。10 板を 3 秒間隔で
   *   ポーリングしても 200 req/min 程度なので、180 req/min（3 req/s）を上限にする。
   * - search は人手の検索（数十回/分）より十分大きい 30 req/min。
   * - ranking/headline はトップ画面のポーリングを想定し 60 req/min。
   * - rt ticket は接続 1 回につき 1 枚。再接続を含め 30 req/min。
   * - list（板一覧・スレ一覧・プラグイン一覧）はサイドバーや板・スレ遷移のたびに 1 回呼ばれる。
   *   人間が 2 秒に 1 画面のペースで 1 画面あたり 2 回叩いても 60 req/min 程度、実況中の
   *   閲覧（15 秒間隔の stats ポーリング + 遷移）を加えても 100 req/min 未満に収まる。
   *   通常利用の 2 倍以上の余裕をみて 120 req/min（2 req/s）を上限にする。
   */
  readCompat: { windowSeconds: 60, max: 180 },
  readSearch: { windowSeconds: 60, max: 30 },
  readRanking: { windowSeconds: 60, max: 60 },
  readList: { windowSeconds: 60, max: 120 },
  rtTicket: { windowSeconds: 60, max: 30 },
} as const;

// --- API ---
export const API_BASE_PATH = "/v1";
/** 一覧系の既定/最大件数 */
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;

/**
 * 板スラッグ予約語。静的ルート・互換 URL と衝突する名前は板名に使えない。
 * `/test/*` は open2ch 互換 URL（read.cgi 等）を web 側で受けるため予約。
 */
export const RESERVED_BOARD_SLUGS = [
  "api",
  "admin",
  "account",
  "b",
  "boards",
  "compat",
  "headline",
  "mcp",
  "menu",
  "plugins",
  "ranking",
  "rt",
  "search",
  "settings",
  "test",
] as const;
