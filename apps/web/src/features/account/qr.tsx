"use client";

// otpauth:// URI をクライアントで QR 画像化する（サーバに画像を保存しない）。

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError("QR コードの生成に失敗しました。下の secret を手動で入力してください。");
      });
    return () => {
      cancelled = true;
    };
  }, [text, size]);

  if (error) return <div className="oc-error">{error}</div>;
  if (!dataUrl) return <div className="oc-loading">QR コードを生成中…</div>;
  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt="TOTP 登録用 QR コード"
      style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: 4 }}
    />
  );
}