// shared の TOTP 実装への薄いラッパ（WORKPACKAGES §3.2）。実体は packages/shared/src/lib/totp.ts。
export {
  buildOtpAuthUri,
  decodeTotpSecret,
  generateRecoveryCode,
  generateTotp,
  generateTotpSecret,
  totpCounter,
  verifyTotp,
  type OtpAuthUriOptions,
  type TotpOptions,
  type TotpVerifyOptions,
} from "shared";
