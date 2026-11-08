import { describe, expect, it } from "vitest";
import { fromBase32, fromHex, hmacSha256Hex, randomHex, randomToken, sha256Hex, timingSafeEqual, toBase32, toHex } from "./hmac";

describe("hmac helpers", () => {
  it("sha256 既知値", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hmacSha256 RFC 4231 Test Case 1", async () => {
    // key=0x0b*20, data="Hi There"
    const key = new Uint8Array(20).fill(0x0b);
    await expect(hmacSha256Hex(key, "Hi There")).resolves.toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("hex 往復", () => {
    expect(toHex(fromHex("0123456789abcdef"))).toBe("0123456789abcdef");
    expect(() => fromHex("zz")).toThrow(TypeError);
  });

  it("base32 往復", () => {
    const bytes = fromHex("31323334353637383930");
    expect(toBase32(bytes)).toBe("GEZDGNBVGY3TQOJQ");
    expect(Array.from(fromBase32("GEZDGNBVGY3TQOJQ"))).toEqual(Array.from(bytes));
  });

  it("randomHex/randomToken の長さと一意性", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32bytes → 43 chars (no padding)
  });

  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
