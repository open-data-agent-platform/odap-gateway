import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { createPostgresGateway } from "../integrations/postgresql/gateway";
import { openPostgresSqliteControl } from "../integrations/postgresql/sqlite-control";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { pgAction, pgRun, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { postgresDenialCases } from "./fixtures/postgresql-denial-cases";

let directory: string, store: ReturnType<typeof openPostgresSqliteControl>;
describe("PostgreSQL pre-approval denial on native SQLite", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-pg-denial-"));
    const file = join(directory, "ledger.db"); initializePostgresLocalFixture(file);
    store = openPostgresSqliteControl(file); await seedPostgresControl(store.db);
  });
  afterEach(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  postgresDenialCases(() => store.db);
  it.each([false, true])("keeps missing and retired refusals indistinguishable at the transport (MCP=%s)", async mcp => {
    await publishPostgresFixture(store.db);
    await pgRun(store.db, "UPDATE postgresql_source_heads SET active=0 WHERE tenant_id='tenant-a'");
    const secret = "synthetic-denial-only", origin = "https://gateway.test";
    const resolve = vi.fn(async () => { throw new Error("No provider access allowed"); });
    const gateway = createPostgresGateway({ origin, env: { DB: store.db, AUTH_COOKIE_SECRET: secret }, resolve });
    const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
      email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
    const call = async (releaseId: string) => {
      const args = { requestId: "new-request", releaseId, action: pgAction };
      const response = await gateway(new Request(`${origin}/postgresql/tenant-a/${mcp ? "mcp" : "request"}`, { method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(mcp ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "postgresql_request", arguments: args } } : args) }));
      expect(response.status).toBe(mcp ? 200 : 409); return response.json();
    };
    const missing = await call("missing"), retired = await call("release");
    expect(missing).toEqual(retired); expect(mcp ? missing.result.isError : missing.ok).toBe(mcp);
    expect(await store.db.prepare("SELECT count(*) AS n FROM missing_release_denials").first("n")).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
