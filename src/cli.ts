#!/usr/bin/env bun
/**
 * pgr CLI entry point
 *
 * Usage:
 *   pgr "<SELECT query>"
 *   pgr --format=table "<query>"
 *   pgr --format=csv "<query>"
 *   pgr --format=json "<query>"
 *   pgr --output=file.json "<query>"
 *   pgr --agent=<name> "<query>"   (override AGENT_NAME for per-agent gating)
 *   pgr --help
 *   pgr --version
 */

import { join } from "path";

import { resolveConnectionConfig, passEntry } from "./auth.js";
import { assertSafeQuery, SqlGuardError } from "./sql-guard.js";
import { extractTableRefs } from "./table-refs.js";
import {
  resolveAgentName,
  resolveAllowlistScope,
  checkAgainstAllowlist,
  buildDenialMessage,
  buildCwdDenialMessage,
  CWD_CONFIG_FILE,
  AllowlistDeniedError,
  type AllowlistScope,
} from "./agent-allowlist.js";
import { writeAuditLog } from "./audit-log.js";
import { runQuery } from "./client.js";
import { renderOutput, type OutputFormat } from "./output.js";
import { agentRoot, agentConfigPath, tildify } from "./agent-paths.js";

const VERSION = "0.1.0";

/**
 * Help text, built against the live resolved conventions so the paths shown
 * are the ones pgr will actually read on this machine, not stale defaults.
 */
function helpText(): string {
  const credsPath = tildify(join(agentRoot(), "<name>", ".pgr-creds.age"));
  const configPath = tildify(agentConfigPath("<name>"));
  const entry = passEntry();

  return `
pgr — ad-hoc read-only Postgres query CLI

Usage:
  pgr [options] "<SELECT query>"
  pgr --help
  pgr --version

Options:
  --format=<json|table|csv>   Output format (default: json)
  --output=<file>             Write output to file instead of stdout
  --agent=<name>              Override AGENT_NAME for per-agent table gating
  --help                      Show this help
  --version                   Show version

Auth (resolved in priority order):
  1. SUPABASE_DB_URL           Full postgres connection string
  2. ${credsPath}    (per-agent creds file, canonical for agents)
  3. pass ${entry}  (readonly role, canonical for operators)

  The pgr_readonly role (sources 2-3) is the real security boundary
  (SELECT-only grants, BYPASSRLS). There is no write-capable source: pgr has
  no path to a role that can mutate data.

  Paths 2-3 are configurable; set PGR_AGENT_ROOT / PGR_PASS_ENTRY to
  point them at an existing layout.

SQL guard:
  Only SELECT statements are allowed. CTEs (WITH ... SELECT) are supported.
  Multiple statements, DML, DDL, and dollar-quoted strings are rejected.

Per-agent table gating:
  When AGENT_NAME is set (or --agent is used), only tables listed in
  ${configPath} → pgr.tables.allow are accessible.
  (Override that location with PGR_AGENT_ROOT / PGR_AGENT_CONFIG_FILE.)

  With no AGENT_NAME and no --agent, pgr looks for ${CWD_CONFIG_FILE} in the
  directory you run it from. If that file is there, it gates the query the
  same way: same file shape, same default-deny (a file with no
  pgr.tables.allow list allows no tables). That location is fixed —
  PGR_AGENT_ROOT / PGR_AGENT_CONFIG_FILE do not move it.

  Both gated modes always allow information_schema and pg_catalog.
  To grant access, add the table to that file's pgr.tables.allow list.

  With no AGENT_NAME, no --agent and no ${CWD_CONFIG_FILE} in the current
  directory, the gate is bypassed (operator mode).

Examples:
  pgr "select id, created_at from audit_events order by created_at desc limit 20"
  pgr --format=table "select count(*) as n from tickets"
  pgr --format=csv --output=out.csv "select * from tickets limit 100"
  pgr "with recent as (select * from audit_events limit 5) select * from recent"
`.trim();
}

function parseArgs(argv: string[]): {
  query: string | null;
  format: OutputFormat;
  outputFile: string | undefined;
  agentFlag: string | undefined;
  help: boolean;
  version: boolean;
} {
  let query: string | null = null;
  let format: OutputFormat = "json";
  let outputFile: string | undefined;
  let agentFlag: string | undefined;
  let help = false;
  let version = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg.startsWith("--format=")) {
      const val = arg.slice("--format=".length);
      if (val !== "json" && val !== "table" && val !== "csv") {
        process.stderr.write(
          `Error: unknown format "${val}". Use json, table, or csv.\n`
        );
        process.exit(1);
      }
      format = val as OutputFormat;
    } else if (arg.startsWith("--output=")) {
      outputFile = arg.slice("--output=".length);
    } else if (arg.startsWith("--agent=")) {
      agentFlag = arg.slice("--agent=".length);
    } else if (!arg.startsWith("--")) {
      // Positional argument — the SQL query
      if (query !== null) {
        process.stderr.write(
          "Error: multiple positional arguments — wrap your query in quotes.\n"
        );
        process.exit(1);
      }
      query = arg;
    } else {
      process.stderr.write(`Error: unknown option ${arg}\n`);
      process.exit(1);
    }
  }

  return { query, format, outputFile, agentFlag, help, version };
}

/**
 * What to record in the audit log's `agent` field.
 *
 * There is no agent name in the working-directory case, but "operator" would
 * be wrong: that entry was gated, and the audit trail has to say so. A fixed
 * "cwd-project" label reads distinctly from both an agent name and an
 * ungated operator invocation.
 */
function auditAgentLabel(scope: AllowlistScope): string {
  switch (scope.mode) {
    case "agent":
      return scope.agentName;
    case "cwd":
      return "cwd-project";
    case "operator":
      return "operator";
  }
}

async function main(): Promise<void> {
  // Bun: process.argv = [bun, script, ...args]
  const args = process.argv.slice(2);
  const { query, format, outputFile, agentFlag, help, version } = parseArgs(args);

  if (help || args.length === 0) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }

  if (version) {
    process.stdout.write(`pgr v${VERSION}\n`);
    process.exit(0);
  }

  if (!query) {
    process.stderr.write("Error: no query provided. Use --help for usage.\n");
    process.exit(1);
  }

  // SQL guard — reject before touching the network
  try {
    assertSafeQuery(query);
  } catch (err) {
    if (err instanceof SqlGuardError) {
      process.stderr.write(err.message + "\n");
      process.exit(1);
    }
    throw err;
  }

  // Table-allowlist gate: per-agent file, else a working-directory file, else
  // operator mode (no gate). See resolveAllowlistScope.
  const agentName = resolveAgentName(agentFlag);
  const tableRefs = extractTableRefs(query);
  const scope = resolveAllowlistScope(agentName);

  if (scope.mode !== "operator") {
    const result = checkAgainstAllowlist(tableRefs, scope.allow);
    if (!result.allowed) {
      const msg =
        scope.mode === "agent"
          ? buildDenialMessage(result.denied, scope.agentName)
          : buildCwdDenialMessage(result.denied, scope.configPath);
      process.stderr.write(msg + "\n");

      // Audit the denial (best-effort)
      writeAuditLog({
        ts: new Date().toISOString(),
        agent: auditAgentLabel(scope),
        sql: query,
        tables_referenced: Array.from(tableRefs),
        decision: "deny",
        reason: `${result.denied.join(", ")} not in allowlist`,
      });

      process.exit(1);
    }
  }

  // Audit the allowed invocation (best-effort, before query to capture intent)
  writeAuditLog({
    ts: new Date().toISOString(),
    agent: auditAgentLabel(scope),
    sql: query,
    tables_referenced: Array.from(tableRefs),
    decision: "allow",
  });

  // Resolve connection
  let connectionString: string;
  try {
    const config = resolveConnectionConfig();
    connectionString = config.connectionString;
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n"
    );
    process.exit(1);
  }

  // Execute
  try {
    const { rows } = await runQuery(connectionString, query);
    renderOutput(rows, format, outputFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Query error: ${msg}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
