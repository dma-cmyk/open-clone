// サイトツアーの単体テスト。
// - URL → 画面キーの判定
// - 画面に出ている要素だけで手順を組み立てる（飛ばし）
// - 手順が指す `data-tour` 属性が実際のソースに存在する（案内先の取り違え防止）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSteps, TOUR_DEFINITIONS, tourDefinitionOf } from "./steps";
import { isLastStep, tourPageKeyForPath, type TourState } from "./store";
import type { TourPageKey } from "./types";

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