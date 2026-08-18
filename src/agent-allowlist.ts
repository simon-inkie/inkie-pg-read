/**
 * agent-allowlist.ts — table-access control via a JSON config file.
 *
 * Three tiers, resolved in order (see resolveAllowlistScope):
 * 1. AGENT_NAME set (or --agent): the per-agent config file, at
 *    `<agent root>/<AGENT_NAME>/<config file>` — by default
 *    `~/agents/<AGENT_NAME>/.pgr-agent.json`. Both halves are overridable —
 *    PGR_AGENT_ROOT for the root directory, PGR_AGENT_CONFIG_FILE for the
 *    filename — so an existing per-agent layout can be pointed at as-is.
 *    See src/agent-paths.ts.
 * 2. No AGENT_NAME, but a `.pgr-agent.json` in the directory pgr was invoked
 *    from: that file gates the invocation. Same file shape, same default-deny,
 *    for a solo user in one project who wants a scoped read without adopting
 *    the per-agent-home layout. The location is deliberately fixed at the
 *    working directory; the PGR_AGENT_* variables do not move it.
 * 3. Neither: operator mode, the gate is bypassed entirely.
 *
 * Gate behaviour in tiers 1 and 2 is identical:
 * - Default-deny: missing config block, missing tables.allow, or empty allow = no access.
 * - Auto-allowed (regardless of config): information_schema.*, pg_catalog.*
 *
 * Config shape (both tiers):
 *   {
 *     "pgr": {
 *       "tables": {
 *         "allow": ["ticket_transcripts", ...]
 *       }
 *     }
 *   }
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
 * Filename pgr looks for in the working directory when AGENT_NAME is unset.
 *
 * Fixed on purpose: the per-agent overrides (PGR_AGENT_ROOT /
 * PGR_AGENT_CONFIG_FILE) exist so an established fleet layout can be pointed
 * at as-is, which has no bearing on a single project directory. One hardcoded
 * name keeps "what gates this invocation" answerable by looking at the
 * directory you're standing in.
 */
export const CWD_CONFIG_FILE = ".pgr-agent.json";

/**
 * Full path to the working-directory config file.
 * `cwd` defaults to process.cwd() — the directory pgr was invoked from — and
 * is a parameter only so callers (and tests) can resolve against a directory
 * without chdir-ing the process.
 */
export function cwdConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, CWD_CONFIG_FILE);
}

/**
 * Read a pgr allowlist out of a config file at a given path.
 * Returns an array of allowed table names (lowercased), or an empty array if
 * the file is missing, unreadable, unparseable, or has no pgr.tables.allow
 * array (default-deny in every one of those cases).
 *
 * Shared by both gated tiers, so the per-agent file and the working-directory
 * file cannot drift into two different notions of a valid config.
 */
export function readAllowlistFromFile(configPath: string): string[] {
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
 * Read the pgr allowlist for a given agent from their per-agent config file.
 * Returns an array of allowed table names (lowercased), or an empty array
 * if the config block is missing or empty (default-deny).
 */
export function readAgentAllowlist(agentName: string): string[] {
  return readAllowlistFromFile(agentConfigPath(agentName));
}

/**
 * Which config file, if any, gates this invocation.
 *
 * - `agent`:    AGENT_NAME (or --agent) is set — the per-agent file, whether
 *               or not it exists (a missing file is default-deny, as before).
 * - `cwd`:      no agent name, but a .pgr-agent.json exists in the working
 *               directory — that file gates, on the same terms.
 * - `operator`: neither — no gate at all.
 *
 * Presence of the working-directory file is what separates `cwd` from
 * `operator`: a file that exists but parses to nothing is default-deny, not a
 * fall-through to unrestricted access.
 */
export type AllowlistScope =
  | { mode: "agent"; agentName: string; configPath: string; allow: string[] }
  | { mode: "cwd"; configPath: string; allow: string[] }
  | { mode: "operator" };

/**
 * Resolve which tier gates this invocation, reading the governing config file
 * once. `cwd` defaults to the process working directory; pass it explicitly
 * only to resolve against some other directory (tests do).
 */
export function resolveAllowlistScope(
  agentName: string | undefined,
  cwd: string = process.cwd()
): AllowlistScope {
  if (agentName !== undefined) {
    const configPath = agentConfigPath(agentName);
    return {
      mode: "agent",
      agentName,
      configPath,
      allow: readAllowlistFromFile(configPath),
    };
  }

  const configPath = cwdConfigPath(cwd);
  if (existsSync(configPath)) {
    return { mode: "cwd", configPath, allow: readAllowlistFromFile(configPath) };
  }

  return { mode: "operator" };
}

/**
 * Check a set of table references (from extractTableRefs) against an already
 * resolved allowlist.
 *
 * Returns { allowed: true } if all tables pass.
 * Returns { allowed: false, denied: string[] } if any tables are blocked.
 *
 * Auto-allows schema-qualified refs in information_schema or pg_catalog.
 */
export function checkAgainstAllowlist(
  tableRefs: Set<string>,
  allowlist: string[]
): { allowed: true } | { allowed: false; denied: string[] } {
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
 * Check table references against a given agent's allowlist, reading their
 * per-agent config file. Convenience wrapper over checkAgainstAllowlist for
 * callers that have an agent name rather than a resolved list.
 */
export function checkAllowlist(
  tableRefs: Set<string>,
  agentName: string
): { allowed: true } | { allowed: false; denied: string[] } {
  return checkAgainstAllowlist(tableRefs, readAgentAllowlist(agentName));
}

/**
 * The common body of a denial message: what was denied, which file governs it,
 * and the exact JSON to add. Callers append their own closing line.
 */
function denialLines(
  denied: string[],
  configPath: string,
  reason: string
): string[] {
  const first = denied[0]!;
  return [
    `pgr: access denied for table \`${first}\`.`,
    `Reason: ${reason} (${tildify(configPath)} -> pgr.tables.allow).`,
    `To grant access, add the table to that file's allow list:`,
    `  { "pgr": { "tables": { "allow": ["${first}"] } } }`,
  ];
}

/**
 * Build the denial error message for a failed per-agent allowlist check.
 * Uses the first denied table in the message (most common case is one table).
 */
export function buildDenialMessage(
  denied: string[],
  agentName: string
): string {
  return [
    ...denialLines(
      denied,
      agentConfigPath(agentName),
      "not in your agent allowlist"
    ),
    `If that file isn't yours to edit, ask whoever owns it to add the table(s) you need.`,
  ].join("\n");
}

/**
 * Build the denial error message for a failed working-directory allowlist
 * check. Names the file that gated the query, since its presence in the
 * current directory is the only reason the gate is on at all.
 */
export function buildCwdDenialMessage(
  denied: string[],
  configPath: string
): string {
  return [
    ...denialLines(denied, configPath, "not in this project's pgr allowlist"),
    `That file is ${CWD_CONFIG_FILE} in the directory you ran pgr from — it is what switched the gate on. Remove it for unrestricted operator access.`,
  ].join("\n");
}
