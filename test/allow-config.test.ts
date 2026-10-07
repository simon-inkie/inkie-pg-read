import { describe, it, expect } from "bun:test";

import {
  parseAllowConfig,
  AllowlistConfigError,
} from "../src/agent-allowlist.js";

const FILE = "~/agents/x/.pgr-agent.json";

function cfg(allow: unknown) {
  return parseAllowConfig({ pgr: { tables: { allow } } }, FILE);
}

function failure(parsed: unknown): string {
  try {
    parseAllowConfig(parsed, FILE);
  } catch (err) {
    expect(err).toBeInstanceOf(AllowlistConfigError);
    return (err as Error).message;
  }
  throw new Error("expected AllowlistConfigError");
}

describe("allowlist config: string entries (backward compatible)", () => {
  it("reads plain strings as tables with no column rules", () => {
    const c = cfg(["Interviews", "comments"]);
    expect(c.tables).toEqual(["interviews", "comments"]);
    expect(c.columnRules.size).toBe(0);
  });

  it("treats a missing pgr block, tables or allow as default-deny, not an error", () => {
    for (const parsed of [{}, { other: 1 }, { pgr: {} }, { pgr: { tables: {} } }]) {
      const c = parseAllowConfig(parsed, FILE);
      expect(c.tables).toEqual([]);
      expect(c.columnRules.size).toBe(0);
    }
  });

  it("ignores keys outside the pgr block", () => {
    const c = parseAllowConfig(
      { fileZones: { allowWrite: ["x"] }, pgr: { tables: { allow: ["a"] } } },
      FILE
    );
    expect(c.tables).toEqual(["a"]);
  });
});

describe("allowlist config: object entries", () => {
  it("records a column list and also allows the table", () => {
    const c = cfg([
      "interviews",
      { table: "Memberships", columns: ["id", "Created_At", "role"] },
    ]);
    expect(c.tables).toEqual(["interviews", "memberships"]);
    expect(c.columnRules.get("memberships")).toEqual(["id", "created_at", "role"]);
    expect(c.columnRules.has("interviews")).toBe(false);
  });

  it("accepts a schema-qualified table", () => {
    const c = cfg([{ table: "public.memberships", columns: ["id"] }]);
    expect(c.columnRules.get("public.memberships")).toEqual(["id"]);
  });

  it("de-duplicates repeated column names", () => {
    const c = cfg([{ table: "t", columns: ["a", "A", "b"] }]);
    expect(c.columnRules.get("t")).toEqual(["a", "b"]);
  });
});

describe("allowlist config: malformed configuration fails loudly", () => {
  it("rejects a non-object top level", () => {
    expect(failure([])).toContain("must be a JSON object");
    expect(failure("x")).toContain("must be a JSON object");
    expect(failure(null)).toContain("must be a JSON object");
  });

  it("rejects wrongly typed pgr, tables and allow", () => {
    expect(failure({ pgr: [] })).toContain("pgr must be an object");
    expect(failure({ pgr: { tables: "a" } })).toContain("pgr.tables must be an object");
    expect(failure({ pgr: { tables: { allow: "a" } } })).toContain(
      "pgr.tables.allow must be an array"
    );
  });

  it("rejects unknown keys in pgr and pgr.tables", () => {
    expect(failure({ pgr: { tabels: {} } })).toContain("pgr.tabels");
    expect(failure({ pgr: { tables: { alow: [] } } })).toContain("pgr.tables.alow");
    expect(failure({ pgr: { tables: { allow: [], deny: [] } } })).toContain(
      "pgr.tables.deny"
    );
  });

  it("rejects entries that are neither a string nor an object", () => {
    expect(failure({ pgr: { tables: { allow: ["a", 42] } } })).toContain(
      "pgr.tables.allow[1]"
    );
    expect(failure({ pgr: { tables: { allow: [null] } } })).toContain("got null");
    expect(failure({ pgr: { tables: { allow: [["a"]] } } })).toContain(
      "pgr.tables.allow[0]"
    );
  });

  it("rejects an empty or blank table string", () => {
    expect(failure({ pgr: { tables: { allow: [""] } } })).toContain("empty string");
    expect(failure({ pgr: { tables: { allow: ["  "] } } })).toContain("empty string");
  });

  it("rejects unknown properties on an object entry", () => {
    const msg = failure({
      pgr: { tables: { allow: [{ table: "t", columns: ["a"], column: ["b"] }] } },
    });
    expect(msg).toContain("pgr.tables.allow[0].column");
  });

  it("rejects an object entry with no table or a bad table", () => {
    expect(failure({ pgr: { tables: { allow: [{ columns: ["a"] }] } } })).toContain(
      "allow[0].table"
    );
    expect(
      failure({ pgr: { tables: { allow: [{ table: 3, columns: ["a"] }] } } })
    ).toContain("allow[0].table");
    expect(
      failure({ pgr: { tables: { allow: [{ table: "", columns: ["a"] }] } } })
    ).toContain("allow[0].table");
  });

  it("rejects an object entry with no columns, and says how to allow all columns", () => {
    const msg = failure({ pgr: { tables: { allow: [{ table: "Memberships" }] } } });
    expect(msg).toContain("allow[0].columns");
    expect(msg).toContain('plain string "memberships"');
  });

  it("rejects empty, non-array and non-string columns", () => {
    for (const columns of [[], "id", { id: 1 }]) {
      expect(
        failure({ pgr: { tables: { allow: [{ table: "t", columns }] } } })
      ).toContain("allow[0].columns");
    }
    for (const bad of [1, null, "", "  "]) {
      expect(
        failure({ pgr: { tables: { allow: [{ table: "t", columns: ["a", bad] }] } } })
      ).toContain("allow[0].columns[1]");
    }
  });

  it("rejects a wildcard column rather than reading it as allow-all", () => {
    const msg = failure({
      pgr: { tables: { allow: [{ table: "t", columns: ["*"] }] } },
    });
    expect(msg).toContain("wildcards are not supported");
  });

  it("rejects the same table listed twice, in any mix of forms", () => {
    expect(failure({ pgr: { tables: { allow: ["t", "T"] } } })).toContain("more than once");
    expect(
      failure({ pgr: { tables: { allow: ["t", { table: "t", columns: ["a"] }] } } })
    ).toContain("more than once");
    expect(
      failure({
        pgr: {
          tables: {
            allow: [
              { table: "t", columns: ["a"] },
              { table: "T", columns: ["b"] },
            ],
          },
        },
      })
    ).toContain("more than once");
  });

  it("names the config file in every error", () => {
    expect(failure({ pgr: [] })).toContain(FILE);
  });
});
