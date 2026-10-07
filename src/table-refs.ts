/**
 * table-refs.ts — extract referenced table names from a SQL query.
 *
 * Design:
 * - Regex-based, not a full AST. Bias toward over-rejection (false positives)
 *   rather than under-rejection (false negatives that let through denied tables).
 * - Handles: FROM clauses, all JOIN types, CTEs (WITH ... AS), schema-qualified
 *   names (information_schema.tables → "information_schema.tables" as full ref,
 *   but the table name and schema are both surfaced).
 * - Ignores aliases, subquery shapes (SELECT inside parens), and string literals.
 * - Schema-qualified tables are returned in "schema.table" form so the caller
 *   can whitelist them by schema prefix.
 */

/**
 * Strip single-quoted string literals from SQL to prevent false matches
 * on table-name-shaped content inside strings.
 * Double-quoted identifiers are left alone (they may be table names).
 */
function stripStringLiterals(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      // Skip to end of single-quoted string, handling '' escape
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // escaped quote
        } else if (sql[i] === "'") {
          i++; // closing quote
          break;
        } else {
          i++;
        }
      }
      result += " "; // placeholder to preserve spacing
    } else {
      result += sql[i];
      i++;
    }
  }
  return result;
}

/**
 * Strip SQL comments (-- and /* * /) to avoid matching table-name patterns
 * inside comment text.
 */
function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      result += " ";
    } else if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length - 1) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      result += " ";
    } else {
      result += sql[i];
      i++;
    }
  }
  return result;
}

/**
 * Normalise a raw identifier from a SQL query:
 * - Strip double-quote wrappers from quoted identifiers ("my_table" → my_table)
 * - Lowercase (SQL identifiers are case-insensitive)
 */
function normaliseIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).toLowerCase();
  }
  return trimmed.toLowerCase();
}

/**
 * A double-quoted or unquoted SQL identifier, optionally schema-qualified.
 * Matches: tablename, schema.tablename, "My Table", "schema"."tablename"
 */
const IDENT = `(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const SCHEMA_TABLE = `(${IDENT}(?:\\.${IDENT})?)`;

/**
 * After FROM or JOIN keyword, what follows:
 * - Possibly whitespace
 * - Then an identifier (possibly schema-qualified)
 * - Optionally an alias (AS name or bare name, not a keyword)
 *
 * We capture only the table reference, not the alias.
 */
const TABLE_REF_AFTER_KEYWORD = new RegExp(
  `\\b(?:FROM|JOIN|INNER\\s+JOIN|LEFT\\s+(?:OUTER\\s+)?JOIN|RIGHT\\s+(?:OUTER\\s+)?JOIN|FULL\\s+(?:OUTER\\s+)?JOIN|CROSS\\s+JOIN|NATURAL\\s+JOIN)\\s+${SCHEMA_TABLE}`,
  "gi"
);

/**
 * CTE name definition: WITH name AS (...)
 * Captured group is the CTE name.
 */
const CTE_NAME_RE = /\bWITH\b[\s\S]*?\b(\w+)\s+AS\s*\(/gi;
const ADDITIONAL_CTE_RE = /,\s*(\w+)\s+AS\s*\(/gi;

/**
 * Extract all real table names referenced in a SQL query.
 *
 * Returns a Set of lower-cased table names (or "schema.table" strings for
 * schema-qualified references). CTE names defined in the WITH clause are
 * excluded from the set — they are virtual tables, not real ones.
 *
 * Schema-qualified references like `information_schema.tables` are returned
 * as "information_schema.tables" so the caller can match by schema prefix.
 */
export function extractTableRefs(sql: string): Set<string> {
  // Pre-process: strip comments and string literals to avoid false matches
  const cleaned = stripStringLiterals(stripComments(sql));

  // Collect CTE names so we can exclude them from results
  const cteNames = new Set<string>();

  // Match the first CTE name after WITH
  const withMatch = /\bWITH\b\s+(\w+)\s+AS\s*\(/gi;
  for (const m of cleaned.matchAll(withMatch)) {
    cteNames.add(m[1]!.toLowerCase());
  }

  // Match additional CTE names (after commas at the same nesting level)
  // Simpler: collect all `name AS (` patterns globally; they may over-collect
  // but false inclusions only cause us to whitelist more virtual tables, not less.
  const asParenRe = /\b(\w+)\s+AS\s*\(/gi;
  for (const m of cleaned.matchAll(asParenRe)) {
    const candidate = m[1]!.toLowerCase();
    // Exclude SQL keywords that appear in this pattern (e.g. "NOT AS (" — shouldn't happen
    // but be safe) and very short ones that look like SQL reserved words
    if (!SQL_KEYWORDS.has(candidate)) {
      cteNames.add(candidate);
    }
  }

  // Extract FROM/JOIN targets
  const refs = new Set<string>();
  TABLE_REF_AFTER_KEYWORD.lastIndex = 0;

  for (const m of cleaned.matchAll(TABLE_REF_AFTER_KEYWORD)) {
    const raw = m[1]!;
    // Schema-qualified: split and normalise both parts
    if (raw.includes(".")) {
      const parts = raw.split(".");
      const schema = normaliseIdentifier(parts[0]!);
      const table = normaliseIdentifier(parts[1]!);
      refs.add(`${schema}.${table}`);
    } else {
      const name = normaliseIdentifier(raw);
      refs.add(name);
    }
  }

  // Remove CTE names — they are virtual, not real tables
  for (const cte of cteNames) {
    refs.delete(cte);
  }

  return refs;
}

/**
 * Common SQL keywords that can appear before AS ( in various contexts.
 * These are excluded from CTE name collection to avoid false positives.
 */
const SQL_KEYWORDS = new Set([
  "select", "from", "where", "join", "on", "and", "or", "not",
  "in", "is", "null", "true", "false", "case", "when", "then",
  "else", "end", "group", "order", "by", "having", "limit", "offset",
  "union", "intersect", "except", "all", "distinct", "into", "values",
  "insert", "update", "delete", "drop", "alter", "create", "set",
  "with", "recursive", "lateral", "exists", "between", "like", "ilike",
  "table", "view", "index", "schema", "database", "if",
]);
