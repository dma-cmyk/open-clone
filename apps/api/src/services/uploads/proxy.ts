// proxy-stream 中継。
// 受信ボディをメモリに溜めず、そのまま外部サービスへパイプする（Cloudflare に保存しない）。
// サイズはストリームを通過するバイト数で強制し、上限超過時は即座に中断する。

import { ApiError, ErrorCode, randomHex } from "shared";
import type { UpstreamTarget } from "./types";

const encoder = new TextEncoder();

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
}

function buildMultipartPrefix(
  multipart: NonNullable<UpstreamTarget["multipart"]>,
  boundary: string,
): Uint8Array<ArrayBuffer> {
  let text = "";
  for (const [name, value] of Object.entries(multipart.fields)) {
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(name)}"\r\n\r\n${value}\r\n`;
  }
  text +=
    `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(multipart.fileField)}"; ` +
    `filename="${escapeQuoted(multipart.filename)}"\r\nContent-Type: ${multipart.contentType}\r\n\r\n`;
  return new Uint8Array(encoder.encode(text));
}

export interface ComposeOptions {
  prefix: Uint8Array<ArrayBuffer>;
  suffix: Uint8Array<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
  maxBytes: number;
  onBytes?: (bytes: number) => void;
  onLimitExceeded?: () => void;
}

/**
 * 先頭/末尾のバイト列と受信ストリームを連結したストリームを作る。
 * 合計が maxBytes を超えたらエラーにする（上流への送信を中断）。
 */
export function composeLimitedStream(options: ComposeOptions): ReadableStream<Uint8Array> {
  const { prefix, suffix, body, maxBytes, onBytes, onLimitExceeded } = options;
  const reader = body ? body.getReader() : null;
  // `pull` ベースにして下流（fetch の送信バッファ）の要求分だけ読む。
  // `start` 内で全チャンクを enqueue すると、上流が遅いときに最大 95MB をメモリへ溜めてしまう。
  let total = 0;
  let phase: "prefix" | "body" | "suffix" | "closed" = "prefix";

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          if (phase === "prefix") {
            phase = "body";
            if (prefix.byteLength > 0) {
              controller.enqueue(prefix);
              return;
            }
            continue;
          }
          if (phase === "body") {
            if (!reader) {
              phase = "suffix";
              continue;
            }
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
              chunk = await reader.read();
            } catch (error) {
              phase = "closed";
              controller.error(error);
              return;
            }
            if (chunk.done) {
              phase = "suffix";
              continue;
            }
            if (!chunk.value || chunk.value.byteLength === 0) continue;
            total += chunk.value.byteLength;
            if (total > maxBytes) {
              phase = "closed";
              onLimitExceeded?.();
              await reader.cancel().catch(() => undefined);
              controller.error(new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "ファイルサイズが上限を超えています"));
              return;
            }
            controller.enqueue(chunk.value);
            return;
          }
          if (phase === "suffix") {
            phase = "closed";
            onBytes?.(total);
            if (suffix.byteLength > 0) controller.enqueue(suffix);
            controller.close();
            return;
          }
          return;
        }
      },
      async cancel(reason) {
        phase = "closed";
        await reader?.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 1 },
  );
}

export interface ProxyUploadResult {
  response: Response;
  bytes: number;
}

/**
 * upstream へ受信ストリームを中継する。multipart 指定時は境界を組んで連結する。
 * @param body 受信ボディ（`c.req.raw.body`）
 * @param maxBytes 中継してよい最大バイト数（アダプタ上限とチケット宣言の小さい方）
 */
export async function sendProxyUpload(
  upstream: UpstreamTarget,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ProxyUploadResult> {
  const headers = new Headers(upstream.headers ?? {});
  let prefix = new Uint8Array(0);
  let suffix = new Uint8Array(0);

  if (upstream.multipart) {
    const boundary = `----openclone${randomHex(12)}`;
    prefix = buildMultipartPrefix(upstream.multipart, boundary);
    suffix = new Uint8Array(encoder.encode(`\r\n--${boundary}--\r\n`));
    headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
  } else if (!headers.has("Content-Type") && body && upstream.contentType) {
    headers.set("Content-Type", upstream.contentType);
  }

  let bytes = 0;
  let limitExceeded = false;
  const stream = composeLimitedStream({
    prefix,
    suffix,
    body,
    maxBytes,
    onBytes: (value) => {
      bytes = value;
    },
    onLimitExceeded: () => {
      limitExceeded = true;
    },
  });

  let response: Response;
  try {
    // Workers は ReadableStream ボディをそのまま転送できる（duplex は Node 互換のみ）
    response = await fetch(upstream.url, {
      method: upstream.method,
      headers,
      body: stream,
    });
  } catch (error) {
    if (limitExceeded) {
      throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "ファイルサイズが上限を超えています");
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, ErrorCode.BAD_GATEWAY, "外部ストレージへの送信に失敗しました");
  }

  return { response, bytes };
}

/** 受信ストリームの先頭バイトを覗き、同じ内容のストリームを返す（マジックバイト検証用）。 */
export async function peekStreamHead(
  body: ReadableStream<Uint8Array> | null,
  headBytes = 64,
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> | null }> {
  if (!body) return { head: new Uint8Array(0), body: null };
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.value ? first.value.slice(0, headBytes) : new Uint8Array(0);

  const reconstructed = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (first.value) controller.enqueue(first.value);
        if (first.done) {
          controller.close();
          return;
        }
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return { head, body: reconstructed };
}