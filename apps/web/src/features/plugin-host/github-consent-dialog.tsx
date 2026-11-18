"use client";

// プラグイン RPC `github.gist` / `github.repo` のホスト確認 UI。
//
// 権限を宣言したプラグインは利用者本人の GitHub に書き込めるため、ホストが必ず
// 「どこに・何を・どれだけ」書き込むかを見せてから実行する（黙って書き込ませない）。
// 表示する値は bridge が freeze した payload そのもので、同意後に同じオブジェクトを送る。

import { Button, Modal } from "@/components/ui";
import type { GithubConsentRequest } from "./bridge";

/** 内容の大きさ（バイト）。送信する文字列そのものから数える。 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const PREVIEW_LINES = 3;

export function PluginGithubConsentDialog({
  request,
  onDone,
}: {
  request: GithubConsentRequest;
  onDone: (allowed: boolean) => void;
}) {
  const content = request.payload.content;
  const lines = content.split(/\r?\n/);
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const remaining = Math.max(0, lines.length - PREVIEW_LINES);
  const destination =
    request.kind === "gist"
      ? `Gist「${request.payload.filename}」（${request.payload.public ? "公開" : "非公開"}）`
      : `${request.payload.owner}/${request.payload.repo} の ${request.payload.path}`;

  return (
    <Modal
      open
      title="GitHub への書き込み"
      onClose={() => onDone(false)}
      width={460}
      footer={
        <>
          <Button onClick={() => onDone(false)}>やめる</Button>
          <Button variant="primary" onClick={() => onDone(true)}>
            書き込む
          </Button>
        </>
      }
    >
      <div data-testid="plugin-github-consent">
        <p className="oc-small" style={{ marginTop: 0 }}>
          プラグイン「{request.pluginName}」が GitHub に書き込みます。内容を確認してください。
        </p>
        <dl className="oc-plugin-github-consent-fields">
          <dt>書き込み先</dt>
          <dd data-testid="plugin-github-consent-destination">{destination}</dd>
          <dt>大きさ</dt>
          <dd data-testid="plugin-github-consent-size">
            {byteLength(content).toLocaleString("ja-JP")} バイト（{lines.length} 行）
          </dd>
          <dt>内容（先頭 {Math.min(lines.length, PREVIEW_LINES)} 行）</dt>
          <dd>
            <pre data-testid="plugin-github-consent-preview" className="oc-plugin-github-consent-preview">
              {preview}
            </pre>
            {remaining > 0 ? <span className="oc-small oc-muted">…（残り {remaining} 行）</span> : null}
          </dd>
        </dl>
        <style>{`
          .oc-plugin-github-consent-fields { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; }
          .oc-plugin-github-consent-fields dt { font-size: 12px; color: var(--oc-muted, #666); }
          .oc-plugin-github-consent-fields dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
          .oc-plugin-github-consent-preview {
            margin: 0; padding: 6px; max-height: 120px; overflow: auto;
            background: var(--oc-surface, #f5f5f5); border: 1px solid var(--oc-border, #ccc);
            border-radius: var(--oc-radius, 3px); font-family: var(--oc-mono, monospace);
            font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
          }
        `}</style>
      </div>
    </Modal>
  );
}