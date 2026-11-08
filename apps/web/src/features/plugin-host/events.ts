// プラグイン向けリアルタイムイベントのホスト側バス。
// WP1 の WebSocket / WP2 の投稿処理が publishPluginEvent() を呼ぶと、
// events.subscribe 済みのプラグインへ bridge 経由で配信される。

export interface PluginRuntimePost {
  id: number;
  num: number;
  name: string;
  body: string;
  createdAt: number;
  accountId?: string | null;
  isOp?: boolean;
}

export interface PluginRuntimeThread {
  id: number;
  boardId: number;
  title: string;
  postCount: number;
}

export type PluginRuntimeEvent =
  | { type: "post"; threadId: number; post: PluginRuntimePost }
  | { type: "thread"; boardId: number; thread: PluginRuntimeThread };

const listeners = new Set<(event: PluginRuntimeEvent) => void>();

/** イベントを発行する（購読者がいなければ何もしない）。 */
export function publishPluginEvent(event: PluginRuntimeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn("plugin event listener failed", error);
    }
  }
}

/** 購読を登録し、解除関数を返す。 */
export function subscribePluginEvents(listener: (event: PluginRuntimeEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}