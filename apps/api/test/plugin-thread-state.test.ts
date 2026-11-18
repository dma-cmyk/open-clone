// スレごとの共有値（storage:thread）の API 統合テスト。
// B-3 の各ルール（宣言・有効・K2・1 人 1 回・who:login・IP 上限・回数・本文）を
// 破ったときの応答を 1 つずつ確認する。

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalizeManifest, randomHex, ulid, type PluginManifest } from "shared";
import { addBoardStaff, api, json, makeAccount, makeBoard, makeSession, makeThread } from "./ai-helpers";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

interface TallyState {
  kind: "tally";
  count: number;
  mine: boolean;
}

interface ChoiceState {
  kind: "choice";
  options: string[];
  counts: number[];
  mine: number | null;
}

interface EntryItem {
  id: string;
  label: string;
  text: string;
  createdAt: number;
  mine: boolean;
}

interface EntriesState {
  kind: "entries";
  items: EntryItem[];
  total: number;
}

type Actor = { cookie: string; headers?: Record<string, string> };

const BASE_MANIFEST = {
  version: "1.0.0",
  summary: "スレごとの共有値のテスト",
  scope: ["personal", "board", "site"],
  permissions: ["ui:slot", "storage:thread"],
  slots: ["thread-head"],
  threadState: [
    { key: "join", kind: "tally", who: "anyone" },
    { key: "poll", kind: "choice", who: "anyone", options: ["A", "B", "C"] },
    { key: "memo", kind: "entries", who: "anyone", maxPerActor: 1, maxEntries: 200, maxLength: 50 },
    { key: "loginjoin", kind: "tally", who: "login" },
  ],
};

let ipCounter = 0;
/** テストごとに別の IP を割り当てる（IP 上限・readList 窓をテスト間で共有しない）。 */
function anon(): Actor {
  ipCounter += 1;
  return {
    cookie: `oc_did=${randomHex(16)}`,
    headers: { "cf-connecting-ip": `198.51.102.${ipCounter}` },
  };
}

async function login(role: "owner" | "user" = "user"): Promise<string> {
  return makeSession(await makeAccount({ role }));
}

let cachedOwner: string | null = null;
/** owner は 1 アカウントだけ（0603 の一意索引）。テストファイル内で使い回す。 */
async function ownerSession(): Promise<string> {
  if (cachedOwner) return cachedOwner;
  const existing = await env.DB.prepare("SELECT id FROM accounts WHERE role = 'owner' LIMIT 1").first<{
    id: string;
  }>();
  const accountId = existing?.id ?? (await makeAccount({ role: "owner" }));
  cachedOwner = await makeSession(accountId);
  return cachedOwner;
}

interface Fixture {
  slug: string;
  boardId: number;
  threadId: number;
  pluginId: string;
  owner: string;
  user: string;
  userAccountId: string;
  other: string;
}

/** 板・スレ・承認済みプラグイン（板スコープ導入）を毎テスト新しく作る。 */
async function setup(options: { versions?: PluginManifest[]; installVersion?: string } = {}): Promise<Fixture> {
  const owner = await ownerSession();
  const userAccountId = await makeAccount({ role: "user" });
  const user = await makeSession(userAccountId);
  const other = await login("user");
  const slug = `ts-${randomHex(4)}`;
  const boardId = await makeBoard({
    slug,
    settings: { turnstile: "off", ngWords: ["ngword"], ngWordAction: "reject" },
  });
  const threadId = await makeThread({ boardId });

  const pluginId = ulid();
  const name = `thread-state-${pluginId.slice(-8).toLowerCase()}`;
  const versions = options.versions ?? [
    { ...BASE_MANIFEST, name, version: "1.0.0" } as unknown as PluginManifest,
  ];
  const latest = versions[versions.length - 1]!;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO plugins
       (id, name, summary, manifest_json, scopes, status, visibility, latest_version, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, 'personal,board,site', 'published', 'public', ?, ?, ?, ?)`,
  )
    .bind(pluginId, name, "スレごとの共有値", JSON.stringify(normalizeManifest(latest)), latest.version, now, now, now)
    .run();
  for (const version of versions) {
    await env.DB.prepare(
      `INSERT INTO plugin_versions
         (plugin_id, version, code, code_hash, manifest_json, status, created_at)
       VALUES (?, ?, '', ?, ?, 'approved', ?)`,
    )
      .bind(pluginId, version.version, "0".repeat(64), JSON.stringify(normalizeManifest(version)), now)
      .run();
  }
  const installVersion = options.installVersion ?? versions[0]!.version;
  await env.DB.prepare(
    `INSERT INTO plugin_installs
       (id, plugin_id, scope, scope_ref, version, enabled, created_at, updated_at)
     VALUES (?, ?, 'board', ?, ?, 1, ?, ?)`,
  )
    .bind(ulid(), pluginId, String(boardId), installVersion, now, now)
    .run();

  return { slug, boardId, threadId, pluginId, owner, user, userAccountId, other };
}

function statePath(fx: Fixture, key: string): string {
  return `/v1/plugins/${fx.pluginId}/threads/${fx.threadId}/state/${key}`;
}

async function readState<T>(fx: Fixture, key: string, actor: Actor): Promise<{ status: number; body: Envelope<T> }> {
  const response = await api(statePath(fx, key), { method: "GET", ...actor });
  return { status: response.status, body: await json<Envelope<T>>(response) };
}

describe("プラグインのスレごとの共有値", () => {
  it("manifest で宣言していない key は 400", async () => {
    const fx = await setup();
    const result = await readState<unknown>(fx, "unknown", { cookie: fx.user });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("VALIDATION");
  });

  it("who:login の key を未ログインで使うと 401", async () => {
    const fx = await setup();
    const result = await readState<unknown>(fx, "loginjoin", anon());
    expect(result.status).toBe(401);
    expect(result.body.code).toBe("UNAUTHORIZED");
  });

  it("その板でプラグインが有効でなければ 403", async () => {
    const fx = await setup();
    // 板導入を外す（所有者の個人プレビューでもない一般ユーザーは使えない）
    await env.DB.prepare("DELETE FROM plugin_installs WHERE plugin_id = ?").bind(fx.pluginId).run();
    const result = await readState<unknown>(fx, "join", { cookie: fx.user });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("FORBIDDEN");
  });

  it("存在しないスレは 404", async () => {
    const fx = await setup();
    const response = await api(`/v1/plugins/${fx.pluginId}/threads/99999999/state/join`, {
      method: "GET",
      cookie: fx.user,
    });
    expect(response.status).toBe(404);
  });

  it("削除済みの板は一般に 404、書き込みは 409（板スタッフは読める）", async () => {
    const fx = await setup();
    await env.DB.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(fx.boardId).run();

    const anonRead = await readState<unknown>(fx, "join", anon());
    expect(anonRead.status).toBe(404);

    const staffRead = await readState<unknown>(fx, "join", { cookie: fx.owner });
    expect(staffRead.status).toBe(200);

    const write = await api(`${statePath(fx, "join")}/tally`, {
      method: "PUT",
      cookie: fx.owner,
      body: { on: true },
    });
    expect(write.status).toBe(409);
  });

  it("tally は冪等で、2 回目のオンで数が増えない", async () => {
    const fx = await setup();
    const first = await api(`${statePath(fx, "join")}/tally`, {
      method: "PUT",
      cookie: fx.user,
      body: { on: true },
    });
    expect(first.status).toBe(200);
    expect((await json<Envelope<TallyState>>(first)).data).toMatchObject({ count: 1, mine: true });

    const second = await api(`${statePath(fx, "join")}/tally`, {
      method: "PUT",
      cookie: fx.user,
      body: { on: true },
    });
    expect((await json<Envelope<TallyState>>(second)).data).toMatchObject({ count: 1, mine: true });

    const off = await api(`${statePath(fx, "join")}/tally`, {
      method: "PUT",
      cookie: fx.user,
      body: { on: false },
    });
    expect((await json<Envelope<TallyState>>(off)).data).toMatchObject({ count: 0, mine: false });
  });

  it("choice は 1 人 1 票で、選び直し・取り消しができる", async () => {
    const fx = await setup();
    const choose = async (option: number | null) => {
      const response = await api(`${statePath(fx, "poll")}/choice`, {
        method: "PUT",
        cookie: fx.user,
        body: { option },
      });
      expect(response.status).toBe(200);
      return (await json<Envelope<ChoiceState>>(response)).data!;
    };

    expect(await choose(0)).toMatchObject({ counts: [1, 0, 0], mine: 0 });
    expect(await choose(1)).toMatchObject({ counts: [0, 1, 0], mine: 1 });
    expect(await choose(null)).toMatchObject({ counts: [0, 0, 0], mine: null });

    const invalid = await api(`${statePath(fx, "poll")}/choice`, {
      method: "PUT",
      cookie: fx.user,
      body: { option: 9 },
    });
    expect(invalid.status).toBe(400);
  });

  it("entries は自分のものだけ削除でき、他人は 403", async () => {
    const fx = await setup();
    const created = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "参加します" },
    });
    expect(created.status).toBe(201);
    const state = (await json<Envelope<EntriesState>>(created)).data!;
    const entryId = state.items[0]!.id;
    expect(state.items[0]!.mine).toBe(true);

    const other = await api(`${statePath(fx, "memo")}/entries/${entryId}`, {
      method: "DELETE",
      cookie: fx.other,
    });
    expect(other.status).toBe(403);

    const own = await api(`${statePath(fx, "memo")}/entries/${entryId}`, {
      method: "DELETE",
      cookie: fx.user,
    });
    expect(own.status).toBe(200);
    expect((await json<Envelope<EntriesState>>(own)).data!.items).toHaveLength(0);
  });

  it("entries は 1 人の上限（maxPerActor）を超えると 409", async () => {
    const fx = await setup();
    const first = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "1 件目" },
    });
    expect(first.status).toBe(201);
    const second = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "2 件目" },
    });
    expect(second.status).toBe(409);
  });

  it("entries の本文は長さ・制御文字・NG ワードをレスの本文と同じように処理する", async () => {
    const fx = await setup();
    const tooLong = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "あ".repeat(51) },
    });
    expect(tooLong.status).toBe(400);

    const ng = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "ngword を含む" },
    });
    expect(ng.status).toBe(400);

    const cleaned = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "\u0007こんにちは\u0000" },
    });
    expect(cleaned.status).toBe(201);
    const state = (await json<Envelope<EntriesState>>(cleaned)).data!;
    expect(state.items[0]!.text).toBe("こんにちは");
  });

  it("entries は HTML を文字としてそのまま保存する（サーバーで実体化しない）", async () => {
    const fx = await setup();
    const text = '<img src=x onerror="alert(1)">';
    const created = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text },
    });
    expect(created.status).toBe(201);
    const state = (await json<Envelope<EntriesState>>(created)).data!;
    expect(state.items[0]!.text).toBe(text);
  });

  it("他人の actor_key / ip_hash は応答に含めない", async () => {
    const fx = await setup();
    await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "識別子を出さない" },
    });
    const read = await readState<EntriesState>(fx, "memo", anon());
    expect(read.status).toBe(200);
    const serialized = JSON.stringify(read.body);
    expect(serialized).not.toContain("actor_key");
    expect(serialized).not.toContain("ip_hash");
    expect(serialized).not.toContain(fx.user);
  });

  it("未ログインの tally は同じ IP で 3 人まで（4 人目は 429）", async () => {
    const fx = await setup();
    const ip = `203.0.113.${++ipCounter}`;
    for (let index = 0; index < 3; index++) {
      const actor = { cookie: `oc_did=${randomHex(16)}`, headers: { "cf-connecting-ip": ip } };
      const response = await api(`${statePath(fx, "join")}/tally`, {
        method: "PUT",
        ...actor,
        body: { on: true },
      });
      expect(response.status, `actor ${index}`).toBe(200);
    }
    const fourth = await api(`${statePath(fx, "join")}/tally`, {
      method: "PUT",
      cookie: `oc_did=${randomHex(16)}`,
      headers: { "cf-connecting-ip": ip },
      body: { on: true },
    });
    expect(fourth.status).toBe(429);
  });

  it("未ログインの entries は同じ IP で maxPerActor×3 件まで（超えると 429）", async () => {
    const fx = await setup();
    const ip = `203.0.114.${++ipCounter}`;
    for (let index = 0; index < 3; index++) {
      const response = await api(`${statePath(fx, "memo")}/entries`, {
        method: "POST",
        cookie: `oc_did=${randomHex(16)}`,
        headers: { "cf-connecting-ip": ip },
        body: { text: `投稿 ${index}` },
      });
      expect(response.status, `entry ${index}`).toBe(201);
    }
    const fourth = await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: `oc_did=${randomHex(16)}`,
      headers: { "cf-connecting-ip": ip },
      body: { text: "4 件目" },
    });
    expect(fourth.status).toBe(429);
  });

  it("書き込みは 1 人 1 分 30 回まで（31 回目は 429）", async () => {
    const fx = await setup();
    const actor = { cookie: fx.user, headers: { "cf-connecting-ip": `203.0.115.${++ipCounter}` } };
    for (let index = 0; index < 30; index++) {
      const response = await api(`${statePath(fx, "join")}/tally`, {
        method: "PUT",
        ...actor,
        body: { on: index % 2 === 0 },
      });
      expect(response.status, `call ${index}`).toBe(200);
    }
    const blocked = await api(`${statePath(fx, "join")}/tally`, {
      method: "PUT",
      ...actor,
      body: { on: true },
    });
    expect(blocked.status).toBe(429);
  });

  it("サーバーは最新版ではなく導入版の manifest を読む", async () => {
    const name = `thread-state-v-${randomHex(4)}`;
    const v1 = {
      ...BASE_MANIFEST,
      name,
      version: "1.0.0",
      threadState: [{ key: "other", kind: "tally", who: "anyone" }],
    } as unknown as PluginManifest;
    const v2 = { ...BASE_MANIFEST, name, version: "2.0.0" } as unknown as PluginManifest;
    const fx = await setup({ versions: [v1, v2], installVersion: "1.0.0" });

    const declaredInV2 = await readState<unknown>(fx, "join", { cookie: fx.user });
    expect(declaredInV2.status).toBe(400);
    const declaredInV1 = await readState<TallyState>(fx, "other", { cookie: fx.user });
    expect(declaredInV1.status).toBe(200);
  });

  it("key を空にできるのは板スタッフ以上だけ（403 → 200）", async () => {
    const fx = await setup();
    await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "消される書き込み" },
    });

    const denied = await api(statePath(fx, "memo"), { method: "DELETE", cookie: fx.user });
    expect(denied.status).toBe(403);

    await addBoardStaff(fx.boardId, fx.userAccountId, "moderator");

    const cleared = await api(statePath(fx, "memo"), { method: "DELETE", cookie: fx.user });
    expect(cleared.status).toBe(200);
    const state = await readState<EntriesState>(fx, "memo", { cookie: fx.user });
    expect(state.body.data!.items).toHaveLength(0);
    expect(state.body.data!.total).toBe(0);
  });

  it("宣言と違う種類の操作は 400（tally / choice / entries）", async () => {
    const fx = await setup();
    // entries 宣言の key に tally
    const tallyOnEntries = await api(`${statePath(fx, "memo")}/tally`, {
      method: "PUT",
      cookie: fx.user,
      body: { on: true },
    });
    expect(tallyOnEntries.status).toBe(400);

    // tally 宣言の key に choice
    const choiceOnTally = await api(`${statePath(fx, "join")}/choice`, {
      method: "PUT",
      cookie: fx.user,
      body: { option: 0 },
    });
    expect(choiceOnTally.status).toBe(400);

    // choice 宣言の key に entries
    const entriesOnChoice = await api(`${statePath(fx, "poll")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "種類違い" },
    });
    expect(entriesOnChoice.status).toBe(400);

    // 取り違えた操作で行が増えていない
    const tallyRows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_thread_tallies WHERE plugin_id = ?",
    )
      .bind(fx.pluginId)
      .first<{ n: number }>();
    expect(tallyRows?.n).toBe(0);
  });

  it("未ログインの entries IP 上限は並列でも maxPerActor×3 を超えない", async () => {
    const fx = await setup();
    const ip = `203.0.116.${++ipCounter}`;
    const attempts = Array.from({ length: 12 }, (_, index) => ({
      cookie: `oc_did=${randomHex(16)}`,
      headers: { "cf-connecting-ip": ip },
      body: { text: `並列 ${index}` },
    }));
    const responses = await Promise.all(
      attempts.map((attempt) =>
        api(`${statePath(fx, "memo")}/entries`, { method: "POST", ...attempt }),
      ),
    );
    const created = responses.filter((response) => response.status === 201).length;
    expect(created).toBeLessThanOrEqual(3);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_thread_entries WHERE plugin_id = ? AND key = 'memo'",
    )
      .bind(fx.pluginId)
      .first<{ n: number }>();
    expect(rows?.n).toBeLessThanOrEqual(3);
  });

  it("プラグインを削除するとスレごとの共有値も残らない（FK 違反にしない）", async () => {
    const fx = await setup();
    await api(`${statePath(fx, "memo")}/entries`, {
      method: "POST",
      cookie: fx.user,
      body: { text: "削除される書き込み" },
    });
    await api(`${statePath(fx, "join")}/tally`, { method: "PUT", cookie: fx.user, body: { on: true } });

    // 他者の導入が残っていると削除できない仕様のため、先に導入を外す。
    await env.DB.prepare("DELETE FROM plugin_installs WHERE plugin_id = ?").bind(fx.pluginId).run();
    const deleted = await api(`/v1/plugins/${fx.pluginId}`, { method: "DELETE", cookie: fx.owner });
    expect(deleted.status).toBe(200);

    const entries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_thread_entries WHERE plugin_id = ?",
    )
      .bind(fx.pluginId)
      .first<{ n: number }>();
    const tallies = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_thread_tallies WHERE plugin_id = ?",
    )
      .bind(fx.pluginId)
      .first<{ n: number }>();
    expect(entries?.n).toBe(0);
    expect(tallies?.n).toBe(0);
  });
});