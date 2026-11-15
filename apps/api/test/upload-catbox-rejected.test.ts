// WP4/A5: Catbox（実装の保存先 https://catbox.moe/user/api.php）が 412 を返す状況を
// MSW でローカルに再現し、Worker の API ルート → 応答翻訳 → envelope までを検証する。
// 実サービスへは送信しない（network.use で上流を差し替える）。
// 目的: 保存先が拒否したときに、利用者が次に取れる操作が分かるメッセージと
// `details.reason = "upstream_blocked"` / `retryable` が返ること（F-03 の回帰防止）。
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { network } from "./network";
import {
  PNG_BYTES,
  anonymousCookie,
  prepareUpload,
  proxyUpload,
  readJson,
  resetWp4State,
  setSiteConfig,
  type ApiEnvelope,
} from "./wp4-helpers";

interface PrepareData {
  ticketId: string;
  adapter: string;
  plan: { mode: string; proxyPath?: string };
  uploadToken?: string;
}

beforeEach(async () => {
  await resetWp4State();
  await setSiteConfig("uploader.require_turnstile", false);
  await setSiteConfig("uploader.default", "catbox");
});

describe("Catbox が保存を拒否したとき（上流 412 / 403）", () => {
  it("412 を BAD_GATEWAY に翻訳し、理由・再試行可・アダプタを details に載せる", async () => {
    let upstream: { contentType: string; text: string } | null = null;
    network.use(
      http.post("https://catbox.moe/user/api.php", async ({ request }) => {
        const text = await request.text();
        upstream = { contentType: request.headers.get("content-type") ?? "", text };
        return new HttpResponse("No file!", { status: 412 });
      }),
    );

    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "rejected.png",
    });
    expect(prep.response.status).toBe(201);
    const prepared = prep.data.data as unknown as PrepareData;
    expect(prepared.adapter).toBe("catbox");

    const proxyResponse = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxyResponse.status).toBe(502);
    const body = await readJson<ApiEnvelope<never>>(proxyResponse);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("BAD_GATEWAY");
    // 利用者が次に何をするか分かる文言（ステータス番号だけでなく案内を出す）
    expect(body.message).toContain("HTTP 412");
    expect(body.message).toContain("再試行");
    expect(body.message).toContain("保存先を別のものに変えてください");
    expect(body.details).toMatchObject({
      upstreamStatus: 412,
      adapter: "catbox",
      reason: "upstream_blocked",
      retryable: true,
    });

    // 上流へは multipart で送っている（実装の成形が壊れていないことの確認）
    expect(upstream).not.toBeNull();
    const sent = upstream as unknown as { contentType: string; text: string };
    expect(sent.contentType).toContain("multipart/form-data; boundary=");
    expect(sent.text).toContain('name="reqtype"');
    expect(sent.text).toContain('name="fileToUpload"');
    expect(sent.text).toContain('filename="rejected.png"');

    // 失敗した ticket は添付を作らない（D1 に残らない）
    const rows = await env.DB.prepare("SELECT id FROM attachments WHERE ticket_id = ?")
      .bind(prepared.ticketId)
      .all<{ id: string }>();
    expect(rows.results.length).toBe(0);
  });

  it("403（bot 判定・IP 制限）も同じ案内を返す", async () => {
    network.use(
      http.post("https://catbox.moe/user/api.php", () => new HttpResponse("forbidden", { status: 403 })),
    );
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "blocked.png",
    });
    const prepared = prep.data.data as unknown as PrepareData;
    const proxyResponse = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxyResponse.status).toBe(502);
    const body = await readJson<ApiEnvelope<never>>(proxyResponse);
    expect(body.code).toBe("BAD_GATEWAY");
    expect(body.details).toMatchObject({ upstreamStatus: 403, reason: "upstream_blocked", retryable: true });
    expect(body.message).toContain("HTTP 403");
  });
});