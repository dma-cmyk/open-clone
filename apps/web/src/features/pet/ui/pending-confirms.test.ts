// 確認カードの待ち（pending-confirms.ts）の単体試験。
// 同じ応答に複数の確認があっても、「止める」ですべて取り消しとして解決されること。

import { describe, expect, it } from "vitest";
import type { PetApproval } from "../contract";
import { createPendingConfirms } from "./pending-confirms";

function collector() {
  const answers: Array<{ key: string; approval: PetApproval | null }> = [];
  return {
    answers,
    resolver:
      (key: string) =>
      (approval: PetApproval | null): void => {
        answers.push({ key, approval });
      },
  };
}

describe("createPendingConfirms", () => {
  it("2 枚待っていても、止めるですべて取り消しとして解決する", () => {
    const pending = createPendingConfirms();
    const { answers, resolver } = collector();
    pending.add("card-1", resolver("card-1"));
    pending.add("card-2", resolver("card-2"));
    expect(pending.size()).toBe(2);

    const canceled = pending.cancelAll();
    expect(canceled).toEqual(["card-1", "card-2"]);
    expect(answers).toEqual([
      { key: "card-1", approval: null },
      { key: "card-2", approval: null },
    ]);
    expect(pending.size()).toBe(0);
    // 二度目は何もしない（同じ約束を二重に解決しない）。
    expect(pending.cancelAll()).toEqual([]);
    expect(answers).toHaveLength(2);
  });

  it("決定したカードだけを外し、ほかの待ちは残す", () => {
    const pending = createPendingConfirms();
    const { answers, resolver } = collector();
    pending.add("card-1", resolver("card-1"));
    pending.add("card-2", resolver("card-2"));

    expect(pending.decide("card-1", { turnstileToken: "tok" })).toBe(true);
    expect(pending.size()).toBe(1);
    // 同じカードをもう一度決めても解決しない。
    expect(pending.decide("card-1", null)).toBe(false);
    expect(answers).toEqual([{ key: "card-1", approval: { turnstileToken: "tok" } }]);

    pending.cancelAll();
    expect(answers.at(-1)).toEqual({ key: "card-2", approval: null });
  });
});