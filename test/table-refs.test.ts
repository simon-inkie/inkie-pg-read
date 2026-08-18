import { describe, it, expect } from "bun:test";
import { extractTableRefs } from "../src/table-refs.js";

// Helper: convert Set to sorted array for deterministic assertions
function refs(sql: string): string[] {
  return Array.from(extractTableRefs(sql)).sort();
}

// ── Simple FROM ───────────────────────────────────────────────────────────────

describe("FROM clause extraction", () => {
  it("simple FROM table", () => {
    expect(refs("SELECT * FROM tickets")).toEqual(["tickets"]);
  });

  it("lowercase from", () => {
    expect(refs("select * from tickets")).toEqual(["tickets"]);
  });

  it("FROM with alias", () => {
    expect(refs("SELECT i.id FROM tickets i")).toEqual(["tickets"]);
  });

  it("FROM with AS alias", () => {
    expect(refs("SELECT i.id FROM tickets AS i")).toEqual(["tickets"]);
  });

  it("FROM with WHERE clause", () => {
    expect(refs("SELECT * FROM tickets WHERE id = 1")).toEqual(["tickets"]);
  });

  it("FROM with schema qualifier", () => {
    expect(refs("SELECT * FROM public.tickets")).toEqual(["public.tickets"]);
  });

  it("FROM information_schema", () => {
    expect(refs("SELECT * FROM information_schema.tables")).toEqual([
      "information_schema.tables",
    ]);
  });

  it("FROM pg_catalog", () => {
    expect(refs("SELECT * FROM pg_catalog.pg_tables")).toEqual([
      "pg_catalog.pg_tables",
    ]);
  });

  it("no tables in SELECT only", () => {
    expect(refs("SELECT 1 as n")).toEqual([]);
  });
});

// ── JOIN clauses ──────────────────────────────────────────────────────────────

describe("JOIN clause extraction", () => {
  it("INNER JOIN", () => {
    const result = refs(
      "SELECT * FROM tickets i INNER JOIN comments s ON s.ticket_id = i.id"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
  });

  it("LEFT JOIN", () => {
    const result = refs(
      "SELECT * FROM tickets i LEFT JOIN comments s ON s.ticket_id = i.id"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
  });

  it("LEFT OUTER JOIN", () => {
    const result = refs(
      "SELECT * FROM tickets i LEFT OUTER JOIN comments s ON s.ticket_id = i.id"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
  });

  it("RIGHT JOIN", () => {
    const result = refs(
      "SELECT * FROM a RIGHT JOIN b ON b.id = a.id"
    );
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("FULL JOIN", () => {
    const result = refs("SELECT * FROM a FULL JOIN b ON b.id = a.id");
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("CROSS JOIN", () => {
    const result = refs("SELECT * FROM a CROSS JOIN b");
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("multiple JOINs", () => {
    const result = refs(
      "SELECT * FROM tickets i JOIN comments s ON s.ticket_id = i.id JOIN customers c ON c.id = i.customer_id"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
    expect(result).toContain("customers");
  });

  it("JOIN with schema qualifier", () => {
    const result = refs(
      "SELECT * FROM public.tickets i JOIN public.comments s ON s.ticket_id = i.id"
    );
    expect(result).toContain("public.tickets");
    expect(result).toContain("public.comments");
  });
});

// ── CTEs ──────────────────────────────────────────────────────────────────────

describe("CTE extraction", () => {
  it("simple CTE — CTE name excluded, real table included", () => {
    const result = refs("WITH x AS (SELECT * FROM tickets) SELECT * FROM x");
    expect(result).toContain("tickets");
    expect(result).not.toContain("x");
  });

  it("multiple CTEs — only real tables", () => {
    const result = refs(
      "WITH a AS (SELECT * FROM tickets), b AS (SELECT * FROM comments) SELECT * FROM a JOIN b ON b.ticket_id = a.id"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });

  it("CTE referencing another CTE — no real tables added", () => {
    const result = refs(
      "WITH a AS (SELECT * FROM tickets), b AS (SELECT * FROM a) SELECT * FROM b"
    );
    expect(result).toContain("tickets");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });

  it("CTE with join inside", () => {
    const result = refs(
      "WITH recent AS (SELECT i.id FROM tickets i JOIN comments s ON s.ticket_id = i.id) SELECT * FROM recent"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
    expect(result).not.toContain("recent");
  });
});

// ── String literals ──────────────────────────────────────────────────────────

describe("string literal isolation", () => {
  it("table name inside string literal is ignored", () => {
    // 'tickets' is a string value, not a real table reference
    expect(refs("SELECT 'FROM tickets' as doc")).toEqual([]);
  });

  it("table name in WHERE string is ignored", () => {
    expect(refs("SELECT * FROM foo WHERE name = 'FROM tickets'")).toEqual([
      "foo",
    ]);
  });

  it("escaped single quote in string literal", () => {
    expect(
      refs("SELECT * FROM tickets WHERE name = 'it''s here'")
    ).toEqual(["tickets"]);
  });
});

// ── Mixed real-world queries ──────────────────────────────────────────────────

describe("real-world query shapes", () => {
  it("audit_events query", () => {
    expect(
      refs("SELECT id, created_at FROM audit_events ORDER BY created_at DESC LIMIT 20")
    ).toEqual(["audit_events"]);
  });

  it("ticket_transcripts with JOIN", () => {
    const result = refs(
      "SELECT t.id, t.text FROM ticket_transcripts t JOIN ticket_segments s ON s.id = t.segment_id WHERE t.ticket_id = '123'"
    );
    expect(result).toContain("ticket_transcripts");
    expect(result).toContain("ticket_segments");
  });

  it("orders query", () => {
    expect(
      refs(
        "SELECT cp.id, cp.title FROM orders cp JOIN order_items cpi ON cpi.order_id = cp.id"
      )
    ).toEqual(["order_items", "orders"]);
  });

  it("subquery in WHERE", () => {
    const result = refs(
      "SELECT * FROM tickets WHERE id IN (SELECT ticket_id FROM comments WHERE cut = true)"
    );
    expect(result).toContain("tickets");
    expect(result).toContain("comments");
  });

  it("information_schema introspection", () => {
    const result = refs(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    expect(result).toEqual(["information_schema.tables"]);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("SELECT 1 — no tables", () => {
    expect(refs("SELECT 1")).toEqual([]);
  });

  it("no duplicates for same table appearing twice", () => {
    const result = refs(
      "SELECT * FROM tickets WHERE id IN (SELECT id FROM tickets LIMIT 5)"
    );
    expect(result).toEqual(["tickets"]);
  });

  it("double-quoted table identifier", () => {
    const result = refs('SELECT * FROM "MyTable"');
    expect(result).toEqual(["mytable"]); // normalised to lowercase
  });

  it("double-quoted schema-qualified", () => {
    const result = refs('SELECT * FROM "public"."tickets"');
    expect(result).toEqual(["public.tickets"]);
  });
});
