/**
 * Knowledge bases — mirrors backend/app/schemas/knowledge.py (limits checked by
 * backend/tests/test_frontend_sync.py).
 */

export const MAX_KB_NAME_LENGTH = 100;
export const MAX_KB_DESCRIPTION_LENGTH = 500;
/** Chunks are measured in characters; the overlap is at most half the chunk size. */
export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 150;
export const MIN_CHUNK_SIZE = 200;
export const MAX_CHUNK_SIZE = 4000;

export interface KnowledgeBase {
  knowledge_base_id: string;
  name: string;
  description: string;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseSettings {
  name: string;
  description: string;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
}

/** A problem with chunk settings (as the backend checks them), or null. */
export function chunkSettingsProblem(size: number, overlap: number): string | null {
  if (!Number.isInteger(size) || size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE) {
    return `Chunk size must be a whole number from ${MIN_CHUNK_SIZE} to ${MAX_CHUNK_SIZE}.`;
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > Math.floor(size / 2)) {
    return `Overlap must be a whole number from 0 to ${Math.floor(size / 2)} (half the chunk size).`;
  }
  return null;
}
