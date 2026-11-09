#!/usr/bin/env node
// README / docs 用スクリーンショットのデモデータ投入。
//
// 前提: e2e と同じローカル専用スタック（wrangler dev + ローカル D1）。
// 起動例（リポジトリルート）:
//   bash e2e/scripts/start-api.sh --setup-only   # state-e2e を用意する場合
//   SHOT_API_URL=http://127.0.0.1:8852 SHOT_ORIGIN=http://localhost:3152 \
//     node e2e/scripts/seed-demo-shots.mjs
//
// - 外部サービスへは一切アクセスしない（すべてローカル API への fetch）。
// - 実在の人物・サイト・他人の書き込みは使わない。すべてこのスクリプト内の創作テキスト。
// - 再実行しても板・スレは slug / タイトルで判定して重複作成しない（レス・いいねは新規スレのみ）。
// - セッションは e2e/fixtures/seed.sql のローカル専用固定トークン（本番 DB では使えない）。

const API = (process.env.SHOT_API_URL ?? "http://127.0.0.1:8852").replace(/\/$/, "");
const ORIGIN = (process.env.SHOT_ORIGIN ?? "http://localhost:3152").replace(/\/$/, "");
const SESSION = process.env.SHOT_SESSION_TOKEN ?? "e2e-owner-session-token";

let deviceSeq = 0;
function deviceId() {
  deviceSeq += 1;
  const hex = (n, width) => n.toString(16).padStart(width, "0");
  const stamp = BigInt(Date.now()) * 1000n + BigInt(deviceSeq);
  return `${hex(Number(stamp & 0xffffffffn), 8)}${hex(Number((stamp >> 32n) & 0xffffffffn), 8)}${hex(
    Math.floor(Math.random() * 0xffffffff),
    8,
  )}${hex(deviceSeq, 8)}`;
}

async function call(method, path, { body, session = true, ip } = {}) {
  const headers = {
    Origin: ORIGIN,
    // 端末・IP ごとにレート制限窓を分ける（ローカルの一括投入専用）。
    Cookie: `oc_did=${deviceId()}${session ? `; oc_sess=${SESSION}` : ""}`,
    "x-real-ip": ip ?? `198.51.100.${(deviceSeq % 200) + 1}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || json.ok !== true) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

// ─────────────────────────── デモ内容（すべて創作） ───────────────────────────

const BOARDS = [
  {
    slug: "zatsudan",
    name: "雑談",
    category: "生活",
    description: "日々の出来事や思ったことを、ゆっくり話す板です。",
    rules: "1. 相手が嫌がる書き込みはしない\n2. 個人を特定できる情報は書かない\n3. 宣伝・勧誘は禁止",
    threads: [
      {
        title: "今日の昼ごはん何食べた？",
        name: "昼休み",
        body: "近くの店で日替わり定食を食べた。今日は焼き魚と味噌汁で、ご飯が進んだ。\nみんなは何食べた？",
        replies: [
          { name: "名無しさん", body: "家で昨日の残りのカレー。ルーが少なかったからご飯多めで調整した。" },
          { name: "通りすがり#hanabi", body: "ざるそば。暑かったからちょうどよかった。薬味はわさびだけ。", likes: 3 },
          { name: "昼休み", body: ">>2 残りカレーは次の日がいちばんおいしい。" },
          { name: "名無しさん", body: "パン屋で買ったサンドイッチ。具が多くて食べにくかったけど満足。", likes: 2 },
          { name: "名無しさん", body: "弁当に卵焼きを入れた。甘いのとしょっぱいの、どっちが好き？" },
        ],
      },
      {
        title: "朝起きられない人集まれ",
        name: "夜更かし",
        body: "目覚ましを3回止めて二度寝してしまう。起きるコツがあったら知りたい。",
        replies: [
          { name: "名無しさん", body: "カーテンを少し開けて寝ると、光で目が覚めやすい。", likes: 5 },
          { name: "名無しさん", body: "起きたらすぐ白湯を飲む。体が動き出す感じがする。" },
          { name: "通りすがり", body: "夜にスマホを触らないだけで全然違う。" },
          { name: "夜更かし", body: ">>4 それがいちばん難しい。" },
        ],
      },
      {
        title: "週末の予定を語るスレ",
        name: "週末さん",
        body: "土曜は家の片付け、日曜は近所を散歩する予定。遠出はしない。",
        replies: [
          { name: "名無しさん", body: "布団を干して、本を読む。天気が良ければ公園にも行きたい。" },
          { name: "名無しさん", body: "友だちと昼ごはんの約束をした。何を食べるかはまだ決めていない。" },
          { name: "通りすがり#hanabi", body: "映画を1本観る。配信で気になっていたやつ。" },
          { name: "週末さん", body: ">>4 感想を書いてくれると嬉しい。" },
        ],
      },
      {
        title: "最近買ってよかった小物",
        name: "名無しさん",
        body: "1000円くらいの置き時計を買った。部屋に時計があるだけで時間の感覚が変わる。",
        replies: [
          { name: "名無しさん", body: "文房具のペンケース。毎日使うものは少し良いものにすると気分が上がる。", likes: 4 },
          { name: "名無しさん", body: "折りたたみの傘。持ち歩くのが苦にならなくなった。" },
          { name: "名無しさん", body: ">>2 毎日使うものは大事。わかる。" },
        ],
      },
    ],
  },
  {
    slug: "game",
    name: "ゲーム",
    category: "趣味",
    description: "遊んだゲームの感想、攻略、協力プレイの募集など。",
    rules: "1. ネタバレは [spoiler] で囲む\n2. 個人情報・連絡先の交換はしない\n3. 売買・アカウント譲渡は禁止",
    threads: [
      {
        title: "最近遊んだゲームの感想を書くスレ",
        name: "ゲーマー",
        body: "短めのパズルゲームを遊んだ。1ステージ5分くらいで、寝る前にちょうどいい。\n最近遊んだものの感想を書いていこう。",
        replies: [
          { name: "名無しさん", body: "街づくりゲームを始めた。道路を引くだけで時間が溶ける。", likes: 6 },
          { name: "通りすがり", body: "協力プレイのゲームを友だちと。役割分担がうまく決まると気持ちいい。", likes: 3 },
          { name: "ゲーマー", body: ">>2 道路と水路を引く作業、わかる。気づくと夜。" },
          { name: "名無しさん", body: "積んでるゲームを1本クリアした。短くて満足度が高かった。" },
        ],
      },
      {
        title: "積みゲー消化報告",
        name: "積みゲー",
        body: "セールで買ったまま遊んでいないものを、月に1本ずつ消化する目標を立てた。",
        replies: [
          { name: "名無しさん", body: "まずは短いものから。10時間以内で終わるやつ。" },
          { name: "名無しさん", body: "メモを付けておくと、間が空いても戻りやすい。", likes: 4 },
          { name: "積みゲー", body: ">>3 メモはいい。どこまで進んだか忘れがち。" },
          { name: "名無しさん", body: "積んでいる本数は数えないことにしている。" },
        ],
      },
      {
        title: "実況：週末のオンライン大会をみんなで見る !live",
        name: "観戦者",
        body: "今夜の大会をみんなで見ながら話すスレ。\n感想は つぶやき にも書いていこう。",
        tsubuyaki: [
          { name: "観戦者", body: "始まった" },
          { name: "名無しさん", body: "初戦から接戦で面白い" },
          { name: "通りすがり", body: "この展開は読めなかった" },
          { name: "名無しさん", body: "今のプレーは何度も見返したい" },
          { name: "観戦者", body: "ここで決まるか？" },
          { name: "名無しさん", body: "ナイスプレー" },
          { name: "名無しさん", body: "次の試合も楽しみ" },
          { name: "通りすがり", body: "実況を見ながらだと時間がたつのが早い" },
        ],
        replies: [
          { name: "名無しさん", body: "初戦から接戦で面白い。" },
          { name: "通りすがり", body: "この展開は読めなかった。" },
          { name: "名無しさん", body: "今のプレーは何度も見返したい。", likes: 2 },
          { name: "観戦者", body: "つぶやきが流れてくるの便利だ。" },
        ],
      },
    ],
  },
  {
    slug: "cooking",
    name: "料理",
    category: "生活",
    description: "今日のごはん、簡単レシピ、キッチンの道具について。",
    rules: "1. アレルギー・健康に関わる指示は自己責任で\n2. 他サイトの文章の丸写しはしない\n3. 店舗・商品の宣伝は禁止",
    threads: [
      {
        title: "簡単に作れる夜ごはん",
        name: "料理好き",
        body: "仕事から帰ってから20分で作れるもの。今日は豚肉とキャベツの炒め物。\n塩とこしょうだけでも十分おいしい。",
        replies: [
          { name: "名無しさん", body: "卵とじ丼。玉ねぎを薄切りにして、めんつゆで煮るだけ。", likes: 8 },
          { name: "名無しさん", body: "豆腐とわかめの味噌汁に、冷凍ご飯。手間が少ない。" },
          { name: "料理好き", body: ">>2 卵とじは失敗が少ないからいい。" },
          { name: "通りすがり", body: "トマトとツナのパスタ。にんにくを少し入れると香りが出る。" },
        ],
      },
      {
        title: "冷蔵庫の余り物で作ったもの",
        name: "冷蔵庫係",
        body: "半分残ったにんじんと、使いかけのキャベツで野菜スープ。\nコンソメと塩だけで味を決めた。",
        replies: [
          { name: "名無しさん", body: "余ったご飯でおにぎり。中に梅干しを入れた。", likes: 5 },
          { name: "名無しさん", body: "きのこ数種類をバターで炒めて、しょうゆを少し。" },
          { name: "名無しさん", body: "余り物を鍋に入れるだけの日もある。おいしければいい。" },
          { name: "冷蔵庫係", body: ">>4 それでいいと思う。" },
        ],
      },
      {
        title: "コーヒーの淹れ方いろいろ",
        name: "珈琲",
        body: "豆を買ってきて自分で淹れるようになった。お湯の温度で味が変わるのが面白い。",
        replies: [
          { name: "名無しさん", body: "90度くらいから試すと飲みやすい。", likes: 3 },
          { name: "名無しさん", body: "ミルは手回しのものを使っている。音が静かで朝でも気にならない。" },
          { name: "珈琲", body: ">>2 沸かしたてだと熱すぎるので、少し待つようにしている。" },
          { name: "名無しさん", body: "休日にゆっくり淹れる時間が好き。" },
        ],
      },
    ],
  },
  {
    slug: "gadget",
    name: "ガジェット",
    category: "趣味",
    description: "PC・スマホ・周辺機器の買い物と使用感について。",
    rules: "1. 型番と使用期間を書くと話が早い\n2. 個人情報・注文番号は書かない\n3. 転売目的の書き込みは禁止",
    threads: [
      {
        title: "キーボードを買い替えた",
        name: "道具好き",
        body: "静かなキーボードに替えた。夜に打っても家族に気づかれない。\n配列に慣れるまでは少し時間がかかりそう。",
        replies: [
          { name: "名無しさん", body: "静音タイプは疲れにくい気がする。" },
          { name: "名無しさん", body: "慣れるまでは誤入力が増えるけど、1週間で戻る。", likes: 4 },
          { name: "道具好き", body: ">>3 1週間は我慢してみる。" },
          { name: "名無しさん", body: "リストレストを足すと楽になる。" },
        ],
      },
      {
        title: "イヤホン何使ってる？",
        name: "音楽好き",
        body: "通勤用に小さいワイヤレスイヤホンを探している。遮音性と電池持ちが気になる。",
        replies: [
          { name: "名無しさん", body: "片耳だけでも使えるタイプが便利。" },
          { name: "通りすがり", body: "落とさないようにケースにしまう癖をつけている。" },
          { name: "名無しさん", body: "有線に戻ったら、充電を気にしなくて楽だった。", likes: 2 },
          { name: "音楽好き", body: ">>4 それもありだな。" },
        ],
      },
      {
        title: "スマホの写真整理どうしてる？",
        name: "写真",
        body: "撮りっぱなしの写真が増えてきた。月に一度、アルバムにまとめるようにしている。",
        replies: [
          { name: "名無しさん", body: "似た写真を消すだけでかなり減る。", likes: 3 },
          { name: "名無しさん", body: "旅行ごとにフォルダを分けると探しやすい。" },
          { name: "写真", body: ">>3 分けるのいいね。後で見返すのが楽になる。" },
        ],
      },
    ],
  },
];

// ─────────────────────────── 投入 ───────────────────────────

async function likeCount(postId, count) {
  for (let i = 0; i < count; i += 1) {
    await call("POST", `/v1/posts/${postId}/like`, { body: { kind: "like" }, session: false });
  }
}

async function main() {
  const existing = await call("GET", "/v1/boards?limit=100", { session: false });
  const boardBySlug = new Map((existing.items ?? []).map((board) => [board.slug, board]));
  const summary = [];

  for (const spec of BOARDS) {
    let board = boardBySlug.get(spec.slug);
    if (!board) {
      const created = await call("POST", "/v1/boards", {
        body: {
          slug: spec.slug,
          name: spec.name,
          category: spec.category,
          description: spec.description,
          rulesMd: spec.rules,
          settings: { cooldownSeconds: 0, turnstile: "off" },
        },
      });
      board = created.board ?? created;
      boardBySlug.set(spec.slug, board);
      console.log(`[seed] 板を作成: ${spec.name} (${spec.slug})`);
    } else {
      console.log(`[seed] 板は既にあります: ${spec.name} (${spec.slug})`);
      if (board.category !== spec.category) {
        await call("PATCH", `/v1/boards/${spec.slug}`, { body: { category: spec.category } });
        console.log(`[seed] カテゴリを更新: ${spec.slug} -> ${spec.category}`);
      }
    }

    const listed = await call("GET", `/v1/boards/${spec.slug}/threads?limit=100`, { session: false });
    const titles = new Set((listed.items ?? []).map((thread) => thread.title));

    for (const thread of spec.threads) {
      const normalized = thread.title.replace(/\s+!live\s*$/, "").trim();
      if (titles.has(normalized)) {
        console.log(`[seed] スレは既にあります: ${normalized}`);
        continue;
      }
      const created = await call("POST", `/v1/boards/${spec.slug}/threads`, {
        body: { title: thread.title, body: thread.body, name: thread.name },
      });
      const threadId = created.threadId;
      const opId = created.post?.id;
      if (opId) await likeCount(opId, 2);
      let lastPostId = opId;

      for (const reply of thread.replies) {
        const posted = await call("POST", `/v1/threads/${threadId}/posts`, {
          body: { name: reply.name, body: reply.body },
        });
        lastPostId = posted.post?.id;
        if (lastPostId && reply.likes) await likeCount(lastPostId, reply.likes);
      }
      for (const comment of thread.tsubuyaki ?? []) {
        await call("POST", `/v1/threads/${threadId}/tsubuyaki`, {
          body: { name: comment.name, body: comment.body },
        });
      }
      console.log(`[seed] スレを作成: ${normalized} (id=${threadId}, レス=${thread.replies.length + 1})`);
      summary.push({ slug: spec.slug, threadId, title: normalized });
    }
  }

  // AI 運営ダッシュボード用の所有者（ローカルの demo アカウント）で AI 管理者を登録する。
  const agentList = await call("GET", "/v1/ai/agents");
  const agentNames = new Set((agentList.items ?? []).map((agent) => agent.name));
  for (const spec of [BOARDS[0], BOARDS[1]]) {
    const board = boardBySlug.get(spec.slug);
    const name = `${spec.slug}-ops`;
    if (agentNames.has(name)) continue;
    await call("POST", "/v1/ai/agents", {
      body: {
        name,
        displayName: "AI運営",
        description: `${spec.name}板の日常管理（挨拶・案内・通報の一次対応）`,
        ownerType: "board",
        boardId: Number(board?.id) || undefined,
        allowedBoards: board?.id ? [Number(board.id)] : [],
        riskCap: "medium",
        rateLimitPerMin: 30,
        dailyLimit: 2000,
      },
    });
    console.log(`[seed] AI 管理者を登録: ${name}`);
  }

  // 画面に固有のアカウント名が写らないよう、seed.sql のローカル所有者を demo にする。
  const me = await call("GET", "/v1/accounts/me");
  if (me.profile?.name === "owner") {
    await call("PATCH", "/v1/accounts/me", { body: { name: "demo" } });
    console.log("[seed] ローカル所有者の表示名を demo に変更");
  }

  console.log(`[seed] 完了: 板 ${BOARDS.length} / 新規スレ ${summary.length}`);
}

main().catch((error) => {
  console.error(`[seed] 失敗: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});