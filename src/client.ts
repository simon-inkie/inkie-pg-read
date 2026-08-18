/**
 * Postgres connection helper.
 *
 * Opens a single connection per invocation, sets the session read-only at the
 * Postgres level, applies a 30s statement timeout, and ensures the connection
 * is closed on exit via try/finally in the caller.
 */

import postgres from "postgres";
import { assertSafeQuery } from "./sql-guard.js";

export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  rowCount: number;
}

/**
 * Create a single-connection postgres client.
 * The caller is responsible for calling sql.end() in a finally block.
 *
 * WARNING — NOT covered by the SQL guard. The returned client's raw query
 * methods (`.unsafe()`, tagged-template queries, etc.) send whatever they are
 * given: SELECT, DML, DDL. The guard (`assertSafeQuery`) is never applied to
 * them. Writes are still refused, but by Postgres (see
 * `default_transaction_read_only` below) rather than by anything in this
 * process, so they fail as a server error at execution time, not as a
 * SqlGuardError before the connection opens.
 *
 * `runQuery` is the safe entry point for arbitrary caller-supplied SQL — it
 * calls `assertSafeQuery` before opening a connection. If you use
 * `createClient` directly to run untrusted or caller-supplied SQL, you must
 * call `assertSafeQuery` on that SQL yourself first.
 */
export function createClient(connectionString: string): postgres.Sql {
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 60,
    connect_timeout: 15,
    // Session parameters sent in the Postgres startup packet.
    // (works on direct connections; not all poolers support it)
    connection: {
      statement_timeout: 30_000, // 30 seconds
      // THE read-only guarantee. Postgres itself rejects any write attempt on
      // this session — INSERT/UPDATE/DELETE/DDL, or a SELECT calling a
      // write-capable function — regardless of what the connected role is
      // actually granted. This holds even if a caller supplies superuser
      // credentials, which is what makes "read-only by construction" true
      // rather than a convention about which role you point pgr at. The
      // SELECT-only role and the string-level SQL guard are the other two
      // layers; this one is enforced by the server.
      default_transaction_read_only: true,
    },
    // Don't print notices to stdout — they'd corrupt JSON output
    onnotice: () => {},
  });
}

/**
 * Execute a SQL query and return all rows.
 * Opens + closes the connection for you (single-invocation pattern).
 *
 * The SQL guard runs first, before any connection is opened, so an unsafe
 * query is rejected with SqlGuardError without touching the network. This is
 * the safe entry point for programmatic consumers — the CLI is not the only
 * caller, so the guard lives here rather than only at the CLI boundary.
 */
export async function runQuery(
  connectionString: string,
  sql: string
): Promise<QueryResult> {
  // SQL guard — reject before opening a connection. Let SqlGuardError
  // propagate; callers (e.g. src/cli.ts) handle it where they need to.
  assertSafeQuery(sql);

  const client = createClient(connectionString);
  try {
    const result = await client.unsafe(sql);
    return {
      rows: result as Row[],
      rowCount: result.length,
    };
  } finally {
    await client.end();
  }
}
