# 3: Field-level (column) permissions in the allowlist JSON

Issue: https://github.com/simon-inkie/inkie-pg-read/issues/3

## TL;DR

`pgr.tables.allow` entries may be an object, `{ "table": "memberships", "columns": ["id", "role"] }`,
as well as a plain string. A plain string still allows every column. An object entry is default-deny
for columns: any column of that table not listed is refused, before a connection is opened, with an
error that names the column and the config file. The config is validated strictly and fails loudly.

## Scope

In:

- Config schema: string or `{ table, columns }` entries in `pgr.tables.allow`, in both the per-agent
  file and the working-directory file.
- Strict config validation at load time (unknown keys, wrong types, duplicates, empty lists).
- A column guard that parses the query and resolves columns to tables across aliases, joins, CTEs,
  subqueries and set operations, then refuses anything that could read a column outside the list.
- Denial message naming the column (or construct) and the config file.
- Tests, README and `--help` text.

Out:

- Row-level filtering (issue says so explicitly).
- Changing how the existing table gate extracts table names (see Follow-ups).
- Column rules for `information_schema` / `pg_catalog` (always readable, unchanged).

## Acceptance

- Permitted columns on a restricted table execute (the query reaches the connection step).
- An unpermitted column, `select *`, `t.*`, an unqualified column, or a whole-row expression
  (`to_jsonb(t)`) on a restricted table is refused before any connection is made, with a message
  that names the column or construct and the config file.
- Existing string-only configs behave exactly as before.
- Malformed config fails loudly at load time and never widens access.

## Test plan

- Config parsing: string entries unchanged, object entries, mixed, lowercasing, duplicates, unknown
  keys, wrong types, empty `columns`, missing `columns`, bad JSON.
- Column guard unit tests: allowed and denied columns, `select *`, `t.*`, unqualified columns,
  aliases, schema-qualified tables, joins (incl. `using`), CTEs (incl. shadowing and recursive),
  subqueries (scalar, `in`, `exists`, lateral, derived tables), set operations, whole-row functions
  (`to_jsonb`, `row_to_json`, bare alias, cast), alias column lists, dynamic-SQL functions, parse
  failure fail-closed, unrestricted tables unaffected.
- CLI tests: end-to-end through `src/cli.ts` for allow, deny and loud config failure.
- `bun run typecheck` and `bun test`.

## Decisions log

(Filled in as the work lands.)

## Follow-ups

(Filled in as the work lands.)

## Review feedback

(None yet.)
