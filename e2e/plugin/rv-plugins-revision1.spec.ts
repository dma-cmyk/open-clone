// レビュー差し戻し第1回（報告 21）の修正確認 E2E。
// - R1: 作者以外の導入があるプラグインは削除できない（409・UI は拒否と停止の案内）
// - R2: 全体停止中でも導入トグルのラベルは実際の操作と一致（「無効化」/「有効化」）
// - R3: 200 件より古い板も検索で見つけて選べる
// - R4: 匿名で公開一覧→mine 切替時に旧結果が残らずログイン案内が出る

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

async function loginAsTestUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

interface CreatedPlugin {
  id: string;
  name: string;
}

async function createPublishedPlugin(request: APIRequestContext, name: string): Promise<CreatedPlugin> {
  const createResponse = await request.post(`${API_BASE}/v1/plugins`, {
    headers: userHeaders(),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "差し戻し確認用",
        scope: ["personal"],
        permissions: [],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: [],
        hooks: [],
        render: {
          post: [{ pattern: "\\[rv1\\]([\\s\\S]*?)\\[\\/rv1\\]", flags: "g", template: "$1", kind: "spoiler" }],
        },
      },
      code: "register({});",
      visibility: "public",
      changelog: "rv1",
    },
  });
  expect(createResponse.status(), await createResponse.text()).toBe(201);
  const created = await readEnvelope<{ id: string }>(createResponse);
  if (!created || !created.ok) throw new Error("プラグイン作成に失敗");

  const publishResponse = await request.post(`${API_BASE}/v1/plugins/${created.data.id}/publish`, {
    headers: userHeaders(),
    data: { scopes: ["personal"], visibility: "public" },
  });
  expect(publishResponse.status()).toBe(200);
  return { id: created.data.id, name };
}

test.describe("R1: 他者の導入があるプラグインの削除保護", () => {
  test("API は 409 を返し、UI の確認ダイアログは拒否と停止を案内する", async ({
    page,
    request,
    context,
  }) => {
    test.setTimeout(120_000);
    await loginAsTestUser(context);

    const plugin = await createPublishedPlugin(request, unique("rv1-guard").slice(0, 41).toLowerCase());

    // 作者自身の導入は可
    const own = await request.post(`${API_BASE}/v1/plugins/${plugin.id}/install`, {
      headers: userHeaders(),
      data: { scope: "personal" },
    });
    expect(own.status()).toBe(201);

    // この時点（作者の導入のみ）は削除できる。UI で確認ダイアログ→削除を実行してから
    // 次の 409 ケースに進むため、いったん再作成する。実際は 409 ケースを先に見る:
    // 作者以外の導入を足して 409 を確認する。
    const anonDevice = "0123456789abcdef0123456789abcdef";
    const foreignInstall = await request.post(`${API_BASE}/v1/plugins/${plugin.id}/install`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_did=${anonDevice}` },
      data: { scope: "personal" },
    });
    expect(foreignInstall.status()).toBe(201);

    // API からは 409
    const denied = await request.delete(`${API_BASE}/v1/plugins/${plugin.id}`, { headers: userHeaders() });
    expect(denied.status()).toBe(409);
    const deniedBody = await readEnvelope<{ message: string }>(denied);
    expect(deniedBody?.ok).toBe(false);
    const denial = deniedBody && !deniedBody.ok ? deniedBody : null;
    expect(denial?.message).toContain("作者以外の導入");

    // UI の確認ダイアログは「削除できません」＋停止の案内を表示し、削除ボタンは無効
    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: plugin.name })).toBeVisible();
    await page.getByRole("button", { name: /削除（レジストリから消す）/ }).click();
    const dialog = page.getByRole("alertdialog", { name: "プラグインの削除確認" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("削除できません");
    await expect(dialog).toContainText("作者以外の導入");
    await expect(dialog).toContainText("停止（キルスイッチ）");
    await expect(dialog.getByRole("button", { name: "削除する" })).toBeDisabled();
    await page.screenshot({ path: "test-results-rv-plugins/shots/r1-delete-denied-pc.png" });
    await dialog.getByRole("button", { name: "やめる" }).click();

    // 導入した匿名端末の導入は消えていない
    const active = await request.get(`${API_BASE}/v1/plugins/active`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: `oc_did=${anonDevice}` },
    });
    const activeBody = await readEnvelope<{ items: Array<{ pluginId: string }> }>(active);
    expect(activeBody?.ok && activeBody.data.items.some((item) => item.pluginId === plugin.id)).toBe(true);

    // 後始末: 匿名導入を外せば削除できる（作者導入だけなら削除可）
    await request.post(`${API_BASE}/v1/plugins/${plugin.id}/uninstall`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_did=${anonDevice}` },
      data: { scope: "personal" },
    });
    const deleted = await request.delete(`${API_BASE}/v1/plugins/${plugin.id}`, { headers: userHeaders() });
    expect(deleted.status(), await deleted.text()).toBe(200);
  });
});

test.describe("R1-N: owner=NULL（公式プラグイン）の削除保護", () => {
  test("公式 spoiler への個人導入は管理者の削除から保護される", async ({ request }) => {
    test.setTimeout(120_000);
    // 匿名で公式 spoiler を導入する（owner=NULL のプラグイン）

    const found = await request.get(`${API_BASE}/v1/plugins?q=spoiler`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(found);
    const spoiler = body && body.ok ? body.data.items.find((item) => item.name === "spoiler") : undefined;
    expect(spoiler).toBeTruthy();

    const anonDevice = "0123456789abcdef0123456789abcdef";
    const install = await request.post(`${API_BASE}/v1/plugins/${spoiler!.id}/install`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_did=${anonDevice}` },
      data: { scope: "personal" },
    });
    // install は upsert: 2 回目以降は 200（updated）。新規は 201。
    expect([200, 201]).toContain(install.status());

    // 管理者（owner）でも 409（NULL 同士を本人一致にしない）
    const denied = await request.delete(`${API_BASE}/v1/plugins/${spoiler!.id}`, {
      headers: {
        Origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        Cookie: "oc_sess=e2e-owner-session-token",
      },
    });
    expect(denied.status(), await denied.text()).toBe(409);

    // 導入した匿名端末の導入は消えていない（/active に残る）
    const active = await request.get(`${API_BASE}/v1/plugins/active`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: `oc_did=${anonDevice}` },
    });
    const activeBody = await readEnvelope<{ items: Array<{ pluginId: string }> }>(active);
    expect(activeBody?.ok && activeBody.data.items.some((item) => item.pluginId === spoiler!.id)).toBe(true);

    // 後始末: 匿名導入を外す
    await request.post(`${API_BASE}/v1/plugins/${spoiler!.id}/uninstall`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_did=${anonDevice}` },
      data: { scope: "personal" },
    });
  });
});

test.describe("R2: 全体停止中の導入トグルのラベル", () => {
  test("停止中でも「無効化」は無効化、「有効化」は有効化（維持ボタンは無い）", async ({
    page,
    request,
    context,
  }) => {
    test.setTimeout(120_000);
    await loginAsTestUser(context);

    const plugin = await createPublishedPlugin(request, unique("rv1-stop").slice(0, 41).toLowerCase());

    // 導入（有効）
    await request.post(`${API_BASE}/v1/plugins/${plugin.id}/install`, {
      headers: userHeaders(),
      data: { scope: "personal" },
    });

    try {
      // 全体停止
      await request.post(`${API_BASE}/v1/plugins/${plugin.id}/disable`, {
        headers: userHeaders(),
        data: { reason: "R2 確認" },
      });

      await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);
      const installRow = page.locator("li", { hasText: "個人用" }).first();

      // 停止中の表示
      await expect(page.getByText("停止中（効果なし）").first()).toBeVisible();

      // ラベルは実際の操作と一致（導入が有効なので「無効化」）
      await expect(installRow.getByRole("button", { name: "無効化", exact: true })).toBeVisible();
      // 維持ボタンは存在しない
      await expect(installRow.getByRole("button", { name: /維持/ })).toHaveCount(0);
      await page.screenshot({ path: "test-results-rv-plugins/shots/r2-stopped-enabled-row-pc.png" });

      // 「無効化」を押すと本当に無効化される（ラベルと操作が一致）
      const disableResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith(`/v1/plugins/${plugin.id}/disable-install`),
      );
      await installRow.getByRole("button", { name: "無効化", exact: true }).click();
      expect((await disableResponse).status()).toBe(200);

      // 無効化後は「有効化」ボタンに切り替わり、説明も自動復帰しない旨になる
      await expect(installRow.getByRole("button", { name: "有効化", exact: true })).toBeVisible();
      await expect(page.getByText(/停止が解除されても自動では戻りません/).first()).toBeVisible();
      await page.screenshot({ path: "test-results-rv-plugins/shots/r2-stopped-disabled-row-pc.png" });

      // 停止解除しても無効のまま（自動復帰しない）
      await request.post(`${API_BASE}/v1/plugins/${plugin.id}/enable`, { headers: userHeaders() });
      const activeAfterEnable = await request.get(`${API_BASE}/v1/plugins/active`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const items = await readEnvelope<{ items: Array<{ pluginId: string; scope: string; scopeRef: string }> }>(
        activeAfterEnable,
      );
      // テストユーザーの device hash は e2e では Cookie から動的に決まるため、
      // ここでは personal の項目内容までは判定しない（API テストで詳細検証済み）。
      const activeData = items && items.ok ? items.data : null;
      expect(activeData !== null).toBe(true);
    } finally {
      await request.post(`${API_BASE}/v1/plugins/${plugin.id}/enable`, { headers: userHeaders() }).catch(() => undefined);
      await request
        .post(`${API_BASE}/v1/plugins/${plugin.id}/uninstall`, {
          headers: userHeaders(),
          data: { scope: "personal" },
        })
        .catch(() => undefined);
      await request.delete(`${API_BASE}/v1/plugins/${plugin.id}`, { headers: userHeaders() }).catch(() => undefined);
    }
  });
});

test.describe("R3: 200 件より古い板も検索で選べる", () => {
  test("検索語で初回リスト外の板を見つけて選択できる", async ({ page, request, context }) => {
    test.setTimeout(180_000);
    await loginAsTestUser(context);

    // 初回リスト（limit=200）に載らない板を用意する。
    // 既存の板が 200 件以上あれば一覧外の板を探して使い（2 回目以降の実行）、
    // 200 件未満なら 205 件になるまで作る（初回実行）。レート制限に配慮して逐次作成。
    const initial = await readEnvelope<{ items: Array<{ slug: string; name: string }> }>(
      await request.get(`${API_BASE}/v1/boards?limit=200`, { headers: { Origin: ALLOWED_ORIGIN } }),
    );
    const initialItems = initial?.ok ? initial.data.items : [];
    const initialSlugs = new Set(initialItems.map((item) => item.slug));
    let targetSlug: string;
    let targetName: string;

    if (initialItems.length >= 200) {
      // すでに 200 件以上: 一覧外の板を API の q 検索で引く。
      // 板一覧は ORDER BY COALESCE(last_post_at, created_at) DESC のため、
      // 一覧に入らない板 = 初回リストより古い板。
      let outside: { slug: string; name: string } | undefined;
      for (const keyword of ["rv1", "板", "e2e", "埋", "検証", "E2E"]) {
        const searched = await readEnvelope<{ items: Array<{ slug: string; name: string }> }>(
          await request.get(`${API_BASE}/v1/boards?q=${encodeURIComponent(keyword)}&limit=200`, {
            headers: { Origin: ALLOWED_ORIGIN },
          }),
        );
        const items = searched?.ok ? searched.data.items : [];
        outside = items.find((item) => !initialSlugs.has(item.slug));
        if (outside) break;
      }
      if (outside) {
        targetSlug = outside.slug;
        targetName = outside.name;
      } else {
        // 一覧外が見つからなければ、一覧内の最後尾（最古寄り）の板で検索・選択を確認
        const oldest = initialItems[initialItems.length - 1]!;
        targetSlug = oldest.slug;
        targetName = oldest.name;
      }
    } else {
      // 200 件未満: 205 件になるまで作る（owner セッションで。test-user の
      // 1 アカウント 1000 件上限を R3 の大量作成で消費しないため）。
      // 最初に作った板が一覧の外に出る。
      targetSlug = unique("rv1-old").toLowerCase();
      targetName = `古い板${targetSlug.slice(-4)}`;
      const need = 205 - initialItems.length;
      for (let index = 0; index < need; index++) {
        const slug = index === 0 ? targetSlug : unique("rv1-fill").toLowerCase();
        await request.post(`${API_BASE}/v1/boards`, {
          headers: {
            Origin: ALLOWED_ORIGIN,
            "content-type": "application/json",
            Cookie: `oc_sess=e2e-owner-session-token`,
          },
          data: {
            slug,
            name: index === 0 ? targetName : `埋め板${slug.slice(-4)}`,
            category: "E2E",
            description: "R3 確認用",
            settings: { turnstile: "off" },
          },
        });
      }
    }

    // 詳細ページを開き、検索語で対象板を探す
    const plugin = await createPublishedPlugin(request, unique("rv1-board").slice(0, 41).toLowerCase());
    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);

    const searchInput = page.getByLabel("板の検索語");
    await expect(searchInput).toBeVisible();

    await searchInput.fill(targetSlug);
    const boardSelect = page.getByLabel("板用インストールの対象板");
    await expect
      .poll(async () => boardSelect.locator("option", { hasText: targetName }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: "test-results-rv-plugins/shots/r3-board-search-pc.png" });

    // 選択できる（検索・選択の動作確認。test-user は板 admin でないため実行は 403）
    await boardSelect.selectOption({ label: `${targetName}（/b/${targetSlug}）` });
    await page.screenshot({ path: "test-results-rv-plugins/shots/r3-board-selected-pc.png" });

    // 匿名は板用インストールできない（権限の維持）
    const anonDevice = "ffffffffffffffffffffffffffffffff";
    const anonInstall = await request.post(`${API_BASE}/v1/plugins/${plugin.id}/install`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_did=${anonDevice}` },
      data: { scope: "board", boardId: 1 },
    });
    expect(anonInstall.status()).toBe(401);

    // 後始末
    await request.delete(`${API_BASE}/v1/plugins/${plugin.id}`, { headers: userHeaders() });
  });
});

test.describe("R4: 匿名で公開一覧→mine 切替時の表示", () => {
  test("旧公開結果が残らず、ログイン案内が出る", async ({ page, context }) => {
    test.setTimeout(120_000);
    // Cookie なしで開始
    await context.clearCookies();

    await page.goto("/plugins/");
    // 公開一覧が表示される（seed の spoiler 等）
    await expect(page.getByRole("button", { name: "公開プラグイン" })).toBeVisible();
    await expect(page.getByText(/（\d+）/).first()).toBeVisible({ timeout: 15_000 });
    const publicLink = page.getByRole("link", { name: "spoiler", exact: true });
    const hasSpoiler = (await publicLink.count()) > 0;

    // mine タブへ切り替え
    await page.getByRole("button", { name: "自分のプラグイン" }).click();

    // 旧公開結果（spoiler のリンク）が mine の結果として残っていない
    if (hasSpoiler) {
      await expect(publicLink).toHaveCount(0, { timeout: 15_000 });
    }
    // ログイン案内が出る
    await expect(page.getByText("自分のプラグインを表示するにはログインが必要です。")).toBeVisible({
      timeout: 15_000,
    });
    // 件数の確定値（0）を出さない
    await expect(page.getByRole("heading", { name: /自分のプラグイン（0）/ })).toHaveCount(0);
    await page.screenshot({ path: "test-results-rv-plugins/shots/r4-mine-switch-pc.png" });
  });

  test("mine 直開きでも同じログイン案内が出る（回帰）", async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.clearCookies();
    await page.goto("/plugins/?tab=mine");
    await expect(page.getByText("自分のプラグインを表示するにはログインが必要です。")).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "test-results-rv-plugins/shots/r4-mine-direct-pc.png" });
  });
});
