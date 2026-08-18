/**
 * SQL guard: enforces SELECT-only queries.
 *
 * This is a secondary, string-level filter, not a guarantee. The real
 * security boundary is the Postgres role grant (`pgr_readonly`,
 * SELECT-only, BYPASSRLS with a scoped allowlist); see README.md and
 * src/auth.ts. Treat this guard as defence in depth against accidental
 * or injected DML/DDL, not as a bypass-proof gate on its own.
 *
 * Design principles:
 * - Prefer false-positives over false-negatives (reject borderline cases)
 * - Simple regex + quote-aware statement split, no full AST
 * - CTEs (WITH ... SELECT) are explicitly allowed, but a data-modifying
 *   keyword as the first token of any CTE body is rejected (WITH t AS
 *   (INSERT ... RETURNING *) SELECT * FROM t)
 * - SELECT ... INTO (creates a table) is rejected at top level
 */

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(`SQL guard: ${message}`);
    this.name = "SqlGuardError";
  }
}

/**
 * Blocked top-level statement keywords.
 * SET at top-level is blocked; SET inside a CTE body is fine because
 * the CTE rewrite will not produce a top-level match.
 */
const BLOCKED_TOP_LEVEL = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "SET",
  "EXECUTE",
  "CALL",
  "DO",
] as const;

/**
 * Data-modifying keywords that must not appear as the first token of a CTE
 * body. Postgres requires a data-modifying statement to start a CTE body
 * directly (WITH t AS (INSERT ...)); a read CTE body always starts with
 * SELECT, VALUES, or TABLE, so checking the leading keyword is sufficient
 * and does not risk false-positives on legitimate read CTEs.
 */
const WRITE_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "MERGE"] as const;

/**
 * Split a SQL string into individual statements on `;` boundaries,
 * but only when the semicolon is outside of single-quoted or double-quoted
 * string literals. Does not handle dollar-quoted strings (Postgres extension)
 * — those are rejected as borderline.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "'" && !inDouble) {
      if (inSingle && next === "'") {
        // Escaped single quote inside single-quoted string
        current += "''";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ";" && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
    } else {
      current += ch;
    }
    i++;
  }

  const remaining = current.trim();
  if (remaining.length > 0) {
    statements.push(remaining);
  }

  return statements;
}

/**
 * Strip single-line (--) and block (/* *\/) comments from SQL.
 * This prevents bypassing the guard via comment injection.
 */
function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      result += ch;
    } else if (!inSingle && !inDouble && ch === "-" && next === "-") {
      // Single-line comment — skip to end of line
      while (i < sql.length && sql[i] !== "\n") i++;
      result += " "; // preserve spacing
      continue;
    } else if (!inSingle && !inDouble && ch === "/" && next === "*") {
      // Block comment — skip to */
      i += 2;
      while (i < sql.length - 1) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      result += " "; // preserve spacing
      continue;
    } else {
      result += ch;
    }
    i++;
  }

  return result;
}

/**
 * Returns the first non-whitespace keyword of a SQL statement (upper-cased).
 */
function firstKeyword(stmt: string): string {
  const match = /^\s*(\w+)/.exec(stmt);
  return match?.[1]?.toUpperCase() ?? "";
}

/**
 * Validate that a SQL query is a safe SELECT (or CTE that resolves to SELECT).
 * Throws SqlGuardError if the query is not allowed.
 */
export function assertSafeQuery(sql: string): void {
  if (!sql || sql.trim().length === 0) {
    throw new SqlGuardError("empty query");
  }

  // Strip comments before analysis to prevent bypass via comment injection
  const stripped = stripComments(sql);

  // Reject dollar-quoted strings ($$ ... $$) — used in PL/pgSQL function bodies,
  // not needed for plain queries; borderline, so reject.
  if (/\$[A-Za-z0-9_]*\$/.test(stripped)) {
    throw new SqlGuardError(
      "dollar-quoted strings are not allowed (use standard single-quoted strings)"
    );
  }

  // Split on semicolons (quote-aware)
  const statements = splitStatements(stripped);

  if (statements.length === 0) {
    throw new SqlGuardError("empty query");
  }

  if (statements.length > 1) {
    throw new SqlGuardError("multiple statements not allowed");
  }

  const stmt = statements[0]!;
  const kw = firstKeyword(stmt);

  // Allow WITH (CTE) — but verify the outer statement is indeed a CTE SELECT
  // by checking that WITH is followed eventually by SELECT (not DML)
  if (kw === "WITH") {
    // Find the final SELECT after all CTE definitions.
    // We look for the last top-level SELECT by scanning outside parentheses.
    if (!containsTopLevelSelect(stmt)) {
      // Provide a consistent error: the terminating keyword is not SELECT.
      // Could be a DML (INSERT ... WITH ... RETURNING) or malformed CTE.
      const terminator = findCteTerminator(stmt, 4);
      if (terminator && (BLOCKED_TOP_LEVEL as readonly string[]).includes(terminator)) {
        throw new SqlGuardError(`only SELECT statements allowed (got ${terminator} after WITH)`);
      }
      throw new SqlGuardError("only SELECT statements allowed (WITH clause must terminate in SELECT)");
    }
    // Reject a data-modifying statement disguised as a CTE body
    // (WITH t AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM t).
    assertCteBodiesReadOnly(stmt);
    // Reject SELECT ... INTO anywhere at top level, including after the
    // final SELECT of a WITH statement (WITH ... SELECT ... INTO ... FROM).
    assertNoTopLevelInto(stmt);
    return; // CTE is allowed
  }

  if (kw !== "SELECT") {
    // Check if it's an explicitly blocked keyword for a better error message
    if ((BLOCKED_TOP_LEVEL as readonly string[]).includes(kw)) {
      throw new SqlGuardError(`only SELECT statements allowed (got ${kw})`);
    }
    throw new SqlGuardError(`only SELECT statements allowed (got ${kw})`);
  }

  // Reject SELECT ... INTO newtable: creates a table, DDL disguised as SELECT.
  assertNoTopLevelInto(stmt);
}

/**
 * Returns a copy of `sql` with all quoted-string content and all
 * parenthesised content removed, leaving only the top-level (depth-0,
 * unquoted) tokens. Used to scan for keywords that must not appear outside
 * subqueries/CTE bodies/string literals without matching on their contents.
 *
 * Mirrors the escaped-quote handling in splitStatements (a '' pair inside a
 * single-quoted string is an escaped quote, not a terminator): a desync
 * here is a false-negative (a real bypass), not just a false-positive, so
 * it must stay in lockstep with that function.
 */
function maskQuotesAndParens(sql: string): string {
  let result = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "'" && !inDouble) {
      if (inSingle && next === "'") {
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      result += ch;
    }
    i++;
  }

  return result;
}

/**
 * Throws if `INTO` appears as a standalone top-level token, outside string
 * literals and outside parentheses (subqueries, CTE bodies). Catches
 * `SELECT ... INTO newtable FROM ...`, which creates a table.
 */
function assertNoTopLevelInto(stmt: string): void {
  const masked = maskQuotesAndParens(stmt);
  if (/\bINTO\b/i.test(masked)) {
    throw new SqlGuardError(
      "SELECT ... INTO is not allowed (creates a table)"
    );
  }
}

/**
 * Throws if any CTE body (the parenthesised content immediately following
 * `AS` in a WITH clause) begins with a data-modifying keyword, e.g.
 * WITH t AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM t.
 *
 * Walks the statement tracking paren depth; every top-level (depth 0 -> 1)
 * paren group is either a CTE's column list or its body. Checking the
 * leading keyword of each such group is sufficient (see WRITE_KEYWORDS
 * doc comment) and does not descend into nested subqueries, so a
 * legitimate read CTE containing `IN (SELECT ...)` is unaffected.
 */
function assertCteBodiesReadOnly(stmt: string): void {
  let i = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let bodyStart = -1;

  while (i < stmt.length) {
    const ch = stmt[i]!;

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === "(") {
        if (depth === 0) {
          bodyStart = i;
        }
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0 && bodyStart !== -1) {
          const body = stmt.slice(bodyStart + 1, i);
          const bodyKw = firstKeyword(body);
          if ((WRITE_KEYWORDS as readonly string[]).includes(bodyKw)) {
            throw new SqlGuardError(
              `data-modifying statements are not allowed inside a CTE body (got ${bodyKw})`
            );
          }
          bodyStart = -1;
        }
      }
    }
    i++;
  }
}

/**
 * Verify that a WITH ... statement terminates in a top-level SELECT
 * (not a DML statement like INSERT ... WITH ... RETURNING).
 *
 * Scans past balanced parentheses to find the keyword that follows all
 * CTE definitions. This correctly handles nested CTEs and multiple CTE
 * definitions separated by commas.
 *
 * Returns the terminating top-level keyword (upper-cased), or null if
 * we reach end of input without finding one.
 */
function findCteTerminator(sql: string, startAt: number): string | null {
  let i = startAt;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          // We've closed one CTE body. Scan ahead past whitespace.
          let j = i + 1;
          while (j < sql.length && /\s/.test(sql[j]!)) j++;

          // If the next character is a comma, there are more CTE definitions.
          // Skip the comma and continue scanning — the paren counter will
          // pick up the next CTE body.
          if (j < sql.length && sql[j] === ",") {
            i = j + 1; // skip comma, continue scanning
            continue;
          }

          // Otherwise we're at the final statement keyword.
          const remaining = sql.slice(j).trimStart();
          return firstKeyword(remaining).toUpperCase() || null;
        }
      }
    }
    i++;
  }

  return null;
}

function containsTopLevelSelect(sql: string): boolean {
  // Skip past "WITH" keyword and find the terminating statement keyword.
  const terminator = findCteTerminator(sql, 4);
  return terminator === "SELECT";
}
