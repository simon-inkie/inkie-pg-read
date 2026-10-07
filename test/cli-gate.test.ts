/**
 * CLI-level tests for the table-allowlist gate.
 *
 * The unit tests in agent-allowlist.test.ts cover resolution and matching.
 * These cover the wiring: that the CLI picks the right tier for a real
 * invocation, from a real working directory, with real environment variables.
 * That is the part a refactor can silently break while every unit test stays
 * green — in particular the "operator mode still gets through untouched" case,
 * which has no allowlist to assert against.
 *
 * Each invocation runs in a throwaway directory with a throwaway HOME (so the
 * audit log lands there, not in the operator's real ~/.pgr) and a deliberately
 * unreachable SUPABASE_DB_URL. A query that clears the gate therefore fails at
 * connect time, which is the signal we assert on: reaching a connection error
 * means the gate let it through.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pgr-cli-test-"));
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** Unreachable on purpose: connect fails immediately, no database is touched. */
const DEAD_DB_URL = "postgresql://nobody:nobody@127.0.0.1:1/postgres";

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

interface RunOptions {
  /** Contents of .pgr-agent.json in the invocation directory, if any. */
  cwdConfig?: unknown;
  /** AGENT_NAME for the invocation, and the per-agent config to write for it. */
  agentName?: string;
  agentConfig?: unknown;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(query: string, opts: RunOptions = {}): RunResult {
  const dir = mkdtempSync(join(TEST_ROOT, "run-"));
  const home = mkdtempSync(join(TEST_ROOT, "home-"));
  const agentRoot = join(dir, "agent-root");

  if (opts.cwdConfig !== undefined) {
    writeFileSync(
      join(dir, ".pgr-agent.json"),
      typeof opts.cwdConfig === "string"
        ? opts.cwdConfig
        : JSON.stringify(opts.cwdConfig),
      "utf-8"
    );
  }

  if (opts.agentName && opts.agentConfig !== undefined) {
    mkdirSync(join(agentRoot, opts.agentName), { recursive: true });
    writeFileSync(
      join(agentRoot, opts.agentName, ".pgr-agent.json"),
      JSON.stringify(opts.agentConfig),
      "utf-8"
    );
  }

  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    PGR_AGENT_ROOT: agentRoot,
    SUPABASE_DB_URL: DEAD_DB_URL,
  };
  if (opts.agentName) env["AGENT_NAME"] = opts.agentName;

  const proc = Bun.spawnSync({
    cmd: ["bun", "run", CLI, query],
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** The gate denied the query: no connection was attempted. */
function wasDenied(result: RunResult): boolean {
  return result.exitCode === 1 && result.stderr.includes("access denied");
}

/** The gate let the query through: it got as far as trying to connect. */
function reachedConnection(result: RunResult): boolean {
  return !result.stderr.includes("access denied");
}

describe("cli gate: operator mode (no AGENT_NAME, no cwd config)", () => {
  it("does not gate any table", () => {
    const result = run("select * from anything_at_all limit 1");
    expect(wasDenied(result)).toBe(false);
    expect(reachedConnection(result)).toBe(true);
  });
});

describe("cli gate: working-directory config", () => {
  it("allows a listed table", () => {
    const result = run("select * from tickets limit 1", {
      cwdConfig: { pgr: { tables: { allow: ["tickets"] } } },
    });
    expect(reachedConnection(result)).toBe(true);
  });

  it("denies an unlisted table, naming the file that gated it", () => {
    const result = run("select * from users limit 1", {
      cwdConfig: { pgr: { tables: { allow: ["tickets"] } } },
    });
    expect(wasDenied(result)).toBe(true);
    expect(result.stderr).toContain("users");
    expect(result.stderr).toContain(".pgr-agent.json");
  });

  it("denies everything when the file is present but empty (default-deny)", () => {
    const result = run("select * from tickets limit 1", {
      cwdConfig: { pgr: { tables: { allow: [] } } },
    });
    expect(wasDenied(result)).toBe(true);
  });

  it("fails loudly, without connecting, when the file is malformed", () => {
    const result = run("select * from tickets limit 1", {
      cwdConfig: "{ not valid json",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid allowlist config");
    expect(result.stderr).toContain(".pgr-agent.json");
    expect(result.stderr).not.toContain("Query error");
  });

  it("still allows information_schema with an empty allow list", () => {
    const result = run(
      "select table_name from information_schema.tables limit 1",
      { cwdConfig: { pgr: { tables: { allow: [] } } } }
    );
    expect(reachedConnection(result)).toBe(true);
  });
});

describe("cli gate: precedence", () => {
  it("AGENT_NAME wins over a working-directory config", () => {
    // Agent file allows agent_table; cwd file allows cwd_table. If the agent
    // tier is in charge, cwd_table is denied and agent_table is not.
    const opts: RunOptions = {
      agentName: "precedence-agent",
      agentConfig: { pgr: { tables: { allow: ["agent_table"] } } },
      cwdConfig: { pgr: { tables: { allow: ["cwd_table"] } } },
    };

    const denied = run("select * from cwd_table limit 1", opts);
    expect(wasDenied(denied)).toBe(true);

    const allowed = run("select * from agent_table limit 1", opts);
    expect(reachedConnection(allowed)).toBe(true);
  });

  it("per-agent mode is unaffected by an unrelated cwd config", () => {
    // Regression guard for the pre-existing behaviour: with AGENT_NAME set and
    // no per-agent file, every table is denied — the cwd file must not become
    // a fallback that quietly widens an agent's access.
    const result = run("select * from cwd_table limit 1", {
      agentName: "no-config-agent",
      cwdConfig: { pgr: { tables: { allow: ["cwd_table"] } } },
    });
    expect(wasDenied(result)).toBe(true);
    expect(result.stderr).toContain("agent allowlist");
  });
});

describe("cli gate: column permissions", () => {
  const config = {
    pgr: {
      tables: {
        allow: [
          "interviews",
          { table: "memberships", columns: ["id", "created_at", "role", "client_id"] },
        ],
      },
    },
  };

  /** Denied by the column gate: no connection, message names column and file. */
  function wasColumnDenied(result: RunResult): boolean {
    return (
      result.exitCode === 1 &&
      result.stderr.includes("access denied") &&
      !result.stderr.includes("Query error")
    );
  }

  it("lets permitted columns through to the connection", () => {
    const result = run("select m.id, m.role from memberships m limit 1", {
      cwdConfig: config,
    });
    expect(wasDenied(result)).toBe(false);
    expect(result.stderr).toContain("Query error");
  });

  it("keeps plain-string tables unrestricted alongside object entries", () => {
    const result = run("select * from interviews limit 1", { cwdConfig: config });
    expect(wasDenied(result)).toBe(false);
  });

  it("denies an unpermitted column, naming the column and the config file", () => {
    const result = run("select m.email from memberships m", { cwdConfig: config });
    expect(wasColumnDenied(result)).toBe(true);
    expect(result.stderr).toContain("memberships.email");
    expect(result.stderr).toContain(".pgr-agent.json");
    expect(result.stderr).toContain("Allowed columns: id, created_at, role, client_id");
  });

  it("denies select * on a restricted table", () => {
    const result = run("select * from memberships", { cwdConfig: config });
    expect(wasColumnDenied(result)).toBe(true);
    expect(result.stderr).toContain("select *");
  });

  it("denies a whole-row function over a restricted table", () => {
    const result = run("select to_jsonb(m) from memberships m", { cwdConfig: config });
    expect(wasColumnDenied(result)).toBe(true);
    expect(result.stderr).toContain("whole-row");
  });

  it("applies in the per-agent tier too", () => {
    const result = run("select m.email from memberships m", {
      agentName: "col-agent",
      agentConfig: config,
    });
    expect(wasColumnDenied(result)).toBe(true);
    expect(result.stderr).toContain("memberships.email");
  });

  it("still applies the table gate first", () => {
    const result = run("select 1 from secrets", { cwdConfig: config });
    expect(wasDenied(result)).toBe(true);
    expect(result.stderr).toContain("table `secrets`");
  });

  it("fails loudly on a malformed object entry, without connecting", () => {
    const result = run("select 1 from interviews", {
      cwdConfig: { pgr: { tables: { allow: [{ table: "memberships" }] } } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid allowlist config");
    expect(result.stderr).toContain("allow[0].columns");
    expect(result.stderr).not.toContain("Query error");
  });

  it("denies a table that follows a comma in FROM", () => {
    const result = run("select 1 from interviews, secrets", { cwdConfig: config });
    expect(wasDenied(result)).toBe(true);
    expect(result.stderr).toContain("table `secrets`");
  });

  it("denies a dynamic-SQL function used as a FROM item", () => {
    const result = run(
      "select 1 from interviews o, query_to_xml('select email from memberships', true, false, '') x",
      { cwdConfig: config }
    );
    expect(wasColumnDenied(result)).toBe(true);
    expect(result.stderr).toContain("query_to_xml");
  });

  it("denies pg_stats while column rules are active", () => {
    const result = run(
      "select most_common_vals from pg_catalog.pg_stats where attname = 'email'",
      { cwdConfig: config }
    );
    expect(wasColumnDenied(result)).toBe(true);
    expect(result.stderr).toContain("pg_stats");
  });

  it("denies an unparseable query that smuggles in dynamic SQL", () => {
    const result = run(
      "select (o).x, query_to_xml('select email from memberships', true, false, '') from interviews o",
      { cwdConfig: config }
    );
    expect(wasColumnDenied(result)).toBe(true);
  });

  it("does not gate columns in operator mode", () => {
    const result = run("select * from memberships");
    expect(wasDenied(result)).toBe(false);
  });
});
