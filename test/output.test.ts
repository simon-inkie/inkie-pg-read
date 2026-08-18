import { describe, it, expect } from "bun:test";
import { formatJson, formatCsv, formatTable } from "../src/output.js";
import type { Row } from "../src/output.js";

// ── JSON ──────────────────────────────────────────────────────────────────────

describe("formatJson", () => {
  it("empty array", () => {
    expect(formatJson([])).toBe("[]");
  });

  it("single row", () => {
    const rows: Row[] = [{ n: 1 }];
    const out = formatJson(rows);
    expect(JSON.parse(out)).toEqual([{ n: 1 }]);
  });

  it("multiple rows with mixed types", () => {
    const rows: Row[] = [
      { id: 1, name: "Alice", active: true, score: null },
      { id: 2, name: "Bob", active: false, score: 3.14 },
    ];
    const out = formatJson(rows);
    expect(JSON.parse(out)).toEqual(rows);
  });

  it("is pretty-printed (contains newlines)", () => {
    const rows: Row[] = [{ id: 1 }];
    expect(formatJson(rows)).toContain("\n");
  });
});

// ── CSV ───────────────────────────────────────────────────────────────────────

describe("formatCsv", () => {
  it("empty rows", () => {
    expect(formatCsv([])).toBe("");
  });

  it("simple row", () => {
    const rows: Row[] = [{ n: 1, greeting: "hello" }];
    const out = formatCsv(rows);
    expect(out).toBe("n,greeting\n1,hello\n");
  });

  it("field with comma is quoted", () => {
    const rows: Row[] = [{ name: "Smith, John" }];
    const out = formatCsv(rows);
    expect(out).toContain('"Smith, John"');
  });

  it("field with double-quote escapes the quote", () => {
    const rows: Row[] = [{ msg: 'say "hello"' }];
    const out = formatCsv(rows);
    expect(out).toContain('"say ""hello"""');
  });

  it("null values become empty string", () => {
    const rows: Row[] = [{ id: 1, name: null }];
    const out = formatCsv(rows);
    expect(out).toBe("id,name\n1,\n");
  });

  it("object value serialised as JSON string", () => {
    const rows: Row[] = [{ meta: { key: "val" } }];
    const out = formatCsv(rows);
    // {"key":"val"} contains double-quotes so it gets RFC 4180 wrapped:
    // outer double-quotes, internal double-quotes doubled → "{""key"":""val""}"
    expect(out).toContain('"{""key"":""val""}"');
  });

  it("multiple rows", () => {
    const rows: Row[] = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const lines = formatCsv(rows).trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[0]).toBe("id,name");
    expect(lines[1]).toBe("1,Alice");
    expect(lines[2]).toBe("2,Bob");
  });
});

// ── Table ─────────────────────────────────────────────────────────────────────

describe("formatTable", () => {
  it("empty rows", () => {
    expect(formatTable([])).toContain("(0 rows)");
  });

  it("single row", () => {
    const rows: Row[] = [{ n: 1, greeting: "hello" }];
    const out = formatTable(rows);
    expect(out).toContain("n");
    expect(out).toContain("greeting");
    expect(out).toContain("1");
    expect(out).toContain("hello");
  });

  it("contains column headers", () => {
    const rows: Row[] = [{ id: 1, name: "Alice" }];
    const out = formatTable(rows);
    expect(out).toContain("id");
    expect(out).toContain("name");
  });

  it("contains separator lines", () => {
    const rows: Row[] = [{ id: 1 }];
    const out = formatTable(rows);
    expect(out).toContain("+");
    expect(out).toContain("-");
    expect(out).toContain("|");
  });

  it("shows row count", () => {
    const rows: Row[] = [{ id: 1 }, { id: 2 }];
    const out = formatTable(rows);
    expect(out).toContain("(2 rows)");
  });

  it("shows (1 row) singular", () => {
    const rows: Row[] = [{ id: 1 }];
    const out = formatTable(rows);
    expect(out).toContain("(1 row)");
  });

  it("truncates long values with ellipsis", () => {
    const longValue = "A".repeat(100);
    const rows: Row[] = [{ col: longValue }];
    const out = formatTable(rows, 20);
    expect(out).toContain("…");
    // Should not contain the full value
    expect(out).not.toContain(longValue);
  });

  it("null rendered as NULL", () => {
    const rows: Row[] = [{ col: null }];
    const out = formatTable(rows);
    expect(out).toContain("NULL");
  });

  it("object value renders as JSON", () => {
    const rows: Row[] = [{ meta: { key: "val" } }];
    const out = formatTable(rows);
    expect(out).toContain("key");
  });

  it("columns are aligned (all rows same width)", () => {
    const rows: Row[] = [
      { id: 1, name: "Alice" },
      { id: 200, name: "Bob" },
    ];
    const out = formatTable(rows);
    // All separator lines should be the same length
    const lines = out.split("\n").filter((l) => l.startsWith("+"));
    const lengths = lines.map((l) => l.length);
    expect(new Set(lengths).size).toBe(1);
  });
});
