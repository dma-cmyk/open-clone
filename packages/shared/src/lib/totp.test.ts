import { describe, expect, it } from "vitest";
import {
  buildOtpAuthUri,
  generateTotp,
  generateTotpSecret,
  verifyTotp,
} from "./totp";
import { toBase32 } from "./hmac";

// RFC 6238 Appendix B（RFC 4226 Appendix D）の SHA-1 テストキー:
// ASCII "12345678901234567890" = 0x3132333435363738393031323334353637383930
const RFC_KEY_BYTES = new TextEncoder().encode("12345678901234567890");
const RFC_SECRET_BASE32 = toBase32(RFC_KEY_BYTES); // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ

// RFC 6238 Appendix B (SHA-1)。Time(s) → 8桁コード
const RFC_6238_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP RFC 6238 Appendix B (SHA-1)", () => {
  for (const [time, code8] of RFC_6238_VECTORS) {
    it(`T=${time} → ${code8}（8桁）`, async () => {
      await expect(generateTotp(RFC_SECRET_BASE32, { time, digits: 8 })).resolves.toBe(code8);
    });

    it(`T=${time} → 6桁は 8桁の下6桁`, async () => {
      await expect(generateTotp(RFC_SECRET_BASE32, { time, digits: 6 })).resolves.toBe(
        code8.slice(2),
      );
    });
  }

  it("hex 表記の RFC キーと同じ結果になる", async () => {
    // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ は "12345678901234567890" の Base32
    expect(RFC_SECRET_BASE32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("verifyTotp", () => {
  const time = 59;
  it("正しいコードを受理", async () => {
    await expect(verifyTotp(RFC_SECRET_BASE32, "287082", { time })).resolves.toBe(true);
  });

  it("誤ったコードを拒否", async () => {
    await expect(verifyTotp(RFC_SECRET_BASE32, "287083", { time })).resolves.toBe(false);
  });

  it("窓 ±1 のコードを受理", async () => {
    // T=59 は counter=1。counter=0 (T=0..29) と counter=2 (T=60..89) のコードも窓内
    const prev = await generateTotp(RFC_SECRET_BASE32, { time: 29 });
    const next = await generateTotp(RFC_SECRET_BASE32, { time: 60 });
    await expect(verifyTotp(RFC_SECRET_BASE32, prev, { time })).resolves.toBe(true);
    await expect(verifyTotp(RFC_SECRET_BASE32, next, { time })).resolves.toBe(true);
  });

  it("window=0 では窓外を拒否", async () => {
    const next = await generateTotp(RFC_SECRET_BASE32, { time: 60 });
    await expect(verifyTotp(RFC_SECRET_BASE32, next, { time, window: 0 })).resolves.toBe(false);
  });

  it("桁数違い・非数字を拒否", async () => {
    await expect(verifyTotp(RFC_SECRET_BASE32, "12345", { time })).resolves.toBe(false);
    await expect(verifyTotp(RFC_SECRET_BASE32, "abcdef", { time })).resolves.toBe(false);
  });
});

describe("secret / otpauth URI", () => {
  it("generateTotpSecret は Base32 で検証できる", async () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes = 32 chars
    const code = await generateTotp(secret, { time: 59 });
    await expect(verifyTotp(secret, code, { time: 59 })).resolves.toBe(true);
  });

  it("buildOtpAuthUri が要件の形式", () => {
    const uri = buildOtpAuthUri("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { accountName: "special" });
    expect(uri).toBe(
      "otpauth://totp/OpenClone:special?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=OpenClone&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("secret は lowercase / 空白 / ハイフンを許容", async () => {
    await expect(
      generateTotp("gezd gnbv-gy3t qojq gezdgnbvgy3tqojq", { time: 59, digits: 8 }),
    ).resolves.toBe("94287082");
  });
});
