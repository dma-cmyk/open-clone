import { it, expect } from "vitest";
import { _desEncryptBlockForTest } from "./des";

it("FIPS DES: key 0x133457799BBCDFF1, pt 0x0123456789ABCDEF → ct 0x85E813540F0AB405", () => {
  const key = new Uint8Array([0x13, 0x34, 0x57, 0x79, 0x9b, 0xbc, 0xdf, 0xf1]);
  const [hi, lo] = _desEncryptBlockForTest(key, 0x01234567, 0x89abcdef);
  expect([hi, lo]).toEqual([0x85e81354, 0x0f0ab405]);
});

it("DES: key all-zero, pt all-zero → 0x8CA64DE9C1B123A7", () => {
  const key = new Uint8Array(8);
  const [hi, lo] = _desEncryptBlockForTest(key, 0, 0);
  expect([hi, lo]).toEqual([0x8ca64de9, 0xc1b123a7]);
});
