import { describe, it, expect } from "bun:test";
import { assertSafeQuery, SqlGuardError } from "../src/sql-guard.js";

// Helper — assert that a query throws SqlGuardError with a matching message fragment
function expectBlocked(sql: string, messageFragment?: string): void {
  expect(() => assertSafeQuery(sql)).toThrow(SqlGuardError);
  if (messageFragment) {
    let thrown: unknown;
    try {
      assertSafeQuery(sql);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as SqlGuardError).message).toContain(messageFragment);
  }
}

// Helper — assert that a query passes the guard
function expectAllowed(sql: string): void {
  expect(() => assertSafeQuery(sql)).not.toThrow();
}

// ── Happy-path SELECTs ────────────────────────────────────────────────────────

describe("allowed SELECTs", () => {
  it("simple SELECT", () => {
    expectAllowed("SELECT 1");
  });

  it("SELECT with lowercase", () => {
    expectAllowed("select 1 as n");
  });

  it("SELECT with mixed case", () => {
    expectAllowed("Select id, name FROM users WHERE active = true");
  });

  it("SELECT with leading whitespace", () => {
    expectAllowed("   SELECT * FROM tickets LIMIT 10");
  });

  it("SELECT with subquery", () => {
    expectAllowed(
      "SELECT id FROM tickets WHERE id IN (SELECT ticket_id FROM comments)"
    );
  });

  it("SELECT with JOIN", () => {
    expectAllowed(
      "SELECT i.id, s.id FROM tickets i JOIN comments s ON s.ticket_id = i.id"
    );
  });

  it("SELECT with aggregate", () => {
    expectAllowed("SELECT COUNT(*) as n, MAX(created_at) FROM audit_events");
  });

  it("SELECT with window function", () => {
    expectAllowed(
      "SELECT id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at) as rn FROM tickets"
    );
  });

  it("SELECT with string literals containing semicolons", () => {
    expectAllowed("SELECT 'hello; world' as greeting");
  });

  it("SELECT with string literal containing single quotes (escaped)", () => {
    expectAllowed("SELECT 'it''s fine' as msg");
  });

  it("SELECT with ORDER BY, LIMIT, OFFSET", () => {
    expectAllowed(
      "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100 OFFSET 50"
    );
  });

  it("SELECT with CASE expression", () => {
    expectAllowed(
      "SELECT id, CASE WHEN status = 'active' THEN 1 ELSE 0 END as is_active FROM tickets"
    );
  });

  it("SELECT with COALESCE", () => {
    expectAllowed("SELECT COALESCE(name, 'unknown') FROM users");
  });

  it("SELECT with no trailing semicolon", () => {
    expectAllowed("SELECT 1");
  });

  it("SELECT with trailing semicolon — treated as single statement", () => {
    expectAllowed("SELECT 1;");
  });
});

// ── CTEs ──────────────────────────────────────────────────────────────────────

describe("allowed CTEs", () => {
  it("simple CTE", () => {
    expectAllowed("WITH x AS (SELECT 1) SELECT * FROM x");
  });

  it("CTE lowercase", () => {
    expectAllowed("with x as (select 1) select * from x");
  });

  it("CTE with multiple definitions", () => {
    expectAllowed(
      "WITH a AS (SELECT id FROM tickets), b AS (SELECT * FROM comments) SELECT a.id FROM a JOIN b ON b.ticket_id = a.id"
    );
  });

  it("CTE used in audit_events query", () => {
    expectAllowed(
      "WITH recent AS (SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 5) SELECT * FROM recent"
    );
  });

  it("CTE with aggregate inside", () => {
    expectAllowed(
      "WITH counts AS (SELECT customer_id, COUNT(*) as n FROM tickets GROUP BY customer_id) SELECT * FROM counts ORDER BY n DESC"
    );
  });

  it("CTE with subquery inside", () => {
    expectAllowed(
      "WITH t AS (SELECT id FROM tickets WHERE id IN (SELECT ticket_id FROM comments WHERE cut = true)) SELECT * FROM t"
    );
  });
});

// ── DML rejection ─────────────────────────────────────────────────────────────

describe("blocked DML", () => {
  it("INSERT", () => {
    expectBlocked("INSERT INTO foo VALUES (1)", "only SELECT");
  });

  it("INSERT lowercase", () => {
    expectBlocked("insert into foo values (1)", "only SELECT");
  });

  it("UPDATE", () => {
    expectBlocked("UPDATE users SET name = 'x' WHERE id = 1", "only SELECT");
  });

  it("DELETE", () => {
    expectBlocked("DELETE FROM users WHERE id = 1", "only SELECT");
  });

  it("DROP", () => {
    expectBlocked("DROP TABLE users", "only SELECT");
  });

  it("ALTER", () => {
    expectBlocked("ALTER TABLE users ADD COLUMN foo TEXT", "only SELECT");
  });

  it("TRUNCATE", () => {
    expectBlocked("TRUNCATE TABLE users", "only SELECT");
  });

  it("CREATE TABLE", () => {
    expectBlocked("CREATE TABLE foo (id INT)", "only SELECT");
  });

  it("GRANT", () => {
    expectBlocked("GRANT SELECT ON users TO anon", "only SELECT");
  });

  it("REVOKE", () => {
    expectBlocked("REVOKE SELECT ON users FROM anon", "only SELECT");
  });

  it("COPY", () => {
    expectBlocked("COPY users TO '/tmp/users.csv'", "only SELECT");
  });

  it("SET at top level", () => {
    expectBlocked("SET statement_timeout = 0", "only SELECT");
  });

  it("EXECUTE", () => {
    expectBlocked("EXECUTE my_prepared_stmt", "only SELECT");
  });

  it("CALL", () => {
    expectBlocked("CALL my_procedure()", "only SELECT");
  });

  it("DO block", () => {
    expectBlocked("DO $$ BEGIN NULL; END; $$", "dollar-quoted");
  });
});

// ── Multi-statement rejection ─────────────────────────────────────────────────

describe("blocked multi-statement", () => {
  it("SELECT; DROP", () => {
    expectBlocked("SELECT 1; DROP TABLE users", "multiple statements");
  });

  it("SELECT; SELECT", () => {
    expectBlocked("SELECT 1; SELECT 2", "multiple statements");
  });

  it("SELECT; INSERT", () => {
    expectBlocked("SELECT * FROM foo; INSERT INTO foo VALUES (1)", "multiple statements");
  });

  it("whitespace between statements", () => {
    expectBlocked("SELECT 1 ;\n  DROP TABLE users", "multiple statements");
  });
});

// ── Comment-based bypass attempts ─────────────────────────────────────────────

describe("comment-based bypasses", () => {
  it("inline comment before DML keyword", () => {
    // After stripping comments, the first keyword becomes INSERT
    expectBlocked("-- SELECT\nINSERT INTO foo VALUES (1)", "only SELECT");
  });

  it("block comment wrapping DML", () => {
    expectBlocked("/* foo */ DELETE FROM users", "only SELECT");
  });

  it("valid SELECT with inline comment is allowed", () => {
    expectAllowed("SELECT id -- get the id\nFROM users");
  });

  it("valid SELECT with block comment is allowed", () => {
    expectAllowed("SELECT /* all columns */ * FROM users");
  });
});

// ── Dollar-quoted string rejection ────────────────────────────────────────────

describe("dollar-quoted strings", () => {
  it("function body with $$", () => {
    expectBlocked("DO $$ BEGIN NULL; END; $$", "dollar-quoted");
  });

  it("named dollar quote", () => {
    expectBlocked("SELECT $body$ hello $body$", "dollar-quoted");
  });
});

// ── Write-CTE bypass (reported by security review) ──────────────────────────────

describe("blocked write-CTE bodies", () => {
  it("INSERT inside CTE body with RETURNING (the reported PoC)", () => {
    expectBlocked(
      "WITH t AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM t",
      "data-modifying statements are not allowed inside a CTE body"
    );
  });

  it("UPDATE inside CTE body", () => {
    expectBlocked(
      "WITH t AS (UPDATE users SET name = 'x' RETURNING *) SELECT * FROM t",
      "data-modifying statements are not allowed inside a CTE body"
    );
  });

  it("DELETE inside CTE body", () => {
    expectBlocked(
      "WITH t AS (DELETE FROM users RETURNING *) SELECT * FROM t",
      "data-modifying statements are not allowed inside a CTE body"
    );
  });

  it("second CTE body is a write, first is a read", () => {
    expectBlocked(
      "WITH a AS (SELECT 1), b AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM a, b",
      "data-modifying statements are not allowed inside a CTE body"
    );
  });
});

// ── SELECT INTO bypass (reported by security review) ────────────────────────────

describe("blocked SELECT INTO", () => {
  it("SELECT * INTO newtable (the reported PoC)", () => {
    expectBlocked(
      "SELECT * INTO new_table FROM tickets",
      "SELECT ... INTO is not allowed"
    );
  });

  it("SELECT columns INTO newtable", () => {
    expectBlocked(
      "SELECT id, name INTO backup_users FROM users",
      "SELECT ... INTO is not allowed"
    );
  });

  it("SELECT INTO TEMP table", () => {
    expectBlocked(
      "SELECT * INTO TEMP snapshot FROM tickets",
      "SELECT ... INTO is not allowed"
    );
  });

  it("WITH ... SELECT ... INTO after the CTE", () => {
    expectBlocked(
      "WITH x AS (SELECT 1) SELECT * INTO newtable FROM x",
      "SELECT ... INTO is not allowed"
    );
  });
});

// ── Regression: legitimate reads still pass after the above tightening ──────────

describe("legitimate reads unaffected by write-CTE / INTO checks", () => {
  it("read CTE with a subquery containing IN (...)", () => {
    expectAllowed(
      "WITH t AS (SELECT id FROM tickets WHERE id IN (SELECT ticket_id FROM comments)) SELECT * FROM t"
    );
  });

  it("multi-CTE read with JOIN", () => {
    expectAllowed(
      "WITH a AS (SELECT id FROM tickets), b AS (SELECT * FROM comments) SELECT a.id FROM a JOIN b ON b.ticket_id = a.id"
    );
  });

  it("plain SELECT with a column named similarly to INTO (word boundary)", () => {
    expectAllowed("SELECT id, checkpoint_into FROM tickets");
  });

  it("plain SELECT with a table named similarly to a write keyword", () => {
    expectAllowed("SELECT * FROM deleted_users");
  });

  it("subquery in WHERE clause is unaffected by the INTO check", () => {
    expectAllowed(
      "SELECT * FROM tickets WHERE id IN (SELECT ticket_id FROM comments)"
    );
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty string", () => {
    expectBlocked("", "empty query");
  });

  it("whitespace only", () => {
    expectBlocked("   \n  ", "empty query");
  });

  it("semicolon only", () => {
    expectBlocked(";", "empty query");
  });

  it("string literal containing INSERT keyword — allowed", () => {
    expectAllowed("SELECT 'INSERT INTO is a DML command' as doc");
  });

  it("string literal containing DROP keyword — allowed", () => {
    expectAllowed("SELECT 'DROP TABLE would be bad' as note");
  });

  it("CTE with DML terminator is blocked", () => {
    // Malformed: WITH ... INSERT (no final SELECT)
    expectBlocked(
      "WITH x AS (SELECT 1) INSERT INTO foo SELECT * FROM x",
      "only SELECT"
    );
  });
});
