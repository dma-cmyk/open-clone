// D1 ヘルパ。N+1 防止の batch() と無料枠ガード（rows_read/written の可視化）を提供する。

/** `batch()` の結果をまとめて受け取り、失敗時は最初のエラーを投げる。 */
export async function batch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  const results = await db.batch(statements);
  for (const result of results) {
    if (!result.success) throw new Error(`D1 batch statement failed: ${result.error ?? "unknown"}`);
  }
  return results;
}

/** 単一ステートメント実行（`run()` の版）。成功も meta を返す。 */
export async function run(stmt: D1PreparedStatement): Promise<D1Response> {
  const response = await stmt.run();
  if (!response.success) throw new Error(`D1 run failed: ${response.error ?? "unknown"}`);
  return response;
}

export interface SqlWriteStats {
  rowsRead: number;
  rowsWritten: number;
  durationMs: number;
}

/** `D1Response.meta` から rows_read/written を取り出す（無料枠ガード: 1投稿 ≤12 行の assert 用）。 */
export function writeStats(response: D1Response): SqlWriteStats {
  const meta = response.meta as { rows_read?: number; rows_written?: number; duration?: number };
  return {
    rowsRead: meta.rows_read ?? 0,
    rowsWritten: meta.rows_written ?? 0,
    durationMs: meta.duration ?? 0,
  };
}

/** `batch()` 全体の rows_read/written を合計する。 */
export function batchWriteStats(results: D1Result[]): SqlWriteStats {
  let rowsRead = 0;
  let rowsWritten = 0;
  let durationMs = 0;
  for (const result of results) {
    const stats = writeStats(result);
    rowsRead += stats.rowsRead;
    rowsWritten += stats.rowsWritten;
    durationMs += stats.durationMs;
  }
  return { rowsRead, rowsWritten, durationMs };
}
