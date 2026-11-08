// アップローダの公開エントリポイント。
// WP2 の投稿フォームは `<UploaderButton>` を差し込み、履歴は `<UploadHistory>` を使う。
// 添付表示は `<AttachmentViewer>`（画像拡大・動画再生・テキスト閲覧・ダウンロード）。

export { UploaderButton } from "./uploader-button";
export type { UploaderButtonProps } from "./uploader-button";
export { UploadHistory } from "./upload-history";
export type { UploadHistoryProps } from "./upload-history";
export { AttachmentViewer, AttachmentThumb, AttachmentViewerModal } from "./attachment-viewer";
export type { AttachmentViewerProps } from "./attachment-viewer";
export {
  UploadApiError,
  attachmentRawUrl,
  commitUpload,
  deleteAttachment,
  getAttachment,
  listUploaderAdapters,
  listUploadHistory,
  prepareUpload,
  uploadFile,
} from "./api";
export type { AdapterListResult, UploadFileInput, UploadHistoryResult, UploadPreparePlan, UploadPrepareResult } from "./api";
export type { UploadFailure, UploadedAttachment, UploaderButtonHandle, UploadProgress, UploadingFile } from "./types";
export {
  attachmentKindOf,
  attachmentLabel,
  contentTypeMatches,
  extensionOfName,
  extensionOfUrl,
  formatBytes,
  formatDateTime,
  guessedContentType,
  kindLabel,
} from "./format";