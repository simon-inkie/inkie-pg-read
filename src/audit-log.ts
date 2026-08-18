/**
 * audit-log.ts — best-effort append-only audit log for pgr invocations.
 *
 * Writes to ~/.pgr/audit/YYYY-MM-DD.jsonl (one JSON line per invocation).
 * Creates the directory if missing.
 * On any write failure: logs to stderr, does NOT block the query.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type AuditDecision = "allow" | "deny";

export interface AuditEntry {
  ts: string;
  agent: string;
  sql: string;
  tables_referenced: string[];
  decision: AuditDecision;
  reason?: string;
}

function auditDir(): string {
  return join(homedir(), ".pgr", "audit");
}

function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(auditDir(), `${date}.jsonl`);
}

/**
 * Append an audit entry to today's log file.
 * Best-effort: logs to stderr and returns on any error.
 */
export function writeAuditLog(entry: AuditEntry): void {
  try {
    const dir = auditDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(todayFile(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(
      `pgr audit: write failed — ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
