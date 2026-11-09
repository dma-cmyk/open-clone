// 表示変換 Worker のメッセージ型（メインスレッドと Worker の両方から使う）。
// Worker は HTML を組み立てず、text/rule の区間（断片）だけを返す。

import type { PluginPostRenderRule } from "shared";
import type { PostRenderSegment } from "./render-rules";

export interface RenderWorkerRequest {
  id: number;
  text: string;
  /** 静的判定は送信前にメインスレッドで済ませた規則だけを渡す。 */
  rules: PluginPostRenderRule[];
}

export type RenderWorkerResponse =
  | {
      type: "rule-start";
      id: number;
      /** これから実行する規則の添字（時間切れ時にこの規則だけを無効化する）。 */
      index: number;
    }
  | {
      type: "done";
      id: number;
      segments: PostRenderSegment[];
    };