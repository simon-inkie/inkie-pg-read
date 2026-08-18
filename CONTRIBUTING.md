# Contributing to pgr

## What's easy to send as a PR

- Bug fixes
- New output formats or CLI options
- Additional tests, especially for `sql-guard.ts` or `table-refs.ts`
- Documentation fixes

## What needs an issue first

Anything touching `src/sql-guard.ts`, `src/auth.ts`, or the connection options
in `src/client.ts`. The SQL guard is the defence-in-depth layer against
accidental or injected DML/DDL; the auth module resolves database credentials,
where every source must stay pinned to a SELECT-only role; and the client's
connection options carry the session-level read-only setting that Postgres
enforces. All three are security-sensitive: open an issue describing the
change and the reasoning before sending a PR, so the approach gets agreed
before code review has to catch a mistake here.

In particular, a PR that adds a new credential source, or any path to a
write-capable role, will not be accepted. `pgr` is read-only by construction,
not by convention: `src/client.ts` sets `default_transaction_read_only` on
every connection it opens, so Postgres itself refuses writes whatever the
supplied credentials are granted. A PR that removes or conditions that
parameter is the one change that would make the claim false, and will not be
accepted either.

New "allowed" or "blocked" SQL patterns in the guard need a test in
`test/sql-guard.test.ts` covering both the pattern and why it's safe or
unsafe, not just the code change.

## Development

```bash
bun install
bun test
bun run typecheck
bun run src/cli.ts "select 1 as n"
```

## Scope

See the README's "v0 scope" section for what's intentionally not here yet
(named query templates, an interactive REPL, npm publish). PRs adding those
are welcome to open as an issue first to agree the shape.

## License

MIT, see [LICENSE](LICENSE). Pull requests are assumed to be offered under
the same licence.
