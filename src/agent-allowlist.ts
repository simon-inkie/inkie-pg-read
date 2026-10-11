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
 *         "allow": [
 *           "ticket_transcripts",
 *           { "table": "memberships", "columns": ["id", "role"] }
 *         ]
 *       }
 *     }
 *   }
 *
 * A string entry allows every column of the table. An object entry allows only
 * the listed columns (enforced by column-guard.ts). The `pgr` block is
 * validated strictly: a shape pgr does not understand throws
 * AllowlistConfigError instead of being read as "allow nothing" or, worse,
 * "allow more".
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

import { agentConfigPath, tildify } from "./agent-paths.js";
import type { ColumnViolation } from "./column-guard.js";

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

/** The config file exists but is not a valid pgr allowlist. Always fatal. */
export class AllowlistConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistConfigError";
  }
}

/** What a config file grants: tables, plus column lists for some of them. */
export interface AllowConfig {
  /** Every allowed table, lower-cased (string and object entries alike). */
  tables: string[];
  /** Lower-cased table -> its allowed columns, for object entries only. */
  columnRules: Map<string, string[]>;
}

const EMPTY_CONFIG = (): AllowConfig => ({ tables: [], columnRules: new Map() });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

/**
 * Validate and normalise the parsed contents of a config file.
 *
 * Missing `pgr`, `pgr.tables` or `pgr.tables.allow` is not an error: a shared
 * config file may simply not configure pgr, and that stays default-deny.
 * Anything that is present but the wrong shape throws, naming the offending
 * path, so a typo can never quietly turn into different access.
 */
export function parseAllowConfig(parsed: unknown, file: string): AllowConfig {
  const fail = (path: string, problem: string): never => {
    throw new AllowlistConfigError(
      `pgr: invalid allowlist config ${file}: ${path} ${problem}.`
    );
  };

  if (!isPlainObject(parsed)) {
    return fail("(top level)", "must be a JSON object");
  }
  if (!("pgr" in parsed)) return EMPTY_CONFIG();

  const pgr = parsed["pgr"];
  if (!isPlainObject(pgr)) return fail("pgr", "must be an object");
  for (const key of Object.keys(pgr)) {
    if (key !== "tables") return fail(`pgr.${key}`, 'is not a known key (expected "tables")');
  }
  if (!("tables" in pgr)) return EMPTY_CONFIG();

  const tables = pgr["tables"];
  if (!isPlainObject(tables)) return fail("pgr.tables", "must be an object");
  for (const key of Object.keys(tables)) {
    if (key !== "allow") {
      return fail(`pgr.tables.${key}`, 'is not a known key (expected "allow")');
    }
  }
  if (!("allow" in tables)) return EMPTY_CONFIG();

  const allow = tables["allow"];
  if (!Array.isArray(allow)) return fail("pgr.tables.allow", "must be an array");

  const config = EMPTY_CONFIG();
  const seen = new Set<string>();

  allow.forEach((entry, i) => {
    const at = `pgr.tables.allow[${i}]`;
    let table: string;
    let columns: string[] | undefined;

    if (typeof entry === "string") {
      if (entry.trim() === "") return fail(at, "must not be an empty string");
      table = entry.trim().toLowerCase();
    } else if (isPlainObject(entry)) {
      for (const key of Object.keys(entry)) {
        if (key !== "table" && key !== "columns") {
          return fail(`${at}.${key}`, 'is not a known key (expected "table" and "columns")');
        }
      }
      const t = entry["table"];
      if (typeof t !== "string" || t.trim() === "") {
        return fail(`${at}.table`, "must be a non-empty string");
      }
      table = t.trim().toLowerCase();

      const c = entry["columns"];
      if (c === undefined) {
        return fail(
          `${at}.columns`,
          `is required in an object entry (use the plain string "${table}" to allow every column)`
        );
      }
      if (!Array.isArray(c) || c.length === 0) {
        return fail(`${at}.columns`, "must be a non-empty array of column names");
      }
      columns = [];
      c.forEach((col, j) => {
        if (typeof col !== "string" || col.trim() === "" || col.trim() === "*") {
          return fail(
            `${at}.columns[${j}]`,
            `must be a column name, got ${describe(col)} (wildcards are not supported)`
          );
        }
        const name = col.trim().toLowerCase();
        if (!columns!.includes(name)) columns!.push(name);
      });
    } else {
      return fail(at, `must be a table name or { "table", "columns" } object, got ${describe(entry)}`);
    }

    if (seen.has(table)) return fail(at, `lists table "${table}" more than once`);
    seen.add(table);
    config.tables.push(table);
    if (columns) config.columnRules.set(table, columns);
  });

  return config;
}

/**
 * Read and validate a pgr allowlist config file.
 *
 * A missing file is default-deny (empty config). A file that exists but cannot
 * be read, is not JSON, or has a malformed `pgr` block throws
 * AllowlistConfigError: gating on a config the operator thinks is in force but
 * is not would be worse than refusing to run.
 *
 * Shared by both gated tiers, so the per-agent file and the working-directory
 * file cannot drift into two different notions of a valid config.
 */
export function readAllowConfigFromFile(configPath: string): AllowConfig {
  if (!existsSync(configPath)) {
    return EMPTY_CONFIG();
  }
  const file = tildify(configPath);

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new AllowlistConfigError(
      `pgr: cannot read allowlist config ${file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AllowlistConfigError(
      `pgr: invalid allowlist config ${file}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`
    );
  }

  return parseAllowConfig(parsed, file);
}

/**
 * The allowed table names (lowercased) from a config file, whatever columns
 * they are limited to. Empty if the file is missing or has no pgr allowlist
 * (default-deny); throws AllowlistConfigError if the file is malformed.
 */
export function readAllowlistFromFile(configPath: string): string[] {
  return readAllowConfigFromFile(configPath).tables;
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
  | {
      mode: "agent";
      agentName: string;
      configPath: string;
      allow: string[];
      columnRules: Map<string, string[]>;
    }
  | {
      mode: "cwd";
      configPath: string;
      allow: string[];
      columnRules: Map<string, string[]>;
    }
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
    const config = readAllowConfigFromFile(configPath);
    return {
      mode: "agent",
      agentName,
      configPath,
      allow: config.tables,
      columnRules: config.columnRules,
    };
  }

  const configPath = cwdConfigPath(cwd);
  if (existsSync(configPath)) {
    const config = readAllowConfigFromFile(configPath);
    return {
      mode: "cwd",
      configPath,
      allow: config.tables,
      columnRules: config.columnRules,
    };
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

/** One-line description of a column violation, for lists. */
function describeViolation(v: ColumnViolation): string {
  const t = v.table ? `\`${v.table}\`` : "a restricted table";
  switch (v.kind) {
    case "column":
      return `column \`${v.table}.${v.column}\``;
    case "star":
      return `\`*\` over ${t}`;
    case "unqualified":
      return `unqualified column \`${v.column}\` (${t} in scope)`;
    case "whole-row":
      return `whole-row reference \`${v.column}\` to ${t}`;
    case "alias-list":
      return `column alias list on ${t}`;
    case "unresolved":
      return `\`${v.column}\` could not be resolved against ${t}`;
    case "function":
      return `function \`${v.column}\``;
    case "catalog":
      return `statistics relation \`${v.column}\``;
    case "unparseable":
      return "query could not be analysed";
  }
}

/**
 * Build the denial message for a query that reads columns outside a table's
 * column allowlist. Names the first offending column or construct, the table's
 * allowed columns, and the config file; any further violations follow in one
 * line.
 */
export function buildColumnDenialMessage(
  violations: ColumnViolation[],
  configPath: string
): string {
  const first = violations[0]!;
  const file = tildify(configPath);
  const table = first.table ?? "the table";
  const allowed = first.allowed ?? [];
  const list = allowed.join(", ");
  const where = `(${file} -> pgr.tables.allow)`;
  const lines: string[] = [];

  switch (first.kind) {
    case "column": {
      lines.push(`pgr: access denied for column \`${table}.${first.column}\`.`);
      lines.push(`Reason: ${table} has a column allowlist and \`${first.column}\` is not on it ${where}.`);
      lines.push(`Allowed columns: ${list}.`);
      lines.push(`To grant access, add the column to that table's entry:`);
      lines.push(
        `  { "table": "${table}", "columns": ${JSON.stringify([...allowed, first.column])} }`
      );
      break;
    }
    case "star":
      lines.push(`pgr: access denied for \`select *\` on table \`${table}\`.`);
      lines.push(`Reason: ${table} has a column allowlist, and * would read every column ${where}.`);
      lines.push(`Name the columns instead. Allowed columns: ${list}.`);
      break;
    case "unqualified":
      lines.push(`pgr: access denied for unqualified column \`${first.column}\`.`);
      lines.push(`Reason: the query reads \`${table}\`, which has a column allowlist, so pgr cannot tell whether \`${first.column}\` belongs to it ${where}.`);
      lines.push(`Qualify every column with its table or alias, e.g. \`m.${first.column}\`. Allowed columns of ${table}: ${list}.`);
      break;
    case "whole-row":
      lines.push(`pgr: access denied for a whole-row reference to \`${table}\` (\`${first.column}\`).`);
      lines.push(`Reason: a whole row would include every column, and ${table} has a column allowlist ${where}.`);
      lines.push(`Name the columns instead. Allowed columns: ${list}.`);
      break;
    case "alias-list":
      lines.push(`pgr: access denied for a column alias list on table \`${table}\`.`);
      lines.push(`Reason: renaming columns (\`from ${table} as x(a, b)\`) would hide which column is read, and ${table} has a column allowlist ${where}.`);
      lines.push(`Alias the columns in the select list instead.`);
      break;
    case "unresolved":
      lines.push(`pgr: access denied: cannot resolve \`${first.column}\` to a table.`);
      lines.push(`Reason: the query reads \`${table}\`, which has a column allowlist, and pgr cannot prove this reference avoids it ${where}.`);
      lines.push(`Qualify columns with the alias used in the FROM clause.`);
      break;
    case "function":
      lines.push(`pgr: access denied for function \`${first.column}\`.`);
      lines.push(`Reason: it runs SQL from a string, which pgr cannot check against the column allowlists ${where}.`);
      break;
    case "catalog":
      lines.push(`pgr: access denied for \`${first.column}\`.`);
      lines.push(`Reason: statistics views expose sample values of every column, which would sidestep the column allowlists ${where}.`);
      break;
    case "unparseable":
      lines.push(`pgr: access denied: this query could not be analysed.`);
      lines.push(`Reason: a column allowlist is active, and pgr refuses any query it cannot parse, since it cannot tell what it reads ${where}.`);
      lines.push(`Try a simpler form of the query, with explicit, qualified columns.`);
      break;
  }

  if (violations.length > 1) {
    lines.push(`Also denied: ${violations.slice(1).map(describeViolation).join("; ")}.`);
  }
  lines.push(`If that file isn't yours to edit, ask whoever owns it.`);
  return lines.join("\n");
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
