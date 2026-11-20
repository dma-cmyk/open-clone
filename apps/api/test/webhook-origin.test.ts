// F8 受入: GitHub webhook 2 パス（/v1/plugins/hooks/github・/v1/github/hooks/github）の Origin 免除。

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "shared";
import { createAccount, resetWorld } from "./wp1/helpers";

const BASE = "http://worker.test";
const PROD_ORIGIN = "https://open-clone-nine.vercel.app";
const SECRET = "test-github-webhook-secret";

async function withProduction<T>(run: () => Promise<T>): Promise<T> {
  const mutable = env as unknown as { ENVIRONMENT: string; ALLOWED_ORIGINS: string };
  const prev = { ENVIRONMENT: mutable.ENVIRONMENT, ALLOWED_ORIGINS: mutable.ALLOWED_ORIGINS };
  mutable.ENVIRONMENT = "production";
  mutable.ALLOWED_ORIGINS = PROD_ORIGIN;
  try {
    return await run();
  } finally {
    mutable.ENVIRONMENT = prev.ENVIRONMENT;
    mutable.ALLOWED_ORIGINS = prev.ALLOWED_ORIGINS;
  }
}

async function sign(payload: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(SECRET, payload)}`;
}

async function readCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { code?: string };
  return body.code;
}

beforeEach(async () => {
  await resetWorld();
});

afterEach(() => {
  const mutable = env as unknown as { ENVIRONMENT: string };
  mutable.ENVIRONMENT = "development";
});

describe("F8: GitHub webhook の Origin 免除（本番環境）", () => {
  it("Origin なしでも正しい署名なら 2 つの webhook が通る", async () => {
    const pluginPayload = JSON.stringify({
      repository: { full_name: "no-match-owner/no-match-repo" },
      ref: "refs/heads/main",
      commits: [],
    });
    const pluginSig = await sign(pluginPayload);

    const ghPayload = JSON.stringify({ zen: "Keep it logically awesome." });
    const ghSig = await sign(ghPayload);

    await withProduction(async () => {
      const pluginRes = await SELF.fetch(`${BASE}/v1/plugins/hooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": pluginSig,
        },
        body: pluginPayload,
      });
      expect(pluginRes.status).toBe(200);
      expect(((await pluginRes.json()) as { ok: boolean }).ok).toBe(true);

      const ghRes = await SELF.fetch(`${BASE}/v1/github/hooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": ghSig,
          "x-github-delivery": "f8-origin-delivery-1",
          "x-github-event": "ping",
        },
        body: ghPayload,
      });
      expect(ghRes.status).toBe(200);
      expect(((await ghRes.json()) as { ok: boolean; data?: { pong?: boolean } }).data?.pong).toBe(true);
    });
  });

  it("署名ヘッダが無い、または空のときは Origin なしで 403 BAD_ORIGIN", async () => {
    const body = JSON.stringify({ action: "opened" });
    await withProduction(async () => {
      for (const path of ["/v1/plugins/hooks/github", "/v1/github/hooks/github"]) {
        const missing = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(missing.status, `${path} missing`).toBe(403);
        expect(await readCode(missing), `${path} missing`).toBe("BAD_ORIGIN");

        const blank = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": "   ",
          },
          body,
        });
        expect(blank.status, `${path} blank`).toBe(403);
        expect(await readCode(blank), `${path} blank`).toBe("BAD_ORIGIN");
      }
    });
  });

  it("セッション Cookie 付きのときは正しい署名でも Origin なしで 403 BAD_ORIGIN", async () => {
    const account = await createAccount({ name: "webhook-cookie-user" });
    const payload = JSON.stringify({ repository: { full_name: "o/r" } });
    const sig = await sign(payload);

    await withProduction(async () => {
      for (const path of ["/v1/plugins/hooks/github", "/v1/github/hooks/github"]) {
        const res = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": sig,
            "x-github-delivery": "f8-cookie-delivery",
            "x-github-event": "ping",
            cookie: `oc_sess=${account.token}`,
          },
          body: payload,
        });
        expect(res.status, path).toBe(403);
        expect(await readCode(res), path).toBe("BAD_ORIGIN");
      }
    });
  });

  it("他のパスや前方一致（末尾スラッシュ等）は署名付き・Origin なしでも 403 BAD_ORIGIN", async () => {
    const payload = JSON.stringify({ test: true });
    const sig = await sign(payload);

    await withProduction(async () => {
      for (const path of [
        "/v1/plugins/hooks/github/",
        "/v1/plugins/hooks/github/extra",
        "/v1/github/hooks/github/",
        "/v1/github/hooks/other",
        "/v1/boards",
      ]) {
        const res = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": sig,
          },
          body: payload,
        });
        expect(res.status, path).toBe(403);
        expect(await readCode(res), path).toBe("BAD_ORIGIN");
      }
    });
  });

  it("不許可 Origin があるときは署名付きでも 403 BAD_ORIGIN、不正署名は 401", async () => {
    const payload = JSON.stringify({ repository: { full_name: "o/r" } });
    const sig = await sign(payload);

    await withProduction(async () => {
      for (const path of ["/v1/plugins/hooks/github", "/v1/github/hooks/github"]) {
        const evilOrigin = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
            "x-hub-signature-256": sig,
          },
          body: payload,
        });
        expect(evilOrigin.status, `${path} evil`).toBe(403);
        expect(await readCode(evilOrigin), `${path} evil`).toBe("BAD_ORIGIN");

        const badSig = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": "sha256=deadbeef",
          },
          body: payload,
        });
        expect(badSig.status, `${path} badSig`).toBe(401);
      }
    });
  });
});
