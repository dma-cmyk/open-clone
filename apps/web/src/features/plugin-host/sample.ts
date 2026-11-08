// エディタのプレビュー用サンプルデータ。

import type { PluginBoard, PluginPost, PluginThread } from "shared";

export const SAMPLE_BOARD: PluginBoard = {
  id: 1,
  slug: "news",
  name: "ニュース速報",
};

export const SAMPLE_THREAD: PluginThread = {
  id: 1001,
  boardId: 1,
  title: "【速報】テストスレッド",
  postCount: 4,
};

export const SAMPLE_POSTS: PluginPost[] = [
  {
    id: 1,
    num: 1,
    name: "名無しさん",
    body: "1 げっと。ここはテストスレです。",
    createdAt: 1760000000,
    isOp: true,
  },
  {
    id: 2,
    num: 2,
    name: "名無しさん",
    body: ">>1 おめでとう\n[spoiler]これはネタバレです[/spoiler]",
    createdAt: 1760000060,
  },
  {
    id: 3,
    num: 3,
    name: "名無しさん",
    body: "1d6 を振ります → 4",
    createdAt: 1760000120,
  },
  {
    id: 4,
    num: 4,
    name: "名無しさん",
    body: "https://example.com/image.png を貼ったよ",
    createdAt: 1760000180,
  },
];