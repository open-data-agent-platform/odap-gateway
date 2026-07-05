import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasBigQueryCredentials,
  normalizeBigQueryPrivateKey,
  runBigQueryDryRun,
  runBigQueryQuery
} from "../lib/bigquery";

const boundedSql =
  "SELECT order_id FROM `analytics.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);";

describe("bigquery dry-run client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an explicit simulated result when credentials are missing", async () => {
    const preview = await runBigQueryDryRun(boundedSql, {});

    expect(preview.mode).toBe("simulated");
    expect(preview.configured).toBe(false);
    expect(preview.error?.code).toBe("bigquery_not_configured");
    expect(preview.referencedTables).toEqual(["analytics.orders"]);
  });

  it("supports forced simulated mode even when credentials exist", async () => {
    const env = {
      BIGQUERY_PROJECT_ID: "demo-project",
      BIGQUERY_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
      BIGQUERY_PRIVATE_KEY: "not-used-in-forced-simulated-mode",
      BIGQUERY_DRY_RUN_MODE: "simulated"
    } as const;
    const preview = await runBigQueryDryRun(boundedSql, env);

    expect(hasBigQueryCredentials(env)).toBe(true);
    expect(preview.mode).toBe("simulated");
    expect(preview.configured).toBe(true);
    expect(preview.error?.code).toBe("bigquery_simulated_mode");
  });

  it("blocks destructive SQL before any BigQuery network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const preview = await runBigQueryDryRun("DROP TABLE `analytics.orders`;", {
      BIGQUERY_PROJECT_ID: "demo-project",
      BIGQUERY_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
      BIGQUERY_PRIVATE_KEY: "not-used-for-blocked-preflight"
    });

    expect(preview.status).toBe("blocked");
    expect(preview.error?.code).toBe("blocked_before_bigquery");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes escaped service-account private key newlines", () => {
    expect(
      normalizeBigQueryPrivateKey(
        "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"
      )
    ).toContain(
      "\nabc\n"
    );
  });

  it("requires credentials for metadata queries", async () => {
    const result = await runBigQueryQuery("SELECT 1", {});

    expect(result).toMatchObject({
      ok: false,
      code: "bigquery_not_configured"
    });
  });
});
