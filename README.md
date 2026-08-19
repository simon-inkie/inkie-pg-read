# pgr

Ad-hoc read-only Postgres query CLI, built at Inkie. Works with any Supabase-backed (or plain Postgres) project.

```
pgr "select id, created_at, message from audit_events order by created_at desc limit 20"
```

## Why

`pgr` exists because the Supabase MCP server gives blanket, largely unrestricted database access out of the box, including write capability. That's more access than any agent should have against a production database.

`pgr` is the deliberate alternative: fast diagnostic queries against prod Supabase without opening the Studio UI, optionally scoped to a single agent's own [allowlisted tables](#per-agent-table-allowlist), and it never writes. If an agent needs a write, it hands over the SQL, and a human runs it directly or ships it as a migration. Writing is never something `pgr` itself does, on purpose, see [Auth setup](#auth-setup) and [Security notes](#security-notes) below for how that's enforced, not just asserted.

Designed for use in Claude Code and other agent sessions as well as by hand: agents can run `bun /path/to/pgr/src/cli.ts` directly, script queries, or import the programmatic API.

## Install

Requires [Bun](https://bun.sh) (built and tested on Bun 1.x, no minimum version is
pinned in `package.json`). `age` and `pass` are optional, needed only for the
per-agent creds file and the `pass`-store credential options respectively, see
[Auth setup](#auth-setup); the plain `SUPABASE_DB_URL` env var option needs neither.

```bash
git clone <repo-url> pgr
cd pgr
bun install
```

Then either install it as a real `pgr` command:

```bash
bun run build   # bundles src/cli.ts to dist/cli.js, which the bin entry points at
bun link        # puts a `pgr` executable in Bun's global bin directory

pgr --version
```

`bun link` writes the executable to Bun's global bin directory (`~/.bun/bin` on a
default install, `bun pm bin -g` prints it). Bun's own installer adds that to your
`PATH`; if you got Bun some other way, add it yourself or `pgr` won't resolve.
Undo the whole thing with `bun unlink` from this directory.

Or skip the build and run the source directly, optionally behind a shell alias:

```bash
bun /path/to/pgr/src/cli.ts "select 1 as n"

alias pgr="bun /path/to/pgr/src/cli.ts"
```

## Usage

```
pgr [options] "<SELECT query>"
pgr --help
pgr --version

Options:
  --format=<json|table|csv>   Output format (default: json)
  --output=<file>             Write output to file instead of stdout
  --agent=<name>              Override AGENT_NAME for per-agent table gating
  --help                      Show this help
  --version                   Show version
```

### Examples

```bash
# JSON output (default)
pgr "select count(*) as n from tickets"

# Pretty table
pgr --format=table "select id, status, created_at from tickets order by created_at desc limit 10"

# CSV to file
pgr --format=csv --output=out.csv "select * from audit_events limit 500"

# CTE
pgr "with recent as (select * from audit_events order by created_at desc limit 5) select * from recent"
```

## Auth setup

`pgr` resolves credentials in this order. Every option below resolves the same
Postgres role by convention: **`pgr_readonly`** (SELECT-only grants,
BYPASSRLS, bounded `statement_timeout`).

The credentials are not what enforces read-only, though. `pgr` sets
`default_transaction_read_only` on every connection it opens, in the Postgres
startup packet, so the *server* refuses every write (INSERT/UPDATE/DELETE/DDL,
or a SELECT that calls a write-capable function), regardless of what the
supplied credentials are actually granted. Point `SUPABASE_DB_URL` at a
superuser connection string and you still cannot write through `pgr`.

That holds as long as the connection actually accepts the startup parameter.
`pgr` sending it correctly is verified on the wire by the test suite, but it has
not been verified against a live pooler, and not every pooler passes
connection-level startup parameters through to the backend. A pooler that
silently ignored the parameter, rather than rejecting the connection, would
leave that session writable, and only the SELECT-only grants and the SQL guard
would be standing between a query and a write. If you're unsure about yours,
point `pgr` at a direct connection (port `5432`) rather than the transaction-mode
pooler (port `6543`).

### Option 1, direct connection string (highest priority)

```bash
export SUPABASE_DB_URL="postgresql://pgr_readonly.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

### Option 2, per-agent creds file

For unattended/agent use, `pgr` reads `~/agents/$AGENT_NAME/.pgr-creds.age` (age-encrypted) or `.pgr-creds` (plaintext) when `AGENT_NAME` is set, so subprocesses don't need a warm `gpg-agent`. Ignore this unless you're running several separate agent processes that each need their own credential file.

### Option 3, `pass` store (readonly role)

Store the full connection string in the `pass` password manager:

```bash
pass insert -m pgr/readonly-connection-string
# Paste the postgresql:// connection string for pgr_readonly when prompted
```

### Where `pgr` looks, and how to change it

Options 2 and 3 have to assume *some* layout. The defaults are generic, and each
one is overridable with an environment variable, read fresh on every invocation:

| Variable | Default | What it sets |
| --- | --- | --- |
| `PGR_AGENT_ROOT` | `~/agents` | Directory holding one subdirectory per agent |
| `PGR_AGENT_CONFIG_FILE` | `.pgr-agent.json` | Per-agent config filename, inside that subdirectory |
| `PGR_PASS_ENTRY` | `pgr/readonly-connection-string` | `pass` entry holding the read-only connection string |

So the per-agent creds file is `$PGR_AGENT_ROOT/$AGENT_NAME/.pgr-creds.age` and
the table allowlist is `$PGR_AGENT_ROOT/$AGENT_NAME/$PGR_AGENT_CONFIG_FILE`. The
working-directory allowlist described under [Per-agent table
allowlist](#per-agent-table-allowlist) is deliberately outside all of this: it
is always `./.pgr-agent.json`, whatever these variables are set to.

If you already run a fleet of agents with its own conventions (agent homes
somewhere other than `~/agents`, an existing per-agent config file you'd rather
extend than sit beside, a `pass` hierarchy organised your way), set these three
to match instead of reorganising to suit `pgr`. `pgr` only ever reads its own
`pgr` block in that config file and leaves the rest of the file alone, so
pointing it at a file you already use for something else is fine.

`pgr --help` prints the paths currently in effect, so you can check what a given
shell will actually resolve. Option 1 assumes nothing about where anything lives
and ignores all three.

### Provisioning the role

`pgr` doesn't create or manage the Postgres role itself, you provision it once, directly against your database. A minimal role with the properties `pgr` expects (the role name is a convention, not a requirement, call it whatever fits your setup and point the connection string at that):

```sql
create role pgr_readonly with login nosuperuser nocreatedb nocreaterole noinherit connection limit 20;

-- Real read-only enforcement lives in pgr itself (see Security notes below),
-- but a SELECT-only role is still the right first layer: keep it scoped.
alter role pgr_readonly bypassrls; -- only needed if you connect directly (not via PostgREST/JWT) and RLS would otherwise return zero rows
alter role pgr_readonly set statement_timeout = '30s';
alter role pgr_readonly set idle_in_transaction_session_timeout = '60s';
alter role pgr_readonly set lock_timeout = '5s';

grant usage on schema public to pgr_readonly;
revoke usage on schema auth from pgr_readonly;
revoke usage on schema storage from pgr_readonly;

-- Grant SELECT on exactly the tables you want pgr to be able to read.
-- Start narrow and add as needed, there's no default allowlist.
grant select on public.your_table_here to pgr_readonly;

alter role pgr_readonly with password '<generate one, don''t hand-type it>';
```

Store the resulting connection string via whichever of Options 1-3 above fits your setup. Rotate the password periodically and whenever someone with access leaves.

## Per-agent table allowlist

Opt-in, and off unless you switch it on. `pgr` gates table access in two
situations: when `AGENT_NAME` is set, as an environment variable or
per-invocation via `--agent=<name>`, and when a `.pgr-agent.json` sits in the
directory you run `pgr` from. With neither, you're in operator mode: no gate,
every table the role can read is queryable, and the rest of this section doesn't
apply to you.

When a name *is* set, `pgr` reads `~/agents/$AGENT_NAME/.pgr-agent.json` and
allows only the tables listed under `pgr.tables.allow`. It is default-deny: a
missing file, a missing `pgr` block, or an empty list means no tables. Denied
queries exit 1 without opening a connection. `information_schema` and
`pg_catalog` are always readable, so an agent can still introspect the schema.

Both halves of that path are overridable: `PGR_AGENT_ROOT` for the `~/agents`
part, `PGR_AGENT_CONFIG_FILE` for the `.pgr-agent.json` part, so the allowlist
can live in a per-agent config file you already maintain. See
[Where `pgr` looks](#where-pgr-looks-and-how-to-change-it).

```json
{
  "pgr": {
    "tables": {
      "allow": ["your_table_here", "another_table"]
    }
  }
}
```

Granting access means editing that file, it's plain JSON and there's no other
mechanism, and the change applies on the next invocation. Names are matched
case-insensitively, and a bare name in the list also allows its schema-qualified
form (`your_table_here` covers `public.your_table_here`). Other keys in the file
are left alone, `pgr` only reads its own block.

### Without an agent name, per directory

If `AGENT_NAME` isn't set, `pgr` looks for `.pgr-agent.json` in the directory you
ran it from. If that file is there, it gates the invocation on exactly the same
terms: same file shape, same `pgr.tables.allow` list, same default-deny, and
`information_schema` and `pg_catalog` are still readable. This is the scoped
read for one person in one project, with no agent homes to set up and no
`AGENT_NAME` to export. Drop the file in the project to scope `pgr` there,
delete it to go back to operator mode.

That location is fixed on purpose. `PGR_AGENT_ROOT` and `PGR_AGENT_CONFIG_FILE`
move the per-agent file, not this one, so what gates a given directory is
answerable by looking in it.

The per-agent tier wins outright. With `AGENT_NAME` set, `pgr` reads that
agent's file and ignores any `.pgr-agent.json` in the working directory,
including when the agent's own file is missing, which stays default-deny as
before. Nothing about an existing `AGENT_NAME` setup changes.

Gotcha: the trigger is the mere presence of `AGENT_NAME`. If your shell exports
it for something unrelated, this gate switches on silently and starts denying
queries. If `pgr` refuses a table you know your role can read, check
`echo $AGENT_NAME` first, then check for a `.pgr-agent.json` in the directory
you're standing in.

## SQL guard

The SQL guard is a **secondary, string-level filter**, not a guarantee. The real security
boundary is Postgres refusing writes on a `default_transaction_read_only` session, backed by
the SELECT-only grants on `pgr_readonly`; see Auth setup above. Treat the guard as
defence in depth against accidental or injected DML/DDL, and as the thing that gives you a
clear local error instead of a server one, not as a bypass-proof gate on its own:

- **Allowed:** `SELECT` statements, CTEs (`WITH ... SELECT`), subqueries, JOINs, aggregates, window functions
- **Blocked:** `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`, `COPY`, `SET`, `EXECUTE`, `CALL`, `DO`
- **Blocked:** multiple statements (`;`-separated)
- **Blocked:** dollar-quoted strings (`$$ ... $$`), PL/pgSQL territory
- **Blocked:** data-modifying CTE bodies (`WITH t AS (INSERT ... RETURNING *) SELECT * FROM t`)
- **Blocked:** `SELECT ... INTO newtable` (creates a table)
- Comment stripping prevents `-- SELECT\nDROP TABLE` tricks, but this is a string filter, not
  proof against every bypass shape.

The guard biases toward false-positives, if a query pattern is borderline, it's rejected.

### Security notes

- Every connection `pgr` opens is read-only at the Postgres session level
  (`default_transaction_read_only`, set in the startup packet by `src/client.ts`). This is
  enforced by the server, not by `pgr`, and it does not depend on which role the supplied
  credentials resolve to. It is what closes the guard's string-level edge cases (write-CTE,
  `SELECT ... INTO`): even a query that slips past the guard has no writable session to
  execute in. There is no flag that turns it off. If you genuinely need write access,
  connect to the database directly, outside this tool.
- The `pgr_readonly` role is the second layer: SELECT-only grants, `auth`/`storage`
  schemas revoked, a bounded `statement_timeout`. It limits what is *readable*, which the
  session setting does not. Keep `pgr` for trusted operator/agent use only regardless.
- Never expose `pgr` to untrusted input via HTTP or any network interface.
- Connection strings are never logged or printed.
- Queries themselves *are* logged. Every invocation appends one JSON line to
  `~/.pgr/audit/YYYY-MM-DD.jsonl`: timestamp, the agent name (or `cwd-project`
  when a working-directory allowlist gated it, or `operator` when nothing gated
  it), the full SQL text, the tables it referenced, and the allow/deny decision
  (plus the reason, on a deny). It's local-only, never transmitted anywhere, and
  best-effort, a failed write goes to stderr and the query still runs, so treat it
  as a record for you rather than a tamper-proof audit trail. Delete or rotate the
  directory yourself; `pgr` never prunes it.

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Typecheck
bun run typecheck

# Run directly
bun run src/cli.ts "select 1 as n"

# Bundle the CLI to dist/cli.js (what the `pgr` bin entry points at)
bun run build
```

Day-to-day use runs `src/cli.ts` straight through Bun; `bun run build` is only
needed if you want a single bundled file to install or ship (npm publish is out
of scope for v0, see below).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## v0 scope

v0 is the core query engine. Out of scope for now:

- Named query templates (`pgr report:weekly-summary`)
- Interactive REPL
- npm publish

## License

MIT
