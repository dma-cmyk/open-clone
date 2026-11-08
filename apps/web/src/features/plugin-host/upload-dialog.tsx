"use client";

// プラグイン RPC `upload.start` のホスト UI。
// iframe から直接ファイルを選ばせず、ホストがアップローダ（WP4 の uploadFile）を提示する。
// ファイル本体は従来どおり外部保存先へ送られ、Cloudflare には保存されない。

import { useState } from "react";
import { Modal, Button, Notice } from "@/components/ui";
import { uploadFile } from "@/components/uploader";

export type PluginUploadResult = { started: boolean; url?: string };

export function PluginUploadDialog({
  open,
  pluginName,
  boardId,
  onDone,
}: {
  open: boolean;
  pluginName: string;
  boardId?: number;
  onDone: (result: PluginUploadResult) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    if (busy) return;
    setFile(null);
    setError(null);
    onDone({ started: false });
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadFile({ file, boardId, purpose: "post" });
      setFile(null);
      onDone({ started: true, url: uploaded.url });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "アップロードに失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`${pluginName} のアップロード`}
      onClose={cancel}
      width={460}
      footer={
        <>
          <Button onClick={cancel} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => void upload()} disabled={!file || busy}>
            {busy ? "送信中…" : "アップロード"}
          </Button>
        </>
      }
    >
      <p className="oc-muted oc-small">
        このファイルは外部の保存先へ送られ、投稿への添付に使う URL がプラグインへ返されます。
      </p>
      <input
        type="file"
        aria-label="アップロードするファイル"
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setError(null);
        }}
      />
      {file ? <p className="oc-small">{file.name}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Modal>
  );
}