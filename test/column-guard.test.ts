import { describe, it, expect } from "bun:test";

import {
  checkColumnAccess,
  type ColumnRules,
  type ColumnViolation,
  type ColumnViolationKind,
} from "../src/column-guard.js";

const RULES: ColumnRules = new Map([
  ["memberships", ["id", "created_at", "role", "client_id"]],
]);

function ok(sql: string, rules: ColumnRules = RULES): void {
  const r = checkColumnAccess(sql, rules);
  if (!r.allowed) {
    throw new Error(`expected allowed, got ${JSON.stringify(r.violations)}\n${sql}`);
  }
}

function denied(sql: string, rules: ColumnRules = RULES): ColumnViolation[] {
  const r = checkColumnAccess(sql, rules);
  if (r.allowed) throw new Error(`expected denied, got allowed\n${sql}`);
  return r.violations;
}

function deniedAs(sql: string, kind: ColumnViolationKind, column?: string): void {
  const v = denied(sql);
  expect(v.map((x) => x.kind)).toContain(kind);
  if (column !== undefined) expect(v.map((x) => x.column)).toContain(column);
}

describe("column guard: no column rules", () => {
  it("allows everything", () => {
    ok("select * from memberships", new Map());
    ok("select email from memberships", new Map());
  });
});

describe("column guard: permitted columns", () => {
  it("allows listed columns, qualified by the table name", () => {
    ok("select memberships.id, memberships.role from memberships");
  });

  it("allows listed columns through an alias, with and without AS", () => {
    ok("select m.id, m.created_at from memberships m");
    ok("select m.role from memberships as m where m.client_id = 5");
  });

  it("folds unquoted names the way Postgres does", () => {
    ok("select M.ID, M.Role from memberships M");
    ok('select "M".id, "M".role from memberships "M"');
  });

  it("allows schema-qualified tables and qualifiers", () => {
    ok("select m.id from public.memberships m");
    ok("select public.memberships.id from public.memberships");
  });

  it("allows count(*), count(1) and selects with no column reads", () => {
    ok("select count(*) from memberships");
    ok("select count(*) as n from memberships m where m.role = 'admin'");
    ok("select 1 from memberships");
  });

  it("allows listed columns in every clause", () => {
    ok(
      `select m.role, count(*) as n
       from memberships m
       where m.created_at > now() - interval '7 days'
       group by m.role
       having count(*) > 1
       order by m.role desc
       limit 10`
    );
  });

  it("allows functions, casts, case and window expressions over listed columns", () => {
    ok("select lower(m.role), m.id::text, case when m.id > 1 then m.role end from memberships m");
    ok("select m.role, row_number() over (partition by m.client_id order by m.created_at) from memberships m");
    ok("select to_jsonb(m.role), json_build_object('id', m.id) from memberships m");
  });

  it("lets ORDER BY use an output name", () => {
    ok("select m.role as r, count(*) as n from memberships m group by m.role order by n desc, r");
    ok("select m.role from memberships m order by role");
  });

  it("does not touch tables without a rule", () => {
    ok("select * from clients");
    ok("select c.email, c.* from clients c");
    ok("select email from clients where id in (select client_id from interviews)");
  });
});

describe("column guard: unpermitted columns", () => {
  it("rejects an unlisted qualified column and names it", () => {
    const v = denied("select m.email from memberships m");
    expect(v[0]).toMatchObject({ kind: "column", table: "memberships", column: "email" });
    expect(v[0]!.allowed).toEqual(["id", "created_at", "role", "client_id"]);
  });

  it("rejects an unlisted column in WHERE, GROUP BY, HAVING, ORDER BY, JOIN ON", () => {
    deniedAs("select m.id from memberships m where m.email = 'a'", "column", "email");
    deniedAs("select count(*) from memberships m group by m.email", "column", "email");
    deniedAs("select count(*) from memberships m group by m.id having max(m.email) > 'a'", "column", "email");
    deniedAs("select m.id from memberships m order by m.email", "column", "email");
    deniedAs("select 1 from clients c join memberships m on m.email = c.email", "column", "email");
  });

  it("rejects an unlisted column inside functions, casts and aggregates", () => {
    deniedAs("select lower(m.email) from memberships m", "column", "email");
    deniedAs("select m.email::text from memberships m", "column", "email");
    deniedAs("select count(distinct m.email) from memberships m", "column", "email");
    deniedAs("select count(*) filter (where m.email like 'a%') from memberships m", "column", "email");
    deniedAs("select sum(1) over (partition by m.email) from memberships m", "column", "email");
    deniedAs("select case when m.email is null then 1 end from memberships m", "column", "email");
    deniedAs("select m.id from memberships m where m.email in ('a', 'b')", "column", "email");
  });

  it("reports every denied column", () => {
    const v = denied("select m.email, m.phone from memberships m");
    expect(v.map((x) => x.column)).toEqual(["email", "phone"]);
  });

  it("treats a quoted, differently cased column as a different column", () => {
    deniedAs('select m."Email" from memberships m', "column", "Email");
    deniedAs('select m."ROLE" from memberships m', "column", "ROLE");
    deniedAs('select m.id from memberships m where m."ROLE" = 1', "column", "ROLE");
  });

  it("does not let a quoted alias stand in for an unquoted one", () => {
    // "M" is the restricted table; m is an unrelated one. Folding would resolve
    // "M".email to clients.
    deniedAs('select "M".email from clients m, memberships "M"', "column", "email");
    deniedAs('select m.id from memberships m, (select 1) "M" where "M".id = m.email', "column", "email");
  });

  it("does not let a quoted CTE name hide the real table", () => {
    deniedAs('with "Memberships" as (select 1 as email) select m.email from memberships m', "column", "email");
  });

  it("rejects an unlisted column through a schema-qualified qualifier", () => {
    deniedAs("select public.memberships.email from public.memberships", "column", "email");
  });

  it("rejects an unlisted column in USING", () => {
    deniedAs("select 1 from memberships m join clients c using (email)", "column", "email");
    ok("select 1 from memberships m join clients c using (client_id)");
  });

  it("rejects an unresolvable qualifier while a restricted table is in scope", () => {
    deniedAs("select memberships.email from memberships m", "unresolved");
    deniedAs("select x.email from memberships m", "unresolved");
  });
});

describe("column guard: select * and unqualified columns", () => {
  it("rejects select *", () => {
    const v = denied("select * from memberships");
    expect(v[0]).toMatchObject({ kind: "star", table: "memberships" });
  });

  it("rejects m.* and table.*", () => {
    deniedAs("select m.* from memberships m", "star");
    deniedAs("select memberships.* from memberships", "star");
  });

  it("rejects * over a join that includes a restricted table", () => {
    deniedAs("select * from clients c join memberships m on m.client_id = c.id", "star");
    ok("select c.* from clients c join memberships m on m.client_id = c.id");
  });

  it("rejects * with other columns, and in a subquery", () => {
    deniedAs("select m.id, * from memberships m", "star");
    deniedAs("select id from (select * from memberships) x", "star");
    deniedAs("select 1 where 1 in (select * from memberships)", "star");
  });

  it("rejects unqualified columns, listed or not", () => {
    deniedAs("select id from memberships", "unqualified", "id");
    deniedAs("select role from memberships m", "unqualified", "role");
    deniedAs("select m.id from memberships m where role = 'a'", "unqualified", "role");
    deniedAs("select email from memberships", "unqualified", "email");
  });

  it("rejects an unqualified column mixed with unrestricted tables", () => {
    deniedAs("select name from clients c join memberships m on m.client_id = c.id", "unqualified", "name");
  });

  it("allows an unqualified column when no restricted table is in scope", () => {
    ok("select id, email from clients");
    ok("select name from clients where id in (select m.client_id from memberships m)");
  });

  it("allows an EXISTS select list of *", () => {
    ok("select c.id from clients c where exists (select * from memberships m where m.client_id = c.id)");
    deniedAs("select c.id from clients c where exists (select m.email from memberships m where m.client_id = c.id)", "column", "email");
  });
});

describe("column guard: aliases and joins", () => {
  it("tracks aliases across joins", () => {
    ok("select c.name, m.role from clients c join memberships m on m.client_id = c.id");
    deniedAs("select c.name, m.email from clients c join memberships m on m.client_id = c.id", "column", "email");
  });

  it("checks each restricted table against its own list", () => {
    const rules: ColumnRules = new Map([
      ["memberships", ["id", "role"]],
      ["clients", ["id", "name"]],
    ]);
    ok("select m.role, c.name from memberships m join clients c on c.id = m.id", rules);
    const v = denied("select m.name, c.role from memberships m join clients c on c.id = m.id", rules);
    expect(v.map((x) => `${x.table}.${x.column}`)).toEqual(["memberships.name", "clients.role"]);
  });

  it("handles a restricted table joined to itself under two aliases", () => {
    ok("select a.id, b.role from memberships a join memberships b on a.id = b.id");
    deniedAs("select a.id, b.email from memberships a join memberships b on a.id = b.id", "column", "email");
  });

  it("hides the table name once it is aliased", () => {
    deniedAs("select memberships.id from memberships m", "unresolved");
  });

  it("resolves the innermost alias when a name is reused", () => {
    ok("select m.name from (select c.name from clients c) m, memberships x where x.id = 1");
    deniedAs("select m.email from memberships m where m.id in (select 1 from clients m where m.id = 1) ", "column", "email");
  });

  it("rejects a column alias list on a restricted table", () => {
    deniedAs("select m.a from memberships as m(a, b, c, d)", "alias-list");
    ok("select m.a from clients as m(a, b, c, d)");
  });

  it("rejects NATURAL JOIN with a restricted table (the parser cannot read it)", () => {
    deniedAs("select c.name from clients c natural join memberships m", "unparseable");
  });
});

describe("column guard: CTEs", () => {
  it("allows a CTE over permitted columns and lets the outer query use it freely", () => {
    ok("with r as (select m.id, m.role from memberships m) select r.id, r.role from r");
    ok("with r as (select m.id, m.role from memberships m) select id, role from r");
    ok("with r as (select m.id from memberships m) select * from r");
  });

  it("checks the CTE body", () => {
    deniedAs("with r as (select m.email from memberships m) select 1 from r", "column", "email");
    deniedAs("with r as (select * from memberships) select r.id from r", "star");
    deniedAs("with r as (select id from memberships) select 1 from r", "unqualified", "id");
  });

  it("checks later CTEs and the main query", () => {
    deniedAs("with a as (select 1 as x), b as (select m.email from memberships m) select 1", "column", "email");
    deniedAs("with a as (select 1 as x) select m.email from a, memberships m", "column", "email");
  });

  it("does not let a CTE hide a real table of the same name inside its own body", () => {
    deniedAs("with memberships as (select m.email from memberships m) select 1 from memberships", "column", "email");
    deniedAs("with memberships as (select * from memberships) select 1 from memberships", "star");
  });

  it("treats a CTE named like a restricted table as the CTE in the outer query", () => {
    ok("with memberships as (select 1 as email) select memberships.email from memberships");
  });

  it("does not treat a schema-qualified name as the CTE", () => {
    deniedAs("with memberships as (select 1 as email) select m.email from public.memberships m", "column", "email");
  });

  it("handles recursive CTEs", () => {
    ok("with recursive t(n) as (select 1 union all select n + 1 from t where n < 5) select n from t");
    deniedAs("with recursive t(e) as (select m.email from memberships m union all select t.e from t) select 1 from t", "column", "email");
  });
});

describe("column guard: subqueries and set operations", () => {
  it("checks scalar, IN and derived-table subqueries", () => {
    deniedAs("select (select max(m.email) from memberships m) from clients", "column", "email");
    deniedAs("select 1 from clients c where c.id in (select m.email from memberships m)", "column", "email");
    deniedAs("select x.e from (select m.email as e from memberships m) x", "column", "email");
    ok("select x.r from (select m.role as r from memberships m) x");
    ok("select 1 from clients c where c.id in (select m.client_id from memberships m)");
  });

  it("resolves correlated references to the outer query", () => {
    deniedAs("select 1 from memberships m where exists (select 1 from clients c where c.email = m.email)", "column", "email");
    ok("select 1 from memberships m where exists (select 1 from clients c where c.id = m.client_id)");
  });

  it("rejects an unqualified name in a subquery under a restricted outer query", () => {
    deniedAs("select 1 from memberships m where m.id in (select client_id from clients)", "unqualified", "client_id");
  });

  it("checks LATERAL subqueries", () => {
    deniedAs("select 1 from memberships m, lateral (select m.email) l", "column", "email");
    ok("select l.r from memberships m, lateral (select m.role as r) l");
  });

  it("checks every branch of UNION and friends", () => {
    ok("select m.id from memberships m union select c.id from clients c");
    deniedAs("select c.id from clients c union select m.email from memberships m", "column", "email");
    deniedAs("select m.email from memberships m union all select c.id from clients c", "column", "email");
  });

  it("checks array subqueries and function arguments in FROM", () => {
    deniedAs("select array(select m.email from memberships m)", "column", "email");
    deniedAs("select * from clients c, jsonb_each(to_jsonb(c)), (select m.email from memberships m) x", "column", "email");
  });
});

describe("column guard: whole-row expressions and functions", () => {
  it("rejects to_jsonb / row_to_json / to_json of the alias or table", () => {
    deniedAs("select to_jsonb(m) from memberships m", "whole-row", "m");
    deniedAs("select row_to_json(m) from memberships m", "whole-row", "m");
    deniedAs("select to_json(memberships) from memberships", "whole-row", "memberships");
    deniedAs("select jsonb_agg(to_jsonb(m)) from memberships m", "whole-row");
  });

  it("rejects a bare alias, cast and row() of the whole row", () => {
    deniedAs("select m from memberships m", "whole-row");
    deniedAs("select m::text from memberships m", "whole-row");
    deniedAs("select count(m) from memberships m", "whole-row");
  });

  it("rejects whole-row use inside a subquery and via an outer alias", () => {
    deniedAs("select (select to_jsonb(m) from clients c limit 1) from memberships m", "whole-row");
    deniedAs("select 1 from clients c, lateral (select to_jsonb(m)) l, memberships m", "whole-row");
  });

  it("rejects m.* inside functions", () => {
    deniedAs("select row_to_json(m.*) from memberships m", "star");
    deniedAs("select jsonb_build_array(m.*) from memberships m", "star");
  });

  it("allows whole-row functions over unrestricted tables and derived tables", () => {
    ok("select to_jsonb(c) from clients c");
    ok("select to_jsonb(x) from (select m.id, m.role from memberships m) x");
  });

  it("rejects functions that run SQL from a string", () => {
    for (const fn of [
      "query_to_xml('select email from memberships', true, false, '')",
      "table_to_xml('memberships', true, false, '')",
      "pg_catalog.query_to_xml('select 1', true, false, '')",
    ]) {
      deniedAs(`select ${fn}`, "function");
    }
  });
});

describe("column guard: queries the parser cannot read", () => {
  it("refuses them when a restricted table is mentioned", () => {
    deniedAs("select c.name from clients c natural join memberships", "unparseable");
    deniedAs("table memberships", "unparseable");
    deniedAs("select (m).email from memberships m", "unparseable");
  });

  it("refuses them even when no restricted table is mentioned", () => {
    deniedAs("table clients", "unparseable");
    deniedAs("select c.name from clients c natural join other", "unparseable");
  });

  it("refuses unparseable queries that smuggle in dynamic SQL", () => {
    deniedAs(
      "select (o).x, query_to_xml('select email from memberships', true, false, '') from other o",
      "unparseable"
    );
    deniedAs(
      "select o.id from other o natural join xmltable('/a' passing query_to_xml('select email from memberships', true, false, '') columns x text) t",
      "unparseable"
    );
  });

  it("refuses the parseable form of the same dynamic SQL too", () => {
    deniedAs(
      "select o.id, query_to_xml('select email from memberships', true, false, '') from other o",
      "function"
    );
    deniedAs(
      "select o.id from other o, xmltable('/a' passing query_to_xml('select email from memberships', true, false, '') columns x text) t",
      "unparseable"
    );
  });
});

describe("column guard: dynamic SQL functions as FROM items", () => {
  const Q = "query_to_xml('select email from memberships', true, false, '')";

  it("refuses them after a comma, lateral, cross join and join", () => {
    for (const from of [
      `other o, ${Q} x`,
      `other o, lateral ${Q} x`,
      `other o cross join ${Q} x`,
      `other o join ${Q} x on true`,
      `other o left join lateral ${Q} x on true`,
      `${Q} x`,
    ]) {
      deniedAs(`select 1 from ${from}`, "function", "query_to_xml");
    }
  });

  it("refuses schema-qualified and other family members", () => {
    deniedAs(`select 1 from other o, pg_catalog.${Q} x`, "function");
    deniedAs("select x from other o, table_to_xml('memberships', true, false, '') x", "function", "table_to_xml");
    deniedAs("select * from ts_stat('select email from memberships')", "function", "ts_stat");
  });

  it("refuses ts_rewrite, which runs its second argument as SQL", () => {
    deniedAs(
      "select ts_rewrite('x'::tsquery, 'select ''x''::tsquery, plainto_tsquery(''simple'', email) from memberships')",
      "function",
      "ts_rewrite"
    );
    deniedAs("select * from other o, ts_rewrite('x'::tsquery, 'select 1') t", "function", "ts_rewrite");
  });

  it("still allows ordinary set-returning functions in FROM", () => {
    ok("select g from other o, generate_series(1, 3) g");
    ok("select e.key from other o, jsonb_each(o.data) e");
  });
});

describe("column guard: statistics relations", () => {
  it("refuses pg_stats and friends in any position or schema form", () => {
    for (const rel of ["pg_stats", "pg_catalog.pg_stats", "pg_stats_ext", "pg_stats_ext_exprs", "pg_statistic"]) {
      deniedAs(`select 1 from ${rel}`, "catalog");
    }
    deniedAs(
      "select s.most_common_vals from pg_catalog.pg_stats s where s.tablename = 'memberships' and s.attname = 'email'",
      "catalog"
    );
    deniedAs("select 1 from clients c where exists (select 1 from pg_stats)", "catalog");
    deniedAs("with s as (select 1 from pg_stats) select 1 from s", "catalog");
  });

  it("leaves the rest of the catalog readable", () => {
    ok("select table_name from information_schema.tables");
    ok("select tablename from pg_catalog.pg_tables");
    ok("select attname from pg_catalog.pg_attribute");
  });

  it("only applies when column rules are active", () => {
    ok("select most_common_vals from pg_stats", new Map());
  });
});
