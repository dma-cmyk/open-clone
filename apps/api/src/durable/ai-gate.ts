// AiGate DO（緊急停止フラグ、SQLite-backed）。
// 全 AI 認証はこの DO の `/check` を 1 回読み、全体停止・板停止を秒以内に反映する。
// 解除は人間（owner/special_admin）の API からのみ到達できる（AI の action カタログには存在しない）。

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { BoardStop, StopState } from "shared";
import type { Env } from "../lib/env";

const globalStateSchema = z.object({
  stopped: z.boolean(),
  stoppedAt: z.number().int().nullable(),
  reason: z.string().nullable(),
  actorId: z.string().nullable(),
});

const stopBodySchema = z.object({
  scope: z.enum(["global", "board"]),
  boardId: z.number().int().positive().optional(),
  reason: z.string().min(1).max(500),
  actorId: z.string().max(64).nullable().optional(),
});

const resumeBodySchema = z.object({
  scope: z.enum(["global", "board"]),
  boardId: z.number().int().positive().optional(),
  actorId: z.string().max(64).nullable().optional(),
});

type GlobalState = z.infer<typeof globalStateSchema>;

const EMPTY_GLOBAL: GlobalState = { stopped: false, stoppedAt: null, reason: null, actorId: null };

type BoardRow = {
  board_id: number;
  stopped_at: number;
  reason: string;
  actor_id: string | null;
};

export class AiGate extends DurableObject<Env> {
  private schemaReady = false;

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS gate_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS gate_boards (
         board_id INTEGER PRIMARY KEY,
         stopped_at INTEGER NOT NULL,
         reason TEXT NOT NULL,
         actor_id TEXT
       )`,
    );
    this.schemaReady = true;
  }

  private readGlobal(): GlobalState {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM gate_state WHERE key = 'global'")
      .toArray();
    if (rows.length === 0) return EMPTY_GLOBAL;
    const parsed = globalStateSchema.safeParse(JSON.parse(rows[0]!.value));
    return parsed.success ? parsed.data : EMPTY_GLOBAL;
  }

  private writeGlobal(state: GlobalState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO gate_state (key, value) VALUES ('global', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(state),
    );
  }

  private readBoards(): BoardStop[] {
    return this.ctx.storage.sql
      .exec<BoardRow>("SELECT board_id, stopped_at, reason, actor_id FROM gate_boards ORDER BY board_id")
      .toArray()
      .map((row) => ({
        boardId: row.board_id,
        stoppedAt: row.stopped_at,
        reason: row.reason,
        actorId: row.actor_id,
      }));
  }

  private state(): StopState {
    const global = this.readGlobal();
    const boards = this.readBoards();
    const updatedAt = Math.max(
      global.stoppedAt ?? 0,
      ...boards.map((board) => board.stoppedAt),
      0,
    );
    return {
      globalStopped: global.stopped,
      stoppedAt: global.stoppedAt,
      reason: global.reason,
      actorId: global.actorId,
      boards,
      updatedAt,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);

    try {
      switch (url.pathname) {
        case "/state": {
          return Response.json(this.state());
        }
        case "/check": {
          const boardIdRaw = url.searchParams.get("boardId");
          const boardId = boardIdRaw === null ? null : Number(boardIdRaw);
          const state = this.state();
          if (state.globalStopped) {
            return Response.json({ stopped: true, scope: "global", reason: state.reason });
          }
          if (boardId !== null && state.boards.some((board) => board.boardId === boardId)) {
            const board = state.boards.find((entry) => entry.boardId === boardId)!;
            return Response.json({ stopped: true, scope: "board", reason: board.reason });
          }
          return Response.json({ stopped: false });
        }
        case "/stop": {
          const body = stopBodySchema.parse(await request.json());
          if (body.scope === "global") {
            this.writeGlobal({
              stopped: true,
              stoppedAt: now,
              reason: body.reason,
              actorId: body.actorId ?? null,
            });
          } else {
            if (!body.boardId) throw new Error("boardId is required for board scope");
            this.ctx.storage.sql.exec(
              `INSERT INTO gate_boards (board_id, stopped_at, reason, actor_id) VALUES (?, ?, ?, ?)
               ON CONFLICT(board_id) DO UPDATE SET stopped_at = excluded.stopped_at,
                 reason = excluded.reason, actor_id = excluded.actor_id`,
              body.boardId,
              now,
              body.reason,
              body.actorId ?? null,
            );
          }
          return Response.json(this.state());
        }
        case "/resume": {
          const body = resumeBodySchema.parse(await request.json());
          if (body.scope === "global") {
            this.writeGlobal({ stopped: false, stoppedAt: null, reason: null, actorId: null });
          } else {
            if (!body.boardId) throw new Error("boardId is required for board scope");
            this.ctx.storage.sql.exec("DELETE FROM gate_boards WHERE board_id = ?", body.boardId);
          }
          return Response.json(this.state());
        }
        default:
          return Response.json({ error: "not_found" }, { status: 404 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request";
      return Response.json({ error: message }, { status: 400 });
    }
  }
}