/**
 * Auth resolution for pgr.
 *
 * Priority (v1.3: every source resolves a SELECT-only role):
 *   1. SUPABASE_DB_URL: env override (CI / one-shot / testing)
 *   2. `<agent root>/$AGENT_NAME/.pgr-creds.age` (or `.pgr-creds` plaintext): canonical
 *      for AGENTS. Agent root defaults to `~/agents`, override with PGR_AGENT_ROOT.
 *   3. `pass <entry>`: canonical for OPERATORS (interactive shells). The entry defaults
 *      to `pgr/readonly-connection-string`, override with PGR_PASS_ENTRY.
 *   4. Error with setup instructions
 *
 * §Amendment 2026-08-06 — the legacy escape-hatch sources (old 4-5) are REMOVED
 * entirely, rather than left flag-gated. Service-role credentials, whether derived
 * from the Supabase project env vars or read from the `pass` admin entry, were
 * the only way pgr could reach a role that is not SELECT-restricted, and so the
 * only way a SQL-guard bypass (src/sql-guard.ts: write-CTE, SELECT INTO) could
 * become a real write. An off-by-default flag is still a path to a write-capable
 * connection, and pgr's whole design point is that it never has one. Emergency and
 * local-dev access now goes direct to the database outside this tool instead of
 * through an escape hatch inside it. The SELECT-only role (sources 2-3) is
 * unaffected; it was always the real boundary and is now the only one. The notes
 * below are the record of what this replaced, left as they were.
 *
 * §Amendment 2026-05-22 (afternoon) — added per-agent creds file source. The earlier
 * pass-canonical chain works for OPERATORS but fails to scale for AGENTS because
 * gpg-agent's cache needs interactive warming and times out. The per-agent file is
 * encrypted at rest via `age` with `~/.pgr/identity.txt` (chmod 600) as the
 * recipient identity. Agents on the same machine all share the identity (file-
 * perms are the trust boundary, mirroring the rest of the agent-system).
 *
 * §Amendment 2026-05-22 (earlier) — swap to the SELECT-only readonly role as
 * canonical, now that `pgr_readonly` exists on the target database.
 * Service-role paths kept as escape hatch for emergencies + local dev.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { agentRoot, tildify } from "./agent-paths.js";

export interface ConnectionConfig {
  connectionString: string;
  source: "env:SUPABASE_DB_URL" | "file:agent-creds" | "pass:readonly";
}

/**
 * The `pass` store entry holding the read-only connection string.
 * Read live from process.env so it can be overridden per invocation.
 * Exported so the CLI help text can show the entry actually in use.
 */
export function passEntry(): string {
  return process.env["PGR_PASS_ENTRY"] || "pgr/readonly-connection-string";
}

/**
 * Read a value from the `pass` password store.
 * Returns null if pass is unavailable or the entry doesn't exist.
 */
/**
 * Read the per-agent connection string from `<agent root>/$AGENT_NAME/.pgr-creds.age`
 * (or `.pgr-creds` plaintext fallback). The agent root defaults to `~/agents` and is
 * overridable with PGR_AGENT_ROOT. Decrypts via `age -d -i ~/.pgr/identity.txt`
 * when encrypted; reads directly when plaintext.
 *
 * This is the no-gpg-needed path for agent subprocesses — solves the
 * "warm the gpg-agent cache once per day" scaling problem (2026-05-22).
 *
 * Returns null if no creds file exists for the current agent (callers fall
 * through to the next source). Surfaces decryption errors to stderr when
 * the encrypted file exists but decryption fails (PGR_DEBUG always; otherwise
 * only when there's a meaningful stderr from the age process).
 */
function readFromAgentCredsFile(): string | null {
  const agentName = process.env["AGENT_NAME"];
  if (!agentName) return null;

  const agentDir = join(agentRoot(), agentName);
  const encryptedPath = join(agentDir, ".pgr-creds.age");
  const plaintextPath = join(agentDir, ".pgr-creds");

  // Prefer encrypted form if present
  if (existsSync(encryptedPath)) {
    const identityPath = join(homedir(), ".pgr", "identity.txt");
    if (!existsSync(identityPath)) {
      process.stderr.write(
        `pgr: ${encryptedPath} exists but ${identityPath} is missing — cannot decrypt\n`,
      );
      return null;
    }
    try {
      const value = execFileSync(
        "age",
        ["-d", "-i", identityPath, encryptedPath],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5_000 },
      ).trim();
      return value.length > 0 ? value : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: unknown }).stderr;
      const stderrText =
        stderr instanceof Buffer
          ? stderr.toString("utf-8")
          : typeof stderr === "string"
            ? stderr
            : "";
      if (process.env["PGR_DEBUG"] || stderrText) {
        process.stderr.write(
          `pgr: age decryption of ${encryptedPath} failed:\n  ${msg}\n` +
            (stderrText ? `  stderr: ${stderrText.trim()}\n` : ""),
        );
      }
      return null;
    }
  }

  // Plaintext fallback (chmod 600 expected; we trust the operator on perms)
  if (existsSync(plaintextPath)) {
    try {
      const value = readFileSync(plaintextPath, "utf-8").trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  return null;
}

function readFromPass(passPath: string): string | null {
  try {
    const value = execFileSync("pass", [passPath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...process.env,
        // Ensure gpg-agent has a TTY hint for pinentry, falling back to /dev/tty
        // so the lookup works from non-login shells / subprocess invocations.
        GPG_TTY: process.env["GPG_TTY"] || "/dev/tty",
      },
    }).trim();
    return value.length > 0 ? value : null;
  } catch (err) {
    // Surface the underlying error to stderr so silent-fails are diagnosable.
    // Don't throw — the caller's resolution chain has fallbacks; just log.
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: unknown }).stderr;
    const stderrText =
      stderr instanceof Buffer
        ? stderr.toString("utf-8")
        : typeof stderr === "string"
          ? stderr
          : "";
    if (process.env["PGR_DEBUG"] || stderrText) {
      process.stderr.write(
        `pgr: pass lookup for '${passPath}' failed:\n  ${msg}\n` +
          (stderrText ? `  stderr: ${stderrText.trim()}\n` : ""),
      );
    }
    return null;
  }
}

/**
 * Setup instructions, built against the live resolved conventions so the paths
 * shown are the ones pgr will actually read (defaults, or whatever the
 * PGR_AGENT_ROOT / PGR_PASS_ENTRY overrides point at).
 */
function setupInstructions(): string {
  const entry = passEntry();
  const credsPath = tildify(join(agentRoot(), "$AGENT", ".pgr-creds.age"));

  return `
No Postgres connection string found. Configure one of:

  Option 1 (env override — CI, one-shot, testing):
    export SUPABASE_DB_URL="postgresql://pgr_readonly.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"

  Option 2 (canonical for AGENTS — encrypted per-agent creds file):
    # As operator, with AGENT_NAME unset and age installed:
    age-keygen -o ~/.pgr/identity.txt && chmod 600 ~/.pgr/identity.txt
    pass ${entry} | \\
      age -e -i ~/.pgr/identity.txt > ${credsPath}
    chmod 600 ${credsPath}

  Option 3 (canonical for OPERATORS — pass store):
    pass insert -m ${entry}
    # Paste the postgresql:// connection string for pgr_readonly

  The agent root and the pass entry above are pgr's defaults. Override them
  with PGR_AGENT_ROOT and PGR_PASS_ENTRY to match an existing layout.

Every option resolves a SELECT-only role. pgr has no write-capable connection
path; if you need one, go direct to the database outside this tool.

See README.md for full setup instructions.
`.trim();
}

/**
 * Resolve a Postgres connection string using the priority chain.
 * Throws with setup instructions if no valid source is found.
 */
export function resolveConnectionConfig(): ConnectionConfig {
  // 1. SUPABASE_DB_URL env override (CI / one-shot / testing)
  const directUrl = process.env["SUPABASE_DB_URL"];
  if (directUrl && directUrl.trim().length > 0) {
    return { connectionString: directUrl.trim(), source: "env:SUPABASE_DB_URL" };
  }

  // 2. Per-agent creds file (encrypted with age + identity at ~/.pgr/identity.txt,
  //    or plaintext fallback). No gpg-agent dependency = works from any subprocess.
  //    Canonical path for AGENT subprocesses; operators should use pass below.
  const agentCreds = readFromAgentCredsFile();
  if (agentCreds) {
    return { connectionString: agentCreds, source: "file:agent-creds" };
  }

  // 3. pass readonly — canonical for interactive operators (SELECT-only role)
  const readonlyValue = readFromPass(passEntry());
  if (readonlyValue) {
    return { connectionString: readonlyValue, source: "pass:readonly" };
  }

  // 4. Error — there is deliberately no further fallback. See the
  //    §Amendment 2026-08-06 note at the top of this file.
  throw new Error(setupInstructions());
}
