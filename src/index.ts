/**
 * pgr — public exports for programmatic use
 */

export { assertSafeQuery, SqlGuardError } from "./sql-guard.js";
export { resolveConnectionConfig } from "./auth.js";
export { createClient, runQuery } from "./client.js";
export { formatJson, formatCsv, formatTable, renderOutput } from "./output.js";
export type { OutputFormat, Row } from "./output.js";
export type { ConnectionConfig } from "./auth.js";
export type { QueryResult } from "./client.js";
export { extractTableRefs } from "./table-refs.js";
export {
  resolveAgentName,
  resolveAllowlistScope,
  readAgentAllowlist,
  readAllowlistFromFile,
  readAllowConfigFromFile,
  parseAllowConfig,
  cwdConfigPath,
  CWD_CONFIG_FILE,
  checkAllowlist,
  checkAgainstAllowlist,
  buildDenialMessage,
  buildCwdDenialMessage,
  buildColumnDenialMessage,
  AllowlistDeniedError,
  AllowlistConfigError,
} from "./agent-allowlist.js";
export type { AllowlistScope, AllowConfig } from "./agent-allowlist.js";
export { checkColumnAccess } from "./column-guard.js";
export type {
  ColumnRules,
  ColumnViolation,
  ColumnViolationKind,
  ColumnCheckResult,
} from "./column-guard.js";
export { writeAuditLog } from "./audit-log.js";
export type { AuditEntry, AuditDecision } from "./audit-log.js";
