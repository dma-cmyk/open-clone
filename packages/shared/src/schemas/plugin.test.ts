// manifest.threadState と storage:thread の契約（設計「スレごとの共有値」B-1）。
import { describe, expect, it } from "vitest";
import {
  PLUGIN_PERMISSION_RISK,
  normalizeManifest,
  pluginManifestSchema,
  rpcPermissionFor,
} from "./plugin";

const base = {
  name: "thread-state-test",
  version: "1.0.0",
  summary: "スレごとの共有値",
  scope: ["personal"],
  permissions: ["ui:slot", "storage:thread"],
  slots: ["thread-head"],
  threadState: [{ key: "join", kind: "tally" }],
};

describe("manifest.threadState", () => {
  it("既定値（who=anyone / entries の上限）を埋める", () => {
    const manifest = normalizeManifest({
      ...base,
      threadState: [
        { key: "join", kind: "tally" },
        { key: "poll", kind: "choice", options: ["a", "b"] },
        { key: "memo", kind: "entries" },
      ],
    });
    expect(manifest.threadState[0]).toEqual({ key: "join", kind: "tally", who: "anyone" });
    expect(manifest.threadState[1]).toMatchObject({ kind: "choice", who: "anyone", options: ["a", "b"] });
    expect(manifest.threadState[2]).toEqual({
      key: "memo",
      kind: "entries",
      who: "anyone",
      maxPerActor: 1,
      maxEntries: 200,
      maxLength: 100,
    });
  });

  it("storage:thread と threadState は対でなければ拒否する", () => {
    const withoutPermission = { ...base, permissions: ["ui:slot"] };
    expect(pluginManifestSchema.safeParse(withoutPermission).success).toBe(false);

    const withoutState = { ...base, threadState: [] };
    expect(pluginManifestSchema.safeParse(withoutState).success).toBe(false);
  });

  it("key の形式・重複・選択肢数・上限を検証する", () => {
    expect(pluginManifestSchema.safeParse({ ...base, threadState: [{ key: "A B", kind: "tally" }] }).success).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        threadState: [
          { key: "dup", kind: "tally" },
          { key: "dup", kind: "tally" },
        ],
      }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        threadState: [{ key: "poll", kind: "choice", options: ["only"] }],
      }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        threadState: [{ key: "memo", kind: "entries", maxPerActor: 11 }],
      }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        threadState: [{ key: "memo", kind: "entries", maxEntries: 501, maxLength: 201 }],
      }).success,
    ).toBe(false);
  });

  it("最大 8 件まで", () => {
    const threadState = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, kind: "tally" }));
    expect(pluginManifestSchema.safeParse({ ...base, threadState }).success).toBe(false);
  });
});

describe("storage:thread の権限", () => {
  it("危険度は medium", () => {
    expect(PLUGIN_PERMISSION_RISK["storage:thread"]).toBe("medium");
  });

  it("5 つの thread RPC が storage:thread を要求する", () => {
    for (const method of [
      "thread.state.get",
      "thread.tally.set",
      "thread.choice.set",
      "thread.entries.add",
      "thread.entries.remove",
    ]) {
      expect(rpcPermissionFor(method)).toBe("storage:thread");
    }
  });
});