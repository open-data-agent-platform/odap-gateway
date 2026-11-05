import { afterEach, describe, expect, it, vi } from "vitest";
import * as auth from "../lib/auth-request";
import { authorizeControlRequest, readControlObject, persistControlObject } from "../lib/control-storage";
import { onRequestGet } from "../functions/api/control/[tenant]/[kind]/[id]";
import type { D1Database } from "../lib/d1";
import { signAuthPayload, SESSION_COOKIE } from "../lib/auth";

function database(rows: unknown[]) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db: D1Database = { prepare(sql) {
    const entry = { sql, values: [] as unknown[] }; queries.push(entry);
    return { bind(...values) { entry.values = values; return this; },
      async first<T>() { return (rows.shift() ?? null) as T | null; },
      async all<T>() { return { success: true, results: [] as T[] }; },
      async run() { return { success: true, meta: { changes: 0 } }; } };
  } };
  return { db, queries };
}
const request = new Request("https://gateway.test/api/control/t1/release/r1");
const session = { provider: "google" as const, providerId: "subject", email: "demo@example.test", name: "Demo", expiresAt: Date.now() + 60000 };
afterEach(() => vi.restoreAllMocks());

describe("tenant control persistence and authorization", () => {
  it("accepts a genuine signed session and uses stored membership", async () => {
    const secret = "synthetic-control-test-secret-only";
    const token = await signAuthPayload(session, secret);
    const { db } = database([{ role: "reader" }]);
    const signedRequest = new Request(request.url, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    expect(await authorizeControlRequest(signedRequest, { DB: db, AUTH_COOKIE_SECRET: secret }, "t1")).toMatchObject({
      ok: true, access: { tenantId: "t1", principalId: "google:subject" }
    });
    expect(await authorizeControlRequest(signedRequest, { DB: db, AUTH_COOKIE_SECRET: "wrong-secret" }, "t1")).toMatchObject({ status: 401 });
  });
  it("rejects unauthenticated requests without touching storage", async () => {
    vi.spyOn(auth, "getSessionFromRequest").mockResolvedValue(null);
    const { db, queries } = database([]);
    const result = await authorizeControlRequest(request, { DB: db }, "t1");
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(queries).toHaveLength(0);
  });
  it("derives provider identity server-side and denies absent/revoked membership", async () => {
    vi.spyOn(auth, "getSessionFromRequest").mockResolvedValue(session);
    const { db, queries } = database([null]);
    expect(await authorizeControlRequest(request, { DB: db }, "t2")).toMatchObject({ status: 403 });
    expect(queries[0].values).toEqual(["t2", "google:subject"]);
    expect(queries[0].sql).toContain("active = 1");
  });
  it("scopes object lookup and rechecks membership in the same statement", async () => {
    const { db, queries } = database([null]);
    expect(await readControlObject({ db, tenantId: "t1", principalId: "google:subject" }, "release", "r1")).toBeNull();
    expect(queries[0].values).toEqual(["t1", "r1", "google:subject"]);
    expect(queries[0].sql).toContain("EXISTS");
  });
  it("rejects mismatched tenants before SQL and refuses writes after role withdrawal", async () => {
    const { db, queries } = database([]);
    const access = { db, tenantId: "t1", principalId: "google:subject" };
    const release = { schemaVersion: "0.1", id: "r1", tenantId: "t2", owner: "finance", definitionDigest: "d", sourceRevision: "s", state: "released" };
    await expect(persistControlObject(access, "release", release)).rejects.toThrow();
    expect(queries).toHaveLength(0);
    await expect(persistControlObject(access, "release", { ...release, tenantId: "t1" })).rejects.toThrow("Control write denied");
    expect(queries[0].sql).toContain("role = 'owner'");
  });
  it("returns unavailable rather than seed data when membership storage fails", async () => {
    vi.spyOn(auth, "getSessionFromRequest").mockResolvedValue(session);
    const db = { prepare() { throw new Error("missing migration"); } };
    const response = await onRequestGet({ request, env: { DB: db }, params: { tenant: "t1", kind: "release", id: "r1" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
