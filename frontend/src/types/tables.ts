/**
 * Tables — mirrors backend/app/schemas/tables.py (limits checked by
 * backend/tests/test_frontend_sync.py). Flows write them (Write to Table node).
 */

export const MAX_TABLES_PER_USER = 100;
export const MAX_ROWS_PER_TABLE = 10_000;

export interface TableInfo {
  table_id: string;
  name: string;
  row_count: number;
  created_at: string;
  updated_at: string;
}

export interface TableRow {
  row_id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** What wrote it last. */
  flow_id: string | null;
  run_id: string | null;
}
