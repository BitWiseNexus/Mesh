import type { Flow } from "@/types/flow";

import { contentFingerprint } from "./fingerprint";

export type RecoveryDecision =
  /** Nothing to recover: no backup, or it matches what the server has. */
  | { kind: "none" }
  /** Unsaved edits made on top of the current server version: safe to restore automatically. */
  | { kind: "restore"; flow: Flow }
  /** Unsaved edits based on a different (older/unknown) version: the user must choose. */
  | { kind: "ask"; flow: Flow };

/** Decides what to do with a local backup when a flow is opened from the server. */
export function decideRecovery(
  server: Flow & { version: number },
  backup: { flow: Flow; baseVersion: number | null } | null,
): RecoveryDecision {
  if (!backup || contentFingerprint(backup.flow) === contentFingerprint(server)) {
    return { kind: "none" };
  }
  return backup.baseVersion === server.version
    ? { kind: "restore", flow: backup.flow }
    : { kind: "ask", flow: backup.flow };
}
