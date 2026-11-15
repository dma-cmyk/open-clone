// スレ一覧プレビュー（先頭レス＋最新レス）の生成。
// B2: OP 抜粋と最新レスで同じレス番号を二重表示しない。
// （board-preview.test.ts がこのロジックの単体テストを持つ）

import type { Post } from "@/features/board-ui/types";

export function buildPreview(opPage: { posts: Post[] }, latestPage: { posts: Post[] }): {
  op?: Post;
  latest: Post[];
} {
  return {
    op: opPage.posts.find((post) => post.num === 1),
    latest: latestPage.posts.filter((post) => post.kind !== "tsubuyaki" && post.num !== 1),
  };
}
