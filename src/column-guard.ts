/**
 * column-guard.ts — column-level access control for allowlisted tables.
 *
 * A `pgr.tables.allow` entry of the form `{ "table": "t", "columns": [...] }`
 * allows only those columns of `t`. This module decides, for one query,
 * whether it can read anything else from such a table.
 *
 * Approach: parse the query into an AST (pgsql-ast-parser), then walk it with
 * a lexical scope chain so each column reference is resolved to the source it
 * belongs to (alias, join member, CTE, derived table, outer query of a
 * correlated subquery). It is deliberately conservative, in the same spirit as
 * the SQL guard: where a reference cannot be proven to be a permitted column of
 * a restricted table, it is refused.
 *
 * Refused, when the query reads a table that has a column list:
 * - a qualified column not in the list (`m.email`)
 * - `select *`, or `m.*`, over a restricted source
 * - an unqualified column while a restricted source is in scope (it could
 *   resolve to the restricted table, and this guard has no catalog to tell)
 * - a whole-row reference (`to_jsonb(m)`, `m::text`, a bare alias)
 * - a column alias list on a restricted table (`from t as m(a, b)` renames
 *   columns out from under the list)
 * - functions that run SQL given as a string (`query_to_xml` and friends)
 * - pg_stats and the other statistics relations, which expose column values
 * - any query this parser cannot read (NATURAL JOIN, `(t).col`, TABLE t, ...):
 *   it cannot be checked, so it is refused whether or not it names a
 *   restricted table
 *
 * Derived tables and CTEs are opaque: their own bodies are checked, so
 * anything they expose is already limited to permitted columns.
 *
 * Out of scope: row-level filtering.
 */

import { parse } from "pgsql-ast-parser";

/** Lower-cased table name (optionally "schema.table") -> allowed column names. */
export type ColumnRules = ReadonlyMap<string, readonly string[]>;

export type ColumnViolationKind =
  | "column" // a qualified column not in the list
  | "star" // select * / t.* over a restricted source
  | "unqualified" // bare column while a restricted source is in scope
  | "whole-row" // bare alias / to_jsonb(t) style reference
  | "alias-list" // from t as m(a, b)
  | "unresolved" // qualifier matches no source
  | "function" // dynamic-SQL function
  | "catalog" // statistics relation that exposes column values
  | "unparseable"; // could not be parsed

export interface ColumnViolation {
  kind: ColumnViolationKind;
  /** The rule key of the restricted table involved, when there is one. */
  table?: string;
  /** The column, function or qualifier involved. */
  column?: string;
  /** The columns that table's rule does allow. */
  allowed?: string[];
}

export type ColumnCheckResult =
  | { allowed: true }
  | { allowed: false; violations: ColumnViolation[] };

/**
 * System relations that expose column values (most common values, histogram
 * bounds). pg_catalog is otherwise always readable, so these are refused
 * whenever column rules are active, in any schema position.
 */
const STATS_RELATIONS = new Set([
  "pg_stats",
  "pg_stats_ext",
  "pg_stats_ext_exprs",
  "pg_statistic",
  "pg_statistic_ext_data",
]);

/**
 * Functions that execute SQL passed as text (or read whole tables by name).
 * They would sidestep both gates, so they are refused whenever column rules
 * are active, in a select list, a WHERE clause or a FROM item alike. This is a
 * denylist, so it cannot be complete (see the README).
 */
const DYNAMIC_SQL_FUNCTIONS = new Set([
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "schema_to_xml",
  "schema_to_xml_and_xmlschema",
  "schema_to_xmlschema",
  "database_to_xml",
  "database_to_xml_and_xmlschema",
  "database_to_xmlschema",
  "ts_stat",
]);

// ── AST access ────────────────────────────────────────────────────────────────
// The parser's types are large and change between versions; the walk only
// needs a handful of shapes, so nodes are treated as loose records.

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Identifiers the parser hands over are already folded the way Postgres folds
 * them: unquoted names are lower-cased, quoted names keep their case. Names
 * that are compared for identity (aliases, qualifiers, columns, CTEs) are
 * therefore used as given, so `m."ROLE"` is not `m.role`. Folding them here
 * would let a quoted name alias an unquoted one and resolve to the wrong
 * source. Only names matched against config (tables, schemas) and the function
 * deny list are lower-cased, which can only over-match.
 */
function id(v: unknown): string | undefined {
  return str(v);
}

function lower(v: unknown): string | undefined {
  return str(v)?.toLowerCase();
}

function nodes(v: unknown): Node[] {
  return Array.isArray(v) ? v.filter(isNode) : [];
}

// ── Scope ─────────────────────────────────────────────────────────────────────

interface Restriction {
  table: string;
  allowed: Set<string>;
}

interface Source {
  /** Name the query uses for it: the alias, else the table name. */
  exposed: string | undefined;
  /** Real table name and schema, for a base table only. */
  base?: string;
  schema?: string;
  restriction: Restriction | null;
}

interface Scope {
  parent: Scope | undefined;
  sources: Source[];
  /** CTE names defined at this level. */
  ctes: Set<string>;
}

function restrictedIn(scope: Scope | undefined): Source[] {
  const found: Source[] = [];
  for (let s = scope; s; s = s.parent) {
    for (const src of s.sources) if (src.restriction) found.push(src);
  }
  return found;
}

function cteVisible(scope: Scope | undefined, name: string): boolean {
  for (let s = scope; s; s = s.parent) if (s.ctes.has(name)) return true;
  return false;
}

/** Innermost source a qualifier (`m` or `schema.t`) refers to. */
function findSource(
  scope: Scope,
  qualifier: { name: string; schema?: string | undefined }
): Source | undefined {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const src of s.sources) {
      if (qualifier.schema === undefined) {
        if (src.exposed === qualifier.name) return src;
      } else if (
        src.base === qualifier.name &&
        (src.schema === undefined || src.schema === qualifier.schema)
      ) {
        return src;
      }
    }
  }
  return undefined;
}

// ── The walk ──────────────────────────────────────────────────────────────────

class Checker {
  readonly violations: ColumnViolation[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly rules: ColumnRules) {}

  private report(v: ColumnViolation): void {
    const key = `${v.kind}|${v.table ?? ""}|${v.column ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.violations.push(v);
  }

  private violation(
    kind: ColumnViolationKind,
    r: Restriction | null,
    column?: string
  ): void {
    this.report({
      kind,
      ...(r ? { table: r.table, allowed: [...r.allowed] } : {}),
      ...(column !== undefined ? { column } : {}),
    });
  }

  /**
   * The restriction for a real table reference, or null if it is unrestricted.
   * A rule applies when the table names match and the schemas agree, or either
   * side leaves the schema unstated: the guard over-restricts rather than guess
   * a search path. If several rules apply, a column must satisfy all of them.
   */
  private restrictionFor(schema: string | undefined, name: string): Restriction | null {
    const matches: Restriction[] = [];
    for (const [key, cols] of this.rules) {
      const dot = key.indexOf(".");
      const ruleSchema = dot === -1 ? undefined : key.slice(0, dot);
      const ruleName = dot === -1 ? key : key.slice(dot + 1);
      if (ruleName !== name) continue;
      if (ruleSchema !== undefined && schema !== undefined && ruleSchema !== schema) {
        continue;
      }
      matches.push({ table: key, allowed: new Set(cols.map((c) => c.toLowerCase())) });
    }
    const [first, ...rest] = matches;
    if (!first) return null;
    return {
      table: first.table,
      allowed: new Set(
        [...first.allowed].filter((c) => rest.every((r) => r.allowed.has(c)))
      ),
    };
  }

  visit(node: unknown, scope: Scope | undefined): void {
    if (Array.isArray(node)) {
      for (const n of node) this.visit(n, scope);
      return;
    }
    if (!isNode(node)) return;

    const type = str(node["type"]);
    if (type === "select") return this.select(node, scope, false);
    if (type === "with") return this.withClause(node, scope);
    if (type === "with recursive") return this.withRecursive(node, scope);
    if (type === "ref") return this.ref(node, scope);
    if (type === "call") return this.call(node, scope);
    this.generic(node, scope);
  }

  private generic(node: Node, scope: Scope | undefined, skip: string[] = []): void {
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || skip.includes(key)) continue;
      this.visit(value, scope);
    }
  }

  private withClause(node: Node, parent: Scope | undefined): void {
    let cur = parent;
    for (const bind of nodes(node["bind"])) {
      // A non-recursive CTE body cannot see its own name: a table of the same
      // name inside it is the real one.
      this.visit(bind["statement"], cur);
      const alias = isNode(bind["alias"]) ? id(bind["alias"]["name"]) : undefined;
      if (alias !== undefined) {
        cur = { parent: cur, sources: [], ctes: new Set([alias]) };
      }
    }
    this.visit(node["in"], cur);
  }

  private withRecursive(node: Node, parent: Scope | undefined): void {
    const alias = isNode(node["alias"]) ? id(node["alias"]["name"]) : undefined;
    const cur: Scope | undefined =
      alias === undefined
        ? parent
        : { parent, sources: [], ctes: new Set([alias]) };
    this.visit(node["bind"], cur);
    this.visit(node["in"], cur);
  }

  private select(node: Node, parent: Scope | undefined, allowStar: boolean): void {
    const scope: Scope = { parent, sources: [], ctes: new Set() };
    const from = nodes(node["from"]);

    // Pass 1: what each FROM item exposes.
    for (const f of from) this.addSource(f, scope);

    // Pass 2: everything that can contain a reference, with all sources known.
    for (const f of from) {
      const join = isNode(f["join"]) ? f["join"] : undefined;
      if (join) {
        this.visit(join["on"], scope);
        this.joinUsing(join, scope);
      }
      if (f["type"] === "statement") this.visit(f["statement"], scope);
      // A function in FROM is checked like any other call (deny list, args).
      if (f["type"] === "call") {
        this.visit({ type: "call", function: f["function"], args: f["args"] }, scope);
      }
    }

    const outputNames = new Set<string>();
    for (const col of nodes(node["columns"])) {
      const expr = col["expr"];
      if (isNode(expr) && expr["type"] === "ref" && expr["name"] === "*") {
        if (!allowStar) this.star(expr, scope);
      } else {
        this.visit(expr, scope);
      }
      const alias = isNode(col["alias"]) ? id(col["alias"]["name"]) : undefined;
      if (alias !== undefined) {
        outputNames.add(alias);
      } else if (isNode(expr) && expr["type"] === "ref" && expr["table"] !== undefined) {
        const name = id(expr["name"]);
        if (name !== undefined && name !== "*") outputNames.add(name);
      }
    }

    // A bare name in ORDER BY resolves to an output column before an input one.
    // Output columns were checked above, so such a name reads nothing new.
    for (const item of nodes(node["orderBy"])) {
      const by = item["by"];
      if (
        isNode(by) &&
        by["type"] === "ref" &&
        by["table"] === undefined &&
        outputNames.has(id(by["name"]) ?? "")
      ) {
        continue;
      }
      this.visit(item, scope);
    }

    this.generic(node, scope, ["from", "columns", "orderBy"]);
  }

  private addSource(f: Node, scope: Scope): void {
    const type = str(f["type"]);

    if (type === "table" && isNode(f["name"])) {
      const n = f["name"];
      const rawName = id(n["name"]);
      if (rawName === undefined) return;
      const name = rawName.toLowerCase();
      const schema = lower(n["schema"]);
      const alias = isNode(n["alias"]) ? id(n["alias"]["name"]) : id(n["alias"]);
      const exposed = alias ?? rawName;

      if (STATS_RELATIONS.has(name)) {
        // Planner statistics hold sample values and histogram bounds of every
        // column, including restricted ones.
        this.report({ kind: "catalog", column: name });
      }

      if (schema === undefined && cteVisible(scope.parent, rawName)) {
        scope.sources.push({ exposed, restriction: null });
        return;
      }
      const restriction = this.restrictionFor(schema, name);
      scope.sources.push({
        exposed,
        base: name,
        ...(schema !== undefined ? { schema } : {}),
        restriction,
      });
      if (restriction && Array.isArray(n["columnNames"])) {
        this.violation("alias-list", restriction, alias ?? name);
      }
      return;
    }

    if (type === "statement") {
      scope.sources.push({ exposed: id(f["alias"]), restriction: null });
      return;
    }

    if (type === "call") {
      const fn = isNode(f["function"]) ? lower(f["function"]["name"]) : undefined;
      const alias = isNode(f["alias"]) ? id(f["alias"]["name"]) : id(f["alias"]);
      scope.sources.push({ exposed: alias ?? fn, restriction: null });
      return;
    }

    scope.sources.push({ exposed: undefined, restriction: null });
  }

  private joinUsing(join: Node, scope: Scope): void {
    const restricted = scope.sources.filter((s) => s.restriction);
    if (restricted.length === 0) return;

    // USING (c) reads c from both sides; require it of every restricted source
    // in this FROM clause.
    for (const u of nodes(join["using"])) {
      const col = id(u["name"]);
      if (col === undefined) continue;
      for (const src of restricted) {
        if (!src.restriction!.allowed.has(col)) {
          this.violation("column", src.restriction, col);
        }
      }
    }
  }

  private star(ref: Node, scope: Scope): void {
    const table = isNode(ref["table"]) ? ref["table"] : undefined;
    if (table) {
      const src = findSource(scope, {
        name: id(table["name"]) ?? "",
        schema: id(table["schema"]),
      });
      if (src?.restriction) this.violation("star", src.restriction);
      else if (!src && restrictedIn(scope).length > 0) {
        this.violation("unresolved", restrictedIn(scope)[0]!.restriction, id(table["name"]));
      }
      return;
    }
    for (const src of scope.sources) {
      if (src.restriction) this.violation("star", src.restriction);
    }
  }

  private ref(ref: Node, scope: Scope | undefined): void {
    if (!scope) return;
    const name = id(ref["name"]);
    if (name === undefined) return;

    if (name === "*") {
      this.star(ref, scope);
      return;
    }

    const table = isNode(ref["table"]) ? ref["table"] : undefined;
    if (table) {
      const qualifier = id(table["name"]) ?? "";
      const src = findSource(scope, { name: qualifier, schema: id(table["schema"]) });
      if (!src) {
        const restricted = restrictedIn(scope);
        if (restricted.length > 0) {
          this.violation("unresolved", restricted[0]!.restriction, qualifier);
        }
        return;
      }
      if (src.restriction && !src.restriction.allowed.has(name)) {
        this.violation("column", src.restriction, name);
      }
      return;
    }

    const restricted = restrictedIn(scope);
    if (restricted.length === 0) return;
    const asAlias = restricted.find((s) => s.exposed === name || s.base === name);
    if (asAlias) {
      this.violation("whole-row", asAlias.restriction, name);
    } else {
      this.violation("unqualified", restricted[0]!.restriction, name);
    }
  }

  private call(node: Node, scope: Scope | undefined): void {
    const fn = isNode(node["function"]) ? node["function"] : undefined;
    const name = lower(fn?.["name"]);
    if (name !== undefined && DYNAMIC_SQL_FUNCTIONS.has(name)) {
      this.report({ kind: "function", column: name });
    }

    const args = Array.isArray(node["args"]) ? node["args"] : [];
    const only = args.length === 1 ? args[0] : undefined;

    if (name === "count" && isNode(only) && only["type"] === "ref" && only["name"] === "*" && only["table"] === undefined) {
      // count(*) reads no column.
      this.generic(node, scope, ["args"]);
      return;
    }
    if (name === "exists" && isNode(only) && only["type"] === "select") {
      // The select list of an EXISTS subquery never leaves it.
      this.select(only, scope, true);
      this.generic(node, scope, ["args"]);
      return;
    }
    this.generic(node, scope);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check one query against a set of column rules.
 *
 * With no rules the result is always `{ allowed: true }`. Otherwise the query
 * is parsed and every reference to a restricted table is checked. A query the
 * parser cannot read is always refused: with no AST there is no way to tell
 * what it reads (including through dynamic SQL), and a token scan can be
 * bypassed.
 */
export function checkColumnAccess(sql: string, rules: ColumnRules): ColumnCheckResult {
  if (rules.size === 0) return { allowed: true };

  let statements: unknown[];
  try {
    statements = parse(sql) as unknown[];
  } catch {
    return unparseable();
  }

  const checker = new Checker(rules);
  try {
    checker.visit(statements, undefined);
  } catch {
    return unparseable();
  }

  return checker.violations.length === 0
    ? { allowed: true }
    : { allowed: false, violations: checker.violations };
}

function unparseable(): ColumnCheckResult {
  return { allowed: false, violations: [{ kind: "unparseable" }] };
}
