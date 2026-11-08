import { describe, expect, it } from "vitest";
import {
  attachmentKindOf,
  contentTypeMatches,
  isBlockedUploadFilename,
  sniffContentType,
  uploadExtensionOf,
  uploadPrepareSchema,
} from "./upload";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe("attachmentKindOf", () => {
  it("MIME から表示種別を決める", () => {
    expect(attachmentKindOf("image/png")).toBe("image");
    expect(attachmentKindOf("video/mp4")).toBe("video");
    expect(attachmentKindOf("audio/mpeg")).toBe("audio");
    expect(attachmentKindOf("text/plain; charset=utf-8")).toBe("text");
    expect(attachmentKindOf("application/json")).toBe("text");
    expect(attachmentKindOf("application/pdf")).toBe("file");
  });
});

describe("sniffContentType", () => {
  it("主要形式のマジックバイトを判定する", () => {
    expect(sniffContentType(png)).toBe("image/png");
    expect(sniffContentType(jpeg)).toBe("image/jpeg");
    expect(sniffContentType(gif)).toBe("image/gif");
    expect(sniffContentType(pdf)).toBe("application/pdf");
    expect(sniffContentType(mp4)).toBe("video/mp4");
  });

  it("判定できないテキストは null", () => {
    expect(sniffContentType(new TextEncoder().encode("hello world"))).toBeNull();
  });
});

describe("contentTypeMatches", () => {
  it("ワイルドカードと完全一致を扱う", () => {
    expect(contentTypeMatches("image/png", ["image/*"])).toBe(true);
    expect(contentTypeMatches("image/png", ["image/jpeg"])).toBe(false);
    expect(contentTypeMatches("application/json", ["application/json"])).toBe(true);
    expect(contentTypeMatches("video/mp4", ["*/*"])).toBe(true);
  });
});

describe("ファイル名の検証", () => {
  it("拡張子を小文字で取り出す", () => {
    expect(uploadExtensionOf("photo.PNG")).toBe("png");
    expect(uploadExtensionOf("archive.tar.gz")).toBe("gz");
    expect(uploadExtensionOf("noext")).toBe("");
    expect(uploadExtensionOf(".hidden")).toBe("");
  });

  it("危険な拡張子を拒否する", () => {
    expect(isBlockedUploadFilename("evil.exe")).toBe(true);
    expect(isBlockedUploadFilename("doc.DOCX")).toBe(true);
    expect(isBlockedUploadFilename("image.png")).toBe(false);
  });
});

describe("uploadPrepareSchema", () => {
  it("Content-Type を正規化し、boardId を任意で受ける", () => {
    const parsed = uploadPrepareSchema.parse({
      contentType: " IMAGE/PNG ; charset=binary",
      size: 1024,
      filename: "a.png",
    });
    expect(parsed.contentType).toBe("image/png");
    expect(parsed.boardId).toBeUndefined();
  });

  it("95MB 超のサイズを拒否する", () => {
    const result = uploadPrepareSchema.safeParse({
      contentType: "video/mp4",
      size: 100 * 1024 * 1024,
      filename: "big.mp4",
    });
    expect(result.success).toBe(false);
  });

  it("アダプタ ID の書式を強制する", () => {
    const result = uploadPrepareSchema.safeParse({
      adapter: "Bad Id!",
      contentType: "image/png",
      size: 10,
      filename: "a.png",
    });
    expect(result.success).toBe(false);
  });
});