// WP4: アップローダ表示ヘルパの単体テスト（純関数のみ。DOM 不要）。
import { describe, expect, it } from "vitest";
import {
  attachmentKindOf,
  attachmentLabel,
  contentTypeMatches,
  extensionOfUrl,
  formatBytes,
  formatDateTime,
  guessedContentType,
  kindLabel,
} from "./format";

describe("formatBytes", () => {
  it("1024 進で丸める", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(95 * 1024 * 1024)).toBe("95 MB");
    expect(formatBytes(undefined)).toBe("-");
    expect(formatBytes(-1)).toBe("-");
  });
});

describe("attachmentKindOf", () => {
  it("contentType を優先する", () => {
    expect(attachmentKindOf("https://x.example/a.bin", "image/png")).toBe("image");
    // 汎用 MIME は判定材料にならないため拡張子へフォールバックする
    expect(attachmentKindOf("https://x.example/a.png", "application/octet-stream")).toBe("image");
    expect(attachmentKindOf("https://x.example/a", "video/mp4")).toBe("video");
    expect(attachmentKindOf("https://x.example/a", "audio/ogg")).toBe("audio");
    expect(attachmentKindOf("https://x.example/a", "text/plain; charset=utf-8")).toBe("text");
    expect(attachmentKindOf("https://x.example/a", "application/json")).toBe("text");
  });

  it("contentType が無ければ拡張子で判定する", () => {
    expect(attachmentKindOf("https://files.catbox.moe/abc.png")).toBe("image");
    expect(attachmentKindOf("https://files.catbox.moe/abc.JPEG?x=1")).toBe("image");
    expect(attachmentKindOf("https://files.catbox.moe/abc.webm#t=1")).toBe("video");
    expect(attachmentKindOf("https://files.catbox.moe/abc.mp3")).toBe("audio");
    expect(attachmentKindOf("https://files.catbox.moe/abc.md")).toBe("text");
    expect(attachmentKindOf("https://files.catbox.moe/abc.zip")).toBe("file");
    expect(attachmentKindOf("https://files.catbox.moe/abc")).toBe("file");
  });
});

describe("kindLabel", () => {
  it("日本語ラベルを返す", () => {
    expect(kindLabel("image")).toBe("画像");
    expect(kindLabel("text")).toBe("テキスト");
    expect(kindLabel("file")).toBe("ファイル");
  });
});

describe("extensionOfUrl / guessedContentType", () => {
  it("クエリ・フラグメントを無視する", () => {
    expect(extensionOfUrl("https://a.example/x/y.tar.gz?download=1")).toBe("gz");
    expect(extensionOfUrl("https://a.example/x/y")).toBe("");
    expect(extensionOfUrl("https://a.example/.hidden")).toBe("");
  });

  it("MIME を推定する", () => {
    expect(guessedContentType("https://a.example/a.jpg")).toBe("image/jpeg");
    expect(guessedContentType("https://a.example/a.png", "image/webp; q=1")).toBe("image/webp");
    expect(guessedContentType("https://a.example/a.unknownext")).toBe("application/octet-stream");
    expect(guessedContentType("https://a.example/a.txt")).toBe("text/plain");
  });
});

describe("contentTypeMatches", () => {
  it("ワイルドカードを解釈する", () => {
    expect(contentTypeMatches("image/png", ["image/*"])).toBe(true);
    expect(contentTypeMatches("image/png", ["video/*"])).toBe(false);
    expect(contentTypeMatches("application/json", ["application/json"])).toBe(true);
    expect(contentTypeMatches("text/plain", ["*/*"])).toBe(true);
    expect(contentTypeMatches("IMAGE/PNG; charset=x", ["image/*"])).toBe(true);
  });
});

describe("attachmentLabel", () => {
  it("名前が無ければ URL の末尾を使う", () => {
    expect(attachmentLabel("pixel.png", "https://x.example/a.png")).toBe("pixel.png");
    expect(attachmentLabel("  ", "https://x.example/dir/pixel%20art.png?x=1")).toBe("pixel art.png");
    expect(attachmentLabel(undefined, "https://x.example/")).toBe("添付ファイル");
  });
});

describe("formatDateTime", () => {
  it("Unix 秒を整形し、不正値は - にする", () => {
    expect(formatDateTime(0)).toBe("-");
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(Number.NaN)).toBe("-");
    expect(formatDateTime(1760000000)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});