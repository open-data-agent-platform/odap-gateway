import { describe, expect, it } from "vitest";
import {
  getAdminState,
  getAdminDb,
  recordQueryDryRun,
  updateAdminUserRole,
  updateSchemaFieldPolicy,
  updateRunReviewStatus,
  updateFeatureRollout
} from "../lib/admin-store";
import { estimateDryRun } from "../lib/phase2";

describe("phase 3 admin store", () => {
  it("returns seed preview state when D1 is not bound", async () => {
    const state = await getAdminState({});

    expect(state.phase).toBe("phase-4");
    expect(state.storage.configured).toBe(false);
    expect(state.storage.mode).toBe("seed");
    expect(state.bigQuery.configured).toBe(false);
    expect(state.bigQuery.mode).toBe("simulated");
    expect(state.auth.configured).toBe(false);
    expect(state.users).toEqual([]);
    expect(state.featureFlags.some((flag) => flag.id === "bigquery-run-gate"))
      .toBe(true);
    expect(state.schemaCatalog.some((table) => table.name === "demo.orders"))
      .toBe(true);
  });

  it("exposes configured auth state", async () => {
    const state = await getAdminState({
      AUTH_COOKIE_SECRET: "test-cookie-signing-value",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-oauth-placeholder",
      ADMIN_EMAILS: "owner@example.com, ops@example.com"
    });

    expect(state.auth).toMatchObject({
      configured: true,
      googleConfigured: true,
      githubConfigured: false,
      cookieSecretConfigured: true,
      adminEmails: ["owner@example.com", "ops@example.com"]
    });
  });

  it("exposes live BigQuery dry-run configuration only in an explicit mode", async () => {
    const state = await getAdminState({
      GATEWAY_MODE: "demo",
      BIGQUERY_PROJECT_ID: "demo-project",
      BIGQUERY_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      BIGQUERY_PRIVATE_KEY: "test-pkcs8-placeholder",
      BIGQUERY_LOCATION: "US",
      BIGQUERY_MAX_BYTES_BILLED: "1048576"
    });

    expect(state.bigQuery).toMatchObject({
      configured: true,
      mode: "live",
      projectId: "demo-project",
      location: "US",
      maxBytesBilled: 1048576
    });
  });

  it("reports a blocked preview transport when credentials exist but no gateway mode is set", async () => {
    const state = await getAdminState({ BIGQUERY_PROJECT_ID:"fixture-project",
      BIGQUERY_CLIENT_EMAIL:"fixture@example.test", BIGQUERY_PRIVATE_KEY:"unused-fixture" });
    expect(state.bigQuery).toMatchObject({configured:true,mode:"blocked"});
  });

  it("detects the preferred D1 binding name", () => {
    const db = {
      prepare: () => {
        throw new Error("not used");
      }
    };

    expect(getAdminDb({ ODAP_GATEWAY_DB: db })?.binding).toBe("ODAP_GATEWAY_DB");
  });

  it("rejects rollout mutations without D1 persistence", async () => {
    const result = await updateFeatureRollout(
      {},
      "bigquery-run-gate",
      25,
      { provider: "google", providerId: "owner", email: "owner@example.com" }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "storage_not_configured"
    });
  });

  it("returns an unpersisted query run id when D1 is not bound", async () => {
    const result = await recordQueryDryRun(
      {},
      {
        workspace: "demo",
        queryType: "Revenue rollup",
        sql: "SELECT order_id FROM `demo.orders`;",
        preview: estimateDryRun("SELECT order_id FROM `demo.orders`;")
      }
    );

    expect(result.id).toMatch(/^run-/);
    expect(result.persisted).toBe(false);
    expect(result.storageBinding).toBeNull();
  });

  it("rejects run review approvals without D1 persistence", async () => {
    const result = await updateRunReviewStatus(
      {},
      "run-1026",
      "approved",
      { provider: "google", providerId: "owner", email: "owner@example.com" }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "storage_not_configured"
    });
  });

  it("rejects schema policy mutations without D1 persistence", async () => {
    const result = await updateSchemaFieldPolicy(
      {},
      "table-demo-orders-customer-id",
      {
        queryable: true
      },
      { provider: "google", providerId: "owner", email: "owner@example.com" }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "storage_not_configured"
    });
  });

  it("rejects user role mutations without D1 persistence", async () => {
    const result = await updateAdminUserRole(
      {},
      "google:123",
      "admin",
      { provider: "google", providerId: "owner", email: "owner@example.com" }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "storage_not_configured"
    });
  });
});
