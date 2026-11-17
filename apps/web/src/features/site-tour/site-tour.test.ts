// サイトツアーの単体テスト。
// - URL → 画面キーの判定
// - 画面に出ている要素だけで手順を組み立てる（飛ばし）
// - 手順が指す `data-tour` 属性が実際のソースに存在する（案内先の取り違え防止）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSteps, TOUR_DEFINITIONS, TOUR_LIST_DEFINITIONS, tourDefinitionOf } from "./steps";
import { isLastStep, tourPageKeyForPath, type TourState } from "./store";
import {
  PENDING_START_KEY,
  PENDING_START_PERMISSION_GRACE_MS,
  PENDING_START_WAIT_MS,
  planPendingStart,
  readPendingStart,
  writePendingStart,
  type PendingStartStorage,
} from "./pending-start";
import { api } from "../board-ui/api";
import type { TourListContext, TourPageKey } from "./types";

/** `sessionStorage` の代わり（単体テスト用のメモリ）。 */
function memoryStorage(initial?: Record<string, string>): PendingStartStorage & { value: Map<string, string> } {
  const value = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    value,
    getItem: (key) => value.get(key) ?? null,
    setItem: (key, item) => {
      value.set(key, item);
    },
    removeItem: (key) => {
      value.delete(key);
    },
  };
}

/** 一覧の権限判定に使う利用者の情報。 */
function listContext(overrides: Partial<TourListContext> = {}): TourListContext {
  return {
    loggedIn: false,
    siteOwner: false,
    siteSpecialAdmin: false,
    staffBoardSlugs: [],
    adminBoardSlugs: [],
    ...overrides,
  };
}

describe("tourPageKeyForPath", () => {
  it("画面ごとのキーを返す", () => {
    expect(tourPageKeyForPath("/")).toBe("home");
    expect(tourPageKeyForPath("/b/news")).toBe("board");
    expect(tourPageKeyForPath("/b/news/t/12")).toBe("thread");
    expect(tourPageKeyForPath("/b/news/manage/staff")).toBe("manage");
    expect(tourPageKeyForPath("/b/news/manage")).toBe("manage");
    expect(tourPageKeyForPath("/boards/new")).toBe("board-new");
    expect(tourPageKeyForPath("/settings")).toBe("settings");
    expect(tourPageKeyForPath("/admin")).toBe("admin");
    expect(tourPageKeyForPath("/admin/users")).toBe("admin");
    expect(tourPageKeyForPath("/help")).toBe("help");
    expect(tourPageKeyForPath("/help/")).toBe("help");
    expect(tourPageKeyForPath("/help/admin")).toBe("help-admin");
    expect(tourPageKeyForPath("/help/admin/")).toBe("help-admin");
  });

  it("ツアーの無い画面は null（勝手に始めない）", () => {
    expect(tourPageKeyForPath("/search")).toBeNull();
    expect(tourPageKeyForPath("/plugins")).toBeNull();
    expect(tourPageKeyForPath("/account/login")).toBeNull();
    expect(tourPageKeyForPath("/ranking")).toBeNull();
  });
});

describe("手順の定義", () => {
  const pages = Object.keys(TOUR_DEFINITIONS) as TourPageKey[];

  it("全画面に 1 件以上の手順があり、id が重複しない", () => {
    for (const page of pages) {
      const definition = tourDefinitionOf(page);
      expect(definition.steps.length, `${page} の手順が空`).toBeGreaterThan(0);
      const ids = definition.steps.map((step) => step.id);
      expect(new Set(ids).size, `${page} の id が重複`).toBe(ids.length);
    }
  });

  it("説明文・見出しが空でなく、ヘルプのアンカーは # で始まる", () => {
    for (const page of pages) {
      for (const step of tourDefinitionOf(page).steps) {
        expect(step.title.length, `${page}/${step.id} の見出し`).toBeGreaterThan(0);
        expect(step.body.length, `${page}/${step.id} の説明`).toBeGreaterThanOrEqual(20);
        if (step.helpAnchor) expect(step.helpAnchor.startsWith("#")).toBe(true);
      }
    }
  });

  it("管理者向けの画面は /help/admin/ へ、一般向けは /help/ へ案内する", () => {
    expect(tourDefinitionOf("admin").helpPath.startsWith("/help/admin/")).toBe(true);
    expect(tourDefinitionOf("manage").helpPath.startsWith("/help/admin/")).toBe(true);
    expect(tourDefinitionOf("home").helpPath.startsWith("/help/")).toBe(true);
    expect(tourDefinitionOf("thread").helpPath.startsWith("/help/")).toBe(true);
  });
});

describe("resolveSteps（要素が無い手順を飛ばす）", () => {
  it("画面に無いセレクタの手順は含めない", () => {
    const definition = tourDefinitionOf("thread");
    const onlyForm = resolveSteps(definition, (selector) => selector.includes("post-form"));
    expect(onlyForm.length).toBeGreaterThan(0);
    expect(onlyForm.every((step) => step.selector.includes("post-form"))).toBe(true);
    // 元の定義より必ず少ない（飛ばした分だけ減る）
    expect(onlyForm.length).toBeLessThan(definition.steps.length);
  });

  it("何も無ければ 0 件（呼び出し側は開始しない）", () => {
    expect(resolveSteps(tourDefinitionOf("board"), () => false)).toHaveLength(0);
  });
});

describe("isLastStep", () => {
  const base: TourState = { page: "home", steps: [{ id: "a", selector: "#a", title: "a", body: "a" }], index: 0, pathname: "/" };
  it("最後の手順を判定する", () => {
    expect(isLastStep(base)).toBe(true);
    expect(isLastStep({ ...base, steps: [...base.steps, { id: "b", selector: "#b", title: "b", body: "b" }] })).toBe(
      false,
    );
  });
});

describe("data-tour 属性の実在確認", () => {
  const root = join(process.cwd(), "src");
  const files: string[] = [];
  // 画面（.tsx）だけを走査する。定義ファイル（steps.ts）を含めると、定義中の
  // `selector: '[data-tour="..."]'` に自分自身で一致してしまい検査にならない（レビュー M02）。
  const SELF_DIR = join(root, "features", "site-tour");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (path === SELF_DIR) continue;
        walk(path);
        continue;
      }
      if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) files.push(path);
    }
  };
  walk(root);
  const sources = files.map((file) => readFileSync(file, "utf8"));

  it("固定セレクタの data-tour がソースに存在する", () => {
    for (const page of Object.keys(TOUR_DEFINITIONS) as TourPageKey[]) {
      for (const step of tourDefinitionOf(page).steps) {
        const match = /data-tour="([^"]+)"/.exec(step.selector);
        if (!match) continue;
        const attribute = match[1]!;
        const found = sources.some(
          (source) =>
            source.includes(`data-tour="${attribute}"`) ||
            source.includes(`data-tour={\`${attribute}`) ||
            source.includes(`? "thread-form"`) ||
            source.includes(`\"${attribute}\"`),
        );
        expect(found, `${page}/${step.id}: data-tour="${attribute}" が見つかりません`).toBe(true);
      }
    }
  });

  it("動的な data-tour（管理メニュー・板管理タブ）の接頭辞も存在する", () => {
    expect(sources.some((source) => source.includes("data-tour={`admin-nav-"))).toBe(true);
    expect(sources.some((source) => source.includes("data-tour={`manage-tab-"))).toBe(true);
  });
});

describe("開始予約（画面をまたぐ開始）", () => {
  const NOW = 1_760_000_000_000;

  it("書いた予約をそのまま読める（sessionStorage の往復）", () => {
    const storage = memoryStorage();
    writePendingStart(storage, "board", NOW);
    expect(readPendingStart(storage)).toEqual({ page: "board", at: NOW });
  });

  it("壊れた値・知らない画面キーは予約として扱わない", () => {
    expect(readPendingStart(memoryStorage({ [PENDING_START_KEY]: "not json" }))).toBeNull();
    expect(readPendingStart(memoryStorage({ [PENDING_START_KEY]: '{"page":"unknown-page","at":1}' }))).toBeNull();
    expect(readPendingStart(memoryStorage({ [PENDING_START_KEY]: '{"page":"board"}' }))).toBeNull();
    expect(readPendingStart(memoryStorage())).toBeNull();
  });

  it("対象の画面に着いたら、準備ができ次第はじめる", () => {
    expect(
      planPendingStart({
        pending: { page: "board", at: NOW },
        page: "board",
        now: NOW + 300,
        contextReady: true,
        allowed: true,
        stepCount: 3,
      }),
    ).toEqual({ action: "start" });
  });

  it("権限の読み込み中は待ち、時間切れならヘルプへ送る", () => {
    const waiting = planPendingStart({
      pending: { page: "manage", at: NOW },
      page: "manage",
      now: NOW + 200,
      contextReady: false,
      allowed: false,
      stepCount: 0,
    });
    expect(waiting).toEqual({ action: "wait" });

    const timeout = planPendingStart({
      pending: { page: "manage", at: NOW },
      page: "manage",
      now: NOW + PENDING_START_WAIT_MS + 1,
      contextReady: false,
      allowed: false,
      stepCount: 0,
    });
    expect(timeout).toEqual({ action: "help" });
  });

  it("権限不足なら（移動直後の読み込み猶予のあと）ヘルプへ送る", () => {
    const grace = PENDING_START_PERMISSION_GRACE_MS;
    // 移動直後は、画面が「読み込み中」を知らせる effect より先に判定することがある。
    expect(
      planPendingStart({
        pending: { page: "admin", at: NOW },
        page: "admin",
        now: NOW + 100,
        contextReady: true,
        allowed: false,
        stepCount: 5,
      }),
    ).toEqual({ action: "wait" });
    expect(
      planPendingStart({
        pending: { page: "admin", at: NOW },
        page: "admin",
        now: NOW + grace + 1,
        contextReady: true,
        allowed: false,
        stepCount: 5,
      }),
    ).toEqual({ action: "help" });
  });

  it("手順がまだ描画されていなければ期限内は待ち、過ぎたらヘルプへ送る", () => {
    const waiting = planPendingStart({
      pending: { page: "thread", at: NOW },
      page: "thread",
      now: NOW + 500,
      contextReady: true,
      allowed: true,
      stepCount: 0,
    });
    expect(waiting).toEqual({ action: "wait" });
    expect(
      planPendingStart({
        pending: { page: "thread", at: NOW },
        page: "thread",
        now: NOW + PENDING_START_WAIT_MS,
        contextReady: true,
        allowed: true,
        stepCount: 0,
      }),
    ).toEqual({ action: "help" });
  });

  it("別の画面に残っていた予約は捨てる（勝手に始めない）", () => {
    expect(
      planPendingStart({
        pending: { page: "board", at: NOW },
        page: "home",
        now: NOW + 100,
        contextReady: true,
        allowed: true,
        stepCount: 5,
      }),
    ).toEqual({ action: "discard" });
    // ツアーの無い画面でも同じ。
    expect(
      planPendingStart({
        pending: { page: "board", at: NOW },
        page: null,
        now: NOW + 100,
        contextReady: true,
        allowed: true,
        stepCount: 5,
      }),
    ).toEqual({ action: "discard" });
  });

  it("古すぎる予約は黙って捨てる（戻ってきたタブ等で始めない）", () => {
    expect(
      planPendingStart({
        pending: { page: "home", at: NOW },
        page: "home",
        now: NOW + 10 * 60_000,
        contextReady: true,
        allowed: true,
        stepCount: 5,
      }),
    ).toEqual({ action: "discard" });
  });
});

describe("一覧の行（TOUR_DEFINITIONS から作る）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("説明と開く先のあるツアーだけを、決めた順で並べる", () => {
    const pages = TOUR_LIST_DEFINITIONS.map((entry) => entry.page);
    expect(pages).toEqual(expect.arrayContaining(["home", "board", "thread", "board-new", "settings", "help"]));
    expect(pages.indexOf("home")).toBeLessThan(pages.indexOf("board"));
    expect(pages.indexOf("board")).toBeLessThan(pages.indexOf("thread"));
    for (const { definition } of TOUR_LIST_DEFINITIONS) {
      expect(definition.summary?.length ?? 0).toBeGreaterThan(0);
      expect(typeof definition.entry).toBe("function");
      expect(definition.steps.length).toBeGreaterThan(0);
    }
  });

  it("管理系の行は権限がある人にだけ出す", () => {
    const adminRow = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "admin")!;
    const manageRow = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "manage")!;
    expect(adminRow.definition.listVisible?.(listContext())).toBe(false);
    expect(adminRow.definition.listVisible?.(listContext({ loggedIn: true }))).toBe(false);
    expect(adminRow.definition.listVisible?.(listContext({ loggedIn: true, siteOwner: true }))).toBe(true);
    expect(adminRow.definition.listVisible?.(listContext({ loggedIn: true, siteSpecialAdmin: true }))).toBe(true);

    expect(manageRow.definition.listVisible?.(listContext({ loggedIn: true }))).toBe(false);
    expect(manageRow.definition.listVisible?.(listContext({ loggedIn: true, staffBoardSlugs: ["news"] }))).toBe(true);
  });

  it("板はトップと同じ並びの先頭、板の管理は最初のスタッフの板を開く", async () => {
    vi.spyOn(api, "listBoards").mockResolvedValue({
      items: [
        { id: 1, slug: "first", name: "最初の板", category: "雑談" },
        { id: 2, slug: "second", name: "次の板", category: "雑談" },
      ],
      categories: ["雑談"],
    });
    const boardEntry = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "board")!;
    await expect(boardEntry.definition.entry!(listContext())).resolves.toBe("/b/first");

    const manageEntry = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "manage")!;
    expect(manageEntry.definition.entry!(listContext({ staffBoardSlugs: ["staffed", "other"] }))).toBe("/b/staffed/manage");
    expect(manageEntry.definition.entry!(listContext())).toBeNull();
  });

  it("スレは先頭の板に無ければ次の板の新しいスレを選ぶ", async () => {
    vi.spyOn(api, "listBoards").mockResolvedValue({
      items: [
        { id: 1, slug: "empty", name: "スレ無し", category: "雑談" },
        { id: 2, slug: "has-thread", name: "スレ有り", category: "雑談" },
      ],
      categories: ["雑談"],
    });
    const listThreads = vi.spyOn(api, "listThreads").mockImplementation(async (slug: string) =>
      slug === "has-thread"
        ? { items: [{ id: 42, title: "新しいスレ", postCount: 1 }], nextCursor: null }
        : { items: [], nextCursor: null },
    );
    const threadEntry = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "thread")!;
    await expect(threadEntry.definition.entry!(listContext())).resolves.toBe("/b/has-thread/t/42");
    // 新しいスレ順で選ぶ（並びは板画面の「新スレ」と同じ）。
    expect(listThreads).toHaveBeenCalledWith("empty", { sort: "created", limit: 1 });
  });

  it("開ける板が無ければ null（行を無効にする）", async () => {
    vi.spyOn(api, "listBoards").mockResolvedValue({ items: [], categories: [] });
    const boardEntry = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "board")!;
    const threadEntry = TOUR_LIST_DEFINITIONS.find((entry) => entry.page === "thread")!;
    await expect(boardEntry.definition.entry!(listContext())).resolves.toBeNull();
    await expect(threadEntry.definition.entry!(listContext())).resolves.toBeNull();
  });
});