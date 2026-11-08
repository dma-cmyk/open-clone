"use client";

// 未対応パス。404 判定はクライアント API 応答で行い、ここでは導線を出す。
import { Link } from "../router";

export function NotFoundView({ pathname }: { pathname: string }) {
  return (
    <div className="oc-panel">
      <div className="oc-panel-title">ページが見つかりません</div>
      <div className="oc-panel-inner">
        <p>
          <code>{pathname}</code> は存在しないか、移動した可能性があります。
        </p>
        <ul>
          <li>
            <Link href="/">板一覧へ</Link>
          </li>
          <li>
            <Link href="/boards/new">板を作る</Link>
          </li>
          <li>
            <a href="/search">検索</a>
          </li>
        </ul>
      </div>
    </div>
  );
}