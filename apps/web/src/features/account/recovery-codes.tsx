"use client";

// リカバリーコードの一度きり表示（コピー・テキスト保存）。

import { useState } from "react";

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const content = [
      "おーぷんクローン 復旧コード",
      "パスワードを忘れたときに 1 回だけ使えます。人に見せないでください。",
      "",
      ...codes,
      "",
      `発行: ${new Date().toISOString()}`,
    ].join("\n");
    const blob = new Blob([`${content}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "open-clone-recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <div className="oc-stack">
      <div className="oc-warn-box">
        復旧コードは<strong>この画面でのみ表示</strong>されます。パスワードを忘れたとき（メール＋コード）と、
        TOTP 端末をなくしたとき（パスワード＋コード）に 1 回だけ使えます。安全な場所に保存してください。
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
        <button type="button" className="oc-btn" onClick={download}>
          {saved ? "保存しました" : "テキストで保存"}
        </button>
        <span className="oc-note">印刷・パスワード管理ツール等に保管してください。</span>
      </div>
    </div>
  );
}