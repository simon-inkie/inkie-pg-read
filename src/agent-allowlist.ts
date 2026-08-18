/**
 * agent-allowlist.ts — per-agent table-access control via a per-agent config file.
 *
 * Gate behaviour:
 * - Default-deny: missing config block, missing tables.allow, or empty allow = no access.
 * - Auto-allowed (regardless of config): information_schema.*, pg_catalog.*
 * - Operator mode (no AGENT_NAME): gate is bypassed entirely.
 *
 * Config location: `<agent root>/<AGENT_NAME>/<config file>`, by default
 * `~/agents/<AGENT_NAME>/.pgr-agent.json`. Both halves are overridable —
 * PGR_AGENT_ROOT for the root directory, PGR_AGENT_CONFIG_FILE for the
 * filename — so an existing per-agent layout can be pointed at as-is.
 * See src/agent-paths.ts.
 *
 * Config shape:
 *   {
 *     "pgr": {
 *       "tables": {
 *         "allow": ["ticket_transcripts", ...]
 *       }
 *     }
 *   }
 */

import { readFileSync, existsSync } from "fs";

import { agentConfigPath, tildify } from "./agent-paths.js";

export class AllowlistDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistDeniedError";
  }
}

/** Schemas whose tables are auto-allowed regardless of config. */
const AUTO_ALLOWED_SCHEMAS = new Set(["information_schema", "pg_catalog"]);

/**
 * Resolve the AGENT_NAME for this invocation.
 *
 * Priority:
 * 1. --agent <name> CLI flag (passed in here as agentFlag)
 * 2. process.env.AGENT_NAME
 * 3. undefined (operator mode — no gating)
 */
export function resolveAgentName(agentFlag?: string): string | undefined {
  if (agentFlag) return agentFlag;
  return process.env["AGENT_NAME"];
}

/**
 * Read the pgr allowlist for a given agent from their per-agent config file.
 * Returns an array of allowed table names (lowercased), or an empty array
 * if the config block is missing or empty (default-deny).
 */
export function readAgentAllowlist(agentName: string): string[] {
  const configPath = agentConfigPath(agentName);

  if (!existsSync(configPath)) {
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pgr" in parsed)
  ) {
    return [];
  }

  const pgrBlock = (parsed as Record<string, unknown>)["pgr"];
  if (
    typeof pgrBlock !== "object" ||
    pgrBlock === null ||
    !("tables" in pgrBlock)
  ) {
    return [];
  }

  const tablesBlock = (pgrBlock as Record<string, unknown>)["tables"];
  if (
    typeof tablesBlock !== "object" ||
    tablesBlock === null ||
    !("allow" in tablesBlock)
  ) {
    return [];
  }

  const allow = (tablesBlock as Record<string, unknown>)["allow"];
  if (!Array.isArray(allow)) {
    return [];
  }

  return allow
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
}

/**
 * Check whether a set of table references (from extractTableRefs) are all
 * allowed for the given agent.
 *
 * Returns { allowed: true } if all tables pass.
 * Returns { allowed: false, denied: string[] } if any tables are blocked.
 *
 * Auto-allows schema-qualified refs in information_schema or pg_catalog.
 */
export function checkAllowlist(
  tableRefs: Set<string>,
  agentName: string
): { allowed: true } | { allowed: false; denied: string[] } {
  const allowlist = readAgentAllowlist(agentName);
  const allowSet = new Set(allowlist.map((t) => t.toLowerCase()));

  const denied: string[] = [];

  for (const ref of tableRefs) {
    // Check if schema-qualified and in an auto-allowed schema
    const dotIdx = ref.indexOf(".");
    if (dotIdx !== -1) {
      const schema = ref.slice(0, dotIdx);
      if (AUTO_ALLOWED_SCHEMAS.has(schema)) {
        continue; // auto-allowed
      }
      // For schema-qualified refs in non-auto schemas, check both
      // "schema.table" and bare "table" against the allowlist.
      const tablePart = ref.slice(dotIdx + 1);
      if (allowSet.has(ref) || allowSet.has(tablePart)) {
        continue;
      }
      denied.push(ref);
    } else {
      if (allowSet.has(ref)) {
        continue;
      }
      denied.push(ref);
    }
  }

  if (denied.length > 0) {
    return { allowed: false, denied };
  }
  return { allowed: true };
}

/**
 * Build the denial error message for a failed allowlist check.
 * Uses the first denied table in the message (most common case is one table).
 */
export function buildDenialMessage(
  denied: string[],
  agentName: string
): string {
  const first = denied[0]!;
  const configPath = tildify(agentConfigPath(agentName));
  return [
    `pgr: access denied for table \`${first}\`.`,
    `Reason: not in your agent allowlist (${configPath} -> pgr.tables.allow).`,
    `To grant access, add the table to that file's allow list:`,
    `  { "pgr": { "tables": { "allow": ["${first}"] } } }`,
    `If that file isn't yours to edit, ask whoever owns it to add the table(s) you need.`,
  ].join("\n");
}
