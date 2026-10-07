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

1. **Real SQL parser, `pgsql-ast-parser`, as the one new dependency.** Column resolution across
   aliases, joins, CTEs and subqueries is not reliable with the existing regex extraction. The parser
   is pure TypeScript (no native build, works under Bun), and the only added runtime dependency
   besides its own small tree. The guard fails closed on parse failure, so its syntax gaps cost
   usability, never safety.
2. **Fail closed on unparseable SQL, but only if it mentions a restricted table.** A query the parser
   cannot read (`NATURAL JOIN`, `(t).col`, `TABLE t`, `COLLATE`) is refused when any restricted table
   name appears as an identifier in it, and let through otherwise, so unrelated queries are unaffected.
3. **Conservative resolution, matching the issue's suggested first version.** Unqualified columns are
   refused whenever a restricted source is in scope (including outer scopes of a correlated
   subquery), because there is no catalog to say which table owns the name. `select *` and `t.*`
   over a restricted source are refused. Every column reference anywhere in the query counts, so
   `where m.email = 'x'` is refused too (it would be a membership oracle).
4. **Derived tables and CTEs are opaque.** Their bodies are checked on their own, so whatever they
   expose is already limited. A CTE does not shadow a real table of the same name inside its own
   body (non-recursive), and a schema-qualified name never resolves to a CTE.
5. **Whole-row detection falls out of the unqualified rule.** A bare alias (`to_jsonb(m)`, `m::text`)
   is an unqualified reference whose name is a restricted source, reported as `whole-row` for a
   clearer message. `m.*` inside a function is a `star`.
6. **Allowed exceptions: `count(*)`, `exists (select * ...)`, ORDER BY output names.** None reads a
   column. A bare ORDER BY name is only waved through when it matches an output column of that
   select (Postgres resolves it there first).
7. **Alias column lists on a restricted table are refused** (`from t as m(a, b)`), since renaming
   columns would defeat name matching.
8. **Dynamic-SQL functions are refused while column rules are active** (`query_to_xml`,
   `table_to_xml`, `cursor_to_xml`, `schema_to_xml`, `database_to_xml` families, `ts_stat`). They run
   SQL from a string, which no static check can see.
9. **Rule matching over-restricts rather than guess a search path.** A rule for `memberships` applies
   to `memberships` and to any `schema.memberships`; a rule for `public.memberships` applies to the
   bare name too. If several rules apply, a column must satisfy all of them.
10. **Strict config validation, and a behaviour change for malformed files.** Previously a malformed
    file or non-string entry was silently ignored (default-deny). Now it throws
    `AllowlistConfigError` naming the file and path, and the CLI exits 1 before connecting. Rejected:
    non-JSON, non-object top level, wrong types, unknown keys under `pgr`, `pgr.tables` and in
    object entries, empty strings, an object without `columns`, an empty `columns` list, a `*`
    column, and duplicate tables in any form. Missing `pgr`, `tables` or `allow` stays quiet
    default-deny, because a shared config file may not configure pgr at all. Existing tests that
    asserted the old silent behaviour were updated.
11. **Empty `columns` is an error, not "no columns".** It is more likely a mistake than intent, and
    the plain string form already covers "all columns".
12. **API shape kept.** `readAllowlistFromFile` still returns table names; column rules come from the
    new `readAllowConfigFromFile` and `scope.columnRules`. `checkAgainstAllowlist` is unchanged.
13. **Statistics relations refused.** `pg_stats`, `pg_stats_ext`, `pg_stats_ext_exprs`,
    `pg_statistic` and `pg_statistic_ext_data` are refused while column rules are active, in any
    schema position, because they expose values of restricted columns and `pg_catalog` is otherwise
    always readable. The rest of `pg_catalog` and `information_schema` stay readable.
14. **Identifier case is Postgres-faithful.** The parser folds unquoted names and preserves quoted
    ones; aliases, qualifiers, columns, CTE names and `USING` names are compared as given. Only
    table and schema names (matched against config) and function names (deny list) are lower-cased,
    which can only over-match. Folding everything would let `"M"` stand in for `m`.
15. **Table gate now sees comma-separated FROM items.** The existing regex extraction missed
    `from a, b`. `extractTableRefs` now also adds every FROM table the AST finds (subqueries, CTE
    bodies, joins), excluding CTE names in scope. It only adds references, so a parser gap cannot
    loosen the gate. Small change, so done here rather than left as a follow-up; it applies to the
    table gate generally, not only to column rules.
16. **Functions in FROM go through the same call check.** A FROM item that is a function call is
    visited as a call node, so the dynamic-SQL deny list applies in every position.
17. **Column names in rules are matched in lower case.** Query identifiers keep their case, so a rule
    column with capitals can never match a quoted `"Role"`. That fails closed; documented in the
    README.
18. **Order of gates.** Table gate first, then column gate, then audit and connect. Column denials
    are written to the audit log with `decision: deny`.

## Follow-ups

- `extractTableRefs` still starts from regexes and only adds what the AST sees. Making the AST the
  sole source (and dropping the regexes) would be a cleaner follow-up.
- Column rules for views, and per-column rules for `information_schema` / `pg_catalog`, are not
  supported.
- Users may want an opt-in way to relax the unqualified-column rule when only one table is in scope.
  Without a catalog that cannot be proven safe, so it is left out.

## Review feedback

Opus review of the first push: changes needed.

1. **Blocker: unparseable-query fallback bypassed with dynamic SQL.** Confirmed: the token check ran
   after strings were stripped and never consulted the function deny list, so
   `select (o).x, query_to_xml('select email from memberships', ...) from other o` passed. Response:
   fixed by refusing every unparseable query while column rules are active. Tests: unparseable plus
   dynamic SQL (both reviewer examples), unparseable with and without a restricted table, and CLI.
2. **Blocker: `pg_stats` leaks restricted column values.** Confirmed in principle: `pg_catalog` is
   auto-allowed and `pg_stats*` hold most common values and histogram bounds. Response: refused
   `pg_stats`, `pg_stats_ext`, `pg_stats_ext_exprs`, plus `pg_statistic` and `pg_statistic_ext_data`,
   while column rules are active; documented in the README. Tests added at guard and CLI level, and a
   test that other catalog views stay readable.
3. **Should fix: dynamic-SQL function list is a denylist.** Agreed, cannot be closed statically.
   Response: stated as a known limitation in the README (`dblink`, security definer helpers, future
   built-ins).
4. **Should fix: quoted identifiers were lower-cased.** Response: fixed rather than documented. Names
   compared for identity are now used as the parser gives them, so `m."ROLE"` is denied. This also
   closed two related resolution cases I found while fixing it: a quoted alias `"M"` resolving to
   an unquoted `m`, and a quoted CTE name `"Memberships"` hiding the real table. Tests added for all
   three.
5. **Should fix: comma-FROM missing from the table gate.** Predates this PR. Response: kept in
   Follow-ups with a suggestion to file it as its own issue.
6. **Note junk-entry behaviour change.** Response: added to the README strict-validation paragraph and
   the PR description.

Second Opus review (head f240f21): changes needed; earlier findings hold.

7. **Blocker: dynamic-SQL functions as FROM items were never checked.** Confirmed from the code:
   pass 2 of `select()` visited only a FROM call's args, so the deny list never ran, and the comma-FROM
   gap hid the call from the table gate. Response: a FROM call is now visited as a call node. Tests:
   comma, `lateral`, `cross join`, `join ... on`, `left join lateral`, bare FROM, schema-qualified,
   `table_to_xml`, `ts_stat` (which this also fixes), plus ordinary `generate_series` and `jsonb_each`
   still allowed, and a CLI test.
8. **Also fix the comma-FROM gap in the table gate.** Response: done, it was a small change (decision
   15). Tests in `table-refs.test.ts` and the CLI. Dropped from Follow-ups.
9. **Nit: orphaned JSDoc for `DYNAMIC_SQL_FUNCTIONS`.** Response: moved onto the constant.
10. **Nit: `ts_stat` only enforced in the select list.** Response: fixed by point 7.
11. **Nit: mixed-case rule columns can never match.** Response: documented (decision 17).
