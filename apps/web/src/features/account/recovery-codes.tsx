"use client";

// リカバリーコードの一度きり表示。

import { useState } from "react";

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="oc-stack">
      <div className="oc-warn-box">
        リカバリーコードは<strong>この画面でのみ表示</strong>されます。TOTP 端末を紛失した際に 1 回だけ使えます。
        安全な場所に保存してください（各コードは単回使用）。
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
          gap: 6,
          fontFamily: "var(--oc-mono)",
          fontSize: 13,
        }}
      >
        {codes.map((code) => (
          <code key={code} style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "3px 6px" }}>
            {code}
          </code>
        ))}
      </div>
      <div className="oc-row">
        <button type="button" className="oc-btn" onClick={copy}>
          {copied ? "コピーしました" : "すべてコピー"}
        </button>
        <span className="oc-note">印刷・パスワード管理ツール等に保管してください。</span>
      </div>
    </div>
  );
}