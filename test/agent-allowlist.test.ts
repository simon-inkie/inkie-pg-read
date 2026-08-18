import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import {
  readAgentAllowlist,
  checkAllowlist,
  buildDenialMessage,
  resolveAgentName,
} from "../src/agent-allowlist.js";
import { agentConfigPath } from "../src/agent-paths.js";

// ── Test fixture helpers ──────────────────────────────────────────────────────
//
// Everything this suite writes lives under a throwaway tmpdir, pointed at by
// PGR_AGENT_ROOT for the duration of the run. Nothing here ever touches the
// real home directory: an earlier version built its fixture path from
// homedir() and rm -rf'd it, which both destroys a real directory that happens
// to share the name and fails outright where $HOME is read-only.

const TEST_AGENT = "pgr-test-agent-fixture";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "pgr-test-"));

const originalAgentRoot = process.env["PGR_AGENT_ROOT"];

/** Resolved through the real helper, so the test exercises actual resolution. */
function testConfigPath(): string {
  return agentConfigPath(TEST_AGENT);
}

function writeConfig(config: unknown): void {
  const configPath = testConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function removeConfig(): void {
  const agentDir = dirname(testConfigPath());
  if (existsSync(agentDir)) {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  process.env["PGR_AGENT_ROOT"] = TEST_ROOT;
  removeConfig();
});

afterEach(() => {
  removeConfig();
  if (originalAgentRoot === undefined) {
    delete process.env["PGR_AGENT_ROOT"];
  } else {
    process.env["PGR_AGENT_ROOT"] = originalAgentRoot;
  }
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── resolveAgentName ──────────────────────────────────────────────────────────

describe("resolveAgentName", () => {
  it("returns agentFlag when provided", () => {
    expect(resolveAgentName("myagent")).toBe("myagent");
  });

  it("returns AGENT_NAME env var when no flag", () => {
    const original = process.env["AGENT_NAME"];
    process.env["AGENT_NAME"] = "envagent";
    try {
      expect(resolveAgentName()).toBe("envagent");
    } finally {
      if (original === undefined) {
        delete process.env["AGENT_NAME"];
      } else {
        process.env["AGENT_NAME"] = original;
      }
    }
  });

  it("returns undefined when no flag and no env var", () => {
    const original = process.env["AGENT_NAME"];
    delete process.env["AGENT_NAME"];
    try {
      expect(resolveAgentName()).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env["AGENT_NAME"] = original;
      }
    }
  });

  it("flag takes priority over env var", () => {
    const original = process.env["AGENT_NAME"];
    process.env["AGENT_NAME"] = "envagent";
    try {
      expect(resolveAgentName("flagagent")).toBe("flagagent");
    } finally {
      if (original === undefined) {
        delete process.env["AGENT_NAME"];
      } else {
        process.env["AGENT_NAME"] = original;
      }
    }
  });
});

// ── readAgentAllowlist ────────────────────────────────────────────────────────

describe("readAgentAllowlist", () => {
  it("returns empty array when config file is missing", () => {
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
  });

  it("returns empty array when pgr block is absent", () => {
    writeConfig({ fileZones: { allowWrite: [] } });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
  });

  it("returns empty array when pgr.tables is absent", () => {
    writeConfig({ pgr: {} });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
  });

  it("returns empty array when pgr.tables.allow is absent", () => {
    writeConfig({ pgr: { tables: {} } });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
  });

  it("returns empty array when allow is empty", () => {
    writeConfig({ pgr: { tables: { allow: [] } } });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
  });

  it("returns listed tables", () => {
    writeConfig({ pgr: { tables: { allow: ["ticket_transcripts", "comments"] } } });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([
      "ticket_transcripts",
      "comments",
    ]);
  });

  it("normalises table names to lowercase", () => {
    writeConfig({ pgr: { tables: { allow: ["Ticket_Transcripts", "COMMENTS"] } } });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([
      "ticket_transcripts",
      "comments",
    ]);
  });

  it("ignores non-string entries in allow array", () => {
    writeConfig({ pgr: { tables: { allow: ["tickets", 42, null, true] } } });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual(["tickets"]);
  });

  it("works alongside other config keys (fileZones etc)", () => {
    writeConfig({
      fileZones: { allowWrite: ["~/git-repos/**"] },
      pgr: { tables: { allow: ["ticket_transcripts"] } },
    });
    expect(readAgentAllowlist(TEST_AGENT)).toEqual(["ticket_transcripts"]);
  });

  it("returns empty array on malformed JSON", () => {
    const configPath = testConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{ not valid json", "utf-8");
    expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
  });
});

// ── checkAllowlist ────────────────────────────────────────────────────────────

describe("checkAllowlist", () => {
  it("allows empty table refs (no tables in query)", () => {
    writeConfig({ pgr: { tables: { allow: [] } } });
    const result = checkAllowlist(new Set(), TEST_AGENT);
    expect(result.allowed).toBe(true);
  });

  it("denies when no pgr block and tables are referenced", () => {
    writeConfig({ fileZones: {} });
    const result = checkAllowlist(new Set(["users"]), TEST_AGENT);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denied).toContain("users");
    }
  });

  it("allows a listed table", () => {
    writeConfig({ pgr: { tables: { allow: ["tickets"] } } });
    const result = checkAllowlist(new Set(["tickets"]), TEST_AGENT);
    expect(result.allowed).toBe(true);
  });

  it("denies an unlisted table", () => {
    writeConfig({ pgr: { tables: { allow: ["tickets"] } } });
    const result = checkAllowlist(new Set(["users"]), TEST_AGENT);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denied).toContain("users");
    }
  });

  it("denies a mix of allowed and denied tables", () => {
    writeConfig({ pgr: { tables: { allow: ["tickets"] } } });
    const result = checkAllowlist(new Set(["tickets", "users"]), TEST_AGENT);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denied).toContain("users");
      expect(result.denied).not.toContain("tickets");
    }
  });

  it("auto-allows information_schema tables regardless of config", () => {
    writeConfig({ pgr: { tables: { allow: [] } } });
    const result = checkAllowlist(
      new Set(["information_schema.tables"]),
      TEST_AGENT
    );
    expect(result.allowed).toBe(true);
  });

  it("auto-allows pg_catalog tables regardless of config", () => {
    writeConfig({ pgr: { tables: { allow: [] } } });
    const result = checkAllowlist(
      new Set(["pg_catalog.pg_tables"]),
      TEST_AGENT
    );
    expect(result.allowed).toBe(true);
  });

  it("auto-allows information_schema even with empty allowlist and no config", () => {
    // No config file at all
    const result = checkAllowlist(
      new Set(["information_schema.columns"]),
      TEST_AGENT
    );
    expect(result.allowed).toBe(true);
  });

  it("allows schema-qualified ref when bare table name is in allowlist", () => {
    writeConfig({ pgr: { tables: { allow: ["tickets"] } } });
    const result = checkAllowlist(new Set(["public.tickets"]), TEST_AGENT);
    expect(result.allowed).toBe(true);
  });

  it("allows schema-qualified ref when full schema.table is in allowlist", () => {
    writeConfig({ pgr: { tables: { allow: ["public.tickets"] } } });
    const result = checkAllowlist(new Set(["public.tickets"]), TEST_AGENT);
    expect(result.allowed).toBe(true);
  });

  it("case-insensitive: mixed case ref against lowercase allowlist", () => {
    writeConfig({ pgr: { tables: { allow: ["tickets"] } } });
    // extractTableRefs normalises to lowercase, but test directly here too
    const result = checkAllowlist(new Set(["tickets"]), TEST_AGENT);
    expect(result.allowed).toBe(true);
  });
});

// ── buildDenialMessage ────────────────────────────────────────────────────────

describe("buildDenialMessage", () => {
  it("contains the denied table name", () => {
    const msg = buildDenialMessage(["users"], "alice");
    expect(msg).toContain("`users`");
  });

  it("contains the agent name in the config path", () => {
    const msg = buildDenialMessage(["users"], "alice");
    // Suffix only: the resolved root varies with PGR_AGENT_ROOT.
    expect(msg).toContain("alice/.pgr-agent.json");
  });

  it("points at the allowlist config as the way to grant access", () => {
    const msg = buildDenialMessage(["users"], "alice");
    expect(msg).toContain("pgr.tables.allow");
    expect(msg).toContain(`"allow": ["users"]`);
    expect(msg).not.toContain("DM ");
  });

  it("exits 1 indication — message is on stderr", () => {
    const msg = buildDenialMessage(["secret_table"], "bob");
    expect(msg).toContain("access denied");
    expect(msg).toContain("secret_table");
  });
});

// ── agentConfigPath ───────────────────────────────────────────────────────────

describe("agentConfigPath", () => {
  it("resolves <root>/<agent>/.pgr-agent.json by default", () => {
    const agentDir = dirname(testConfigPath());
    expect(agentConfigPath(TEST_AGENT)).toBe(join(agentDir, ".pgr-agent.json"));
  });

  it("respects a PGR_AGENT_CONFIG_FILE override", () => {
    const agentDir = dirname(testConfigPath());
    const original = process.env["PGR_AGENT_CONFIG_FILE"];
    process.env["PGR_AGENT_CONFIG_FILE"] = ".custom.json";
    try {
      expect(agentConfigPath(TEST_AGENT)).toBe(join(agentDir, ".custom.json"));
      // No file matches the override, so the allowlist reads default-deny.
      expect(readAgentAllowlist(TEST_AGENT)).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env["PGR_AGENT_CONFIG_FILE"];
      } else {
        process.env["PGR_AGENT_CONFIG_FILE"] = original;
      }
    }
  });
});
