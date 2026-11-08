import { describe, expect, it } from "vitest";
import {
  GIST_MAX_TOTAL_BYTES,
  createGistSchema,
  githubPathSchema,
  githubRepoSchema,
  repoFileWriteSchema,
} from "./github";

describe("createGistSchema", () => {
  it("ファイルが 1 つ以上あれば通る", () => {
    const parsed = createGistSchema.parse({
      public: false,
      files: { "a.txt": { content: "hello" } },
    });
    expect(parsed.public).toBe(false);
    expect(parsed.files["a.txt"]!.content).toBe("hello");
  });

  it("空のファイルセットを拒否する", () => {
    expect(createGistSchema.safeParse({ public: false, files: {} }).success).toBe(false);
  });

  it("合計 2MB 超を拒否する", () => {
    const chunk = "x".repeat(1024 * 1024);
    const result = createGistSchema.safeParse({
      public: false,
      files: {
        "a.txt": { content: chunk },
        "b.txt": { content: chunk },
        "c.txt": { content: "x" },
      },
    });
    expect(result.success).toBe(false);
    expect(GIST_MAX_TOTAL_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("githubPathSchema", () => {
  it("`..` や先頭スラッシュを拒否する", () => {
    expect(githubPathSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(githubPathSchema.safeParse("/absolute").success).toBe(false);
    expect(githubPathSchema.safeParse("plugins/foo/index.js").success).toBe(true);
  });
});

describe("githubRepoSchema", () => {
  it("GitHub のリポジトリ名書式を強制する", () => {
    expect(githubRepoSchema.safeParse("open-clone").success).toBe(true);
    expect(githubRepoSchema.safeParse("bad repo!").success).toBe(false);
  });
});

describe("repoFileWriteSchema", () => {
  it("既定のコミットメッセージを補う", () => {
    const parsed = repoFileWriteSchema.parse({ path: "a/b.txt", content: "x" });
    expect(parsed.message).toContain("おーぷんクローン");
  });
});