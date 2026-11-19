"use client";

// ペットの文章の表示。HTML として解釈せず、改行を残したまま文字として描く。
// 同じサイト内のパス（`/b/...`）だけをリンクにする（`message-links.ts`）。

import { Link } from "@/app/_shell/router";
import { splitSiteLinks } from "./message-links";

export function PetText({ text }: { text: string }) {
  const tokens = splitSiteLinks(text);
  return (
    <span className="oc-pet-text">
      {tokens.map((token, index) =>
        token.type === "link" ? (
          <Link key={index} href={token.value}>
            {token.value}
          </Link>
        ) : (
          <span key={index}>{token.value}</span>
        ),
      )}
    </span>
  );
}