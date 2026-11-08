// レス投稿ボディの共通パース（L-2）。
// `POST /v1/posts` と `POST /v1/threads/:id/posts` で入力契約を揃え、
// 添付 ID の上限（10 件・各 64 文字）と本文長を zod で強制する。

import { createPostRequestSchema } from "shared";

export interface ParsedPostCreateBody {
  name: string | undefined;
  mail: string | undefined;
  body: string;
  sage: boolean;
  attachmentIds: string[] | undefined;
  turnstileToken: string | undefined;
}

export function parsePostCreateBody(raw: unknown): ParsedPostCreateBody {
  const parsed = createPostRequestSchema.parse(raw);
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const turnstileFromBody = typeof record["cf-turnstile-response"] === "string" ? record["cf-turnstile-response"] : undefined;
  return {
    name: parsed.name,
    mail: parsed.mail,
    body: parsed.body,
    sage: parsed.sage ?? false,
    attachmentIds: parsed.attachments,
    turnstileToken: parsed.turnstileToken ?? turnstileFromBody,
  };
}