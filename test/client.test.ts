import { describe, it, expect } from "bun:test";
import net from "node:net";
import { createClient, runQuery } from "../src/client.js";
import { SqlGuardError } from "../src/sql-guard.js";

// ── runQuery guards before it connects ───────────────────────────────────────
//
// The SQL guard used to live only in src/cli.ts, so any programmatic consumer
// of the exported runQuery could execute DML/DDL despite pgr being read-only.
// The guard now runs as the first statement of runQuery, before createClient
// and before any network activity — which is exactly what makes these tests
// possible without a database: the connection string below is deliberately
// unreachable (port 1), so a rejection proves the guard fired first.

const FAKE_CONNECTION = "postgresql://fake:fake@localhost:1/fake";

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("runQuery SQL guard", () => {
  it("rejects DELETE before opening a connection", async () => {
    const err = await catchError(
      runQuery(FAKE_CONNECTION, "DELETE FROM foo")
    );
    expect(err).toBeInstanceOf(SqlGuardError);
    expect((err as SqlGuardError).message).toContain("only SELECT statements allowed");
  });

  it("rejects DROP before opening a connection", async () => {
    const err = await catchError(
      runQuery(FAKE_CONNECTION, "DROP TABLE foo")
    );
    expect(err).toBeInstanceOf(SqlGuardError);
  });

  it("rejects multiple statements before opening a connection", async () => {
    const err = await catchError(
      runQuery(FAKE_CONNECTION, "SELECT 1; DELETE FROM foo")
    );
    expect(err).toBeInstanceOf(SqlGuardError);
  });

  it("does not reject a SELECT (fails on connection, not on the guard)", async () => {
    const err = await catchError(runQuery(FAKE_CONNECTION, "SELECT 1"));
    // It still fails — the connection string is fake — but the failure must be
    // a connection error, not a guard rejection.
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(SqlGuardError);
  });
});

// ── every connection is read-only at the Postgres session level ──────────────
//
// `default_transaction_read_only` is what makes the README's "read-only by
// construction" claim true: Postgres refuses writes on the session whatever the
// supplied credentials are actually granted, so a caller who points
// SUPABASE_DB_URL at a superuser connection string still cannot write.
//
// Proving it needs no live database. postgres.js sends session parameters in
// the startup packet, so a bare TCP listener that captures the first bytes of a
// connection sees exactly what a real server would.

// Startup parameters are NUL-separated key/value pairs on the wire.
const NUL = String.fromCharCode(0);

describe("createClient read-only session", () => {
  it("puts default_transaction_read_only in the parsed connection options", async () => {
    const client = createClient(FAKE_CONNECTION);
    try {
      expect(client.options.connection.default_transaction_read_only).toBe(true);
      // The sibling parameter, so a regression that drops the whole
      // `connection` object is distinguishable from one that drops just this.
      expect(client.options.connection.statement_timeout).toBe(30_000);
    } finally {
      await client.end();
    }
  });

  it("sends default_transaction_read_only in the startup packet", async () => {
    // A TCP listener standing in for Postgres: it never speaks the protocol,
    // it just records the startup packet postgres.js writes on connect.
    const server = net.createServer();
    const startupPacket = new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.once("connection", (socket) => {
        socket.once("data", (chunk: Buffer) => {
          resolve(chunk.toString("utf8"));
          socket.destroy();
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const client = createClient(`postgresql://u:p@127.0.0.1:${port}/db`);
    try {
      // Connections are lazy — a query is what triggers the connect. It can
      // never succeed against a socket that speaks no Postgres, and it only
      // gives up after connect_timeout, so swallow its rejection rather than
      // waiting on it. The startup packet is already on the wire by then.
      client.unsafe("select 1").catch(() => {});

      const packet = await startupPacket;
      // postgres.js stringifies the boolean and drops any falsy value from the
      // packet entirely, so asserting on the wire bytes catches a
      // `false`/`undefined` regression that the options assertion above would
      // not.
      expect(packet).toContain(`default_transaction_read_only${NUL}true`);
      expect(packet).toContain(`statement_timeout${NUL}30000`);
    } finally {
      await catchError(client.end({ timeout: 0 }));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
