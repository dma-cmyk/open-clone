// GET /v1/accounts/me/boards（ツアー一覧の権限判定用）。
// - 自分がスタッフの板だけを返す（他の人の板・板スタッフでない板は出ない）
// - 削除板は出さない（K2 と同じ扱い）
// - 未ログインは 401
// - 権限の強い順（管理人→副管理人→モデレーター）で並ぶ

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authedClient, createBoard, resetWorld, TestClient } from "./wp1/helpers";

interface MyBoardsData {
  items: Array<{ slug: string; name: string; level: "admin" | "deputy" | "moderator" }>;
}

beforeEach(async () => {
  await resetWorld();
});

/** 板の管理人（作成者）に、指定アカウントをスタッフとして加える。 */
async function addStaff(
  adminClient: TestClient,
  slug: string,
  accountName: string,
  level: "admin" | "deputy" | "moderator",
): Promise<void> {
  const response = await adminClient.post(`/v1/boards/${slug}/staff`, { accountName, level });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

describe("GET /v1/accounts/me/boards", () => {
  it("自分がスタッフの板だけを、権限の強い順で返す", async () => {
    const owner = await authedClient({ name: "mb-owner" });
    const deputy = await authedClient({ name: "mb-deputy" });
    const moderator = await authedClient({ name: "mb-moderator" });

    // owner が 3 つの板を作る（作成者は管理人）。
    const first = await createBoard(owner.client, { slug: "mb-first", name: "管理板1" });
    const second = await createBoard(owner.client, { slug: "mb-second", name: "管理板2" });
    const third = await createBoard(owner.client, { slug: "mb-third", name: "管理板3" });
    await addStaff(owner.client, first.board.slug, deputy.account.name, "deputy");
    await addStaff(owner.client, second.board.slug, deputy.account.name, "moderator");
    await addStaff(owner.client, third.board.slug, moderator.account.name, "moderator");

    const deputyBoards = await deputy.client.get<MyBoardsData>("/v1/accounts/me/boards");
    expect(deputyBoards.status).toBe(200);
    if (!deputyBoards.body.ok) throw new Error(JSON.stringify(deputyBoards.body));
    expect(deputyBoards.body.data.items.map((item) => [item.slug, item.level])).toEqual([
      ["mb-first", "deputy"],
      ["mb-second", "moderator"],
    ]);
    expect(deputyBoards.body.data.items[0]!.name).toBe("管理板1");

    // 板の管理人として作った本人には、自分の板が管理人として出る。
    const ownerBoards = await owner.client.get<MyBoardsData>("/v1/accounts/me/boards");
    expect(ownerBoards.status).toBe(200);
    if (!ownerBoards.body.ok) throw new Error(JSON.stringify(ownerBoards.body));
    expect(ownerBoards.body.data.items.map((item) => item.slug).sort()).toEqual(["mb-first", "mb-second", "mb-third"]);
    expect(ownerBoards.body.data.items.every((item) => item.level === "admin")).toBe(true);

    // スタッフでないアカウントには空配列（他の人の板を出さない）。
    const stranger = await authedClient({ name: "mb-stranger" });
    const strangerBoards = await stranger.client.get<MyBoardsData>("/v1/accounts/me/boards");
    expect(strangerBoards.status).toBe(200);
    if (!strangerBoards.body.ok) throw new Error(JSON.stringify(strangerBoards.body));
    expect(strangerBoards.body.data.items).toEqual([]);
  });

  it("削除板は返さない", async () => {
    const owner = await authedClient({ name: "mb-del-owner" });
    const alive = await createBoard(owner.client, { slug: "mb-alive", name: "残る板" });
    const deleted = await createBoard(owner.client, { slug: "mb-deleted", name: "消える板" });
    await env.DB.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(deleted.board.id).run();

    const response = await owner.client.get<MyBoardsData>("/v1/accounts/me/boards");
    expect(response.status).toBe(200);
    if (!response.body.ok) throw new Error(JSON.stringify(response.body));
    expect(response.body.data.items.map((item) => item.slug)).toEqual([alive.board.slug]);
  });

  it("未ログインは 401", async () => {
    const anon = new TestClient();
    const response = await anon.get("/v1/accounts/me/boards");
    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
  });
});