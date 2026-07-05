import { describe, expect, it } from "vitest";
import {
  estimateDryRun,
  getPublicHealth,
  getPhase2Health,
  getPhase3Health,
  getPhase4Health,
  phase2FeatureFlags,
  releaseTracks
} from "../lib/phase2";

describe("phase 2 release controls", () => {
  it("keeps public health metadata minimal", () => {
    const health = getPublicHealth();

    expect(health).toEqual({
      ok: true,
      service: "odap-gateway"
    });
    expect("checks" in health).toBe(false);
    expect("deployment" in health).toBe(false);
  });

  it("blocks destructive SQL before execution", () => {
    const preview = estimateDryRun("DROP TABLE `analytics.orders`;");

    expect(preview.status).toBe("blocked");
    expect(preview.scannedBytes).toBe(0);
    expect(preview.gateLabel).toBe("Blocked by safety policy");
  });

  it("requires approval for unbounded read queries", () => {
    const preview = estimateDryRun("SELECT order_id FROM `analytics.orders`;");

    expect(preview.status).toBe("needs_approval");
    expect(preview.scannedBytes).toBeGreaterThan(1024 * 1024 * 1024);
  });

  it("approves bounded read queries for canary dry-run", () => {
    const preview = estimateDryRun(
      "SELECT order_id FROM analytics.orders WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);"
    );

    expect(preview.status).toBe("approved");
    expect(preview.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(preview.referencedTables).toEqual(["analytics.orders"]);
  });

  it("exposes the deployment model in health data", () => {
    const health = getPhase2Health();

    expect(health.phase).toBe("phase-2");
    expect(health.deployment.model).toContain("gray-release");
    expect(health.checks).toContain("admin-console");
  });

  it("adds phase 3 admin persistence checks to health data", () => {
    const health = getPhase3Health();

    expect(health.phase).toBe("phase-3");
    expect(health.checks).toContain("admin-rbac");
    expect(health.checks).toContain("d1-admin-store");
    expect(health.checks).toContain("bigquery-dry-run");
    expect(health.checks).toContain("query-run-audit");
    expect(health.checks).toContain("run-review-approval");
    expect(health.checks).toContain("admin-route-hardening");
    expect(health.checks).toContain("run-review-detail");
    expect(health.checks).toContain("bigquery-config-status");
  });

  it("adds phase 4 schema catalog checks to health data", () => {
    const health = getPhase4Health();

    expect(health.phase).toBe("phase-4");
    expect(health.checks).toContain("schema-catalog");
    expect(health.checks).toContain("schema-field-policy");
    expect(health.checks).toContain("workspace-schema-admin");
    expect(health.checks).toContain("schema-policy-dry-run");
    expect(health.checks).toContain("workspace-table-allowlist");
    expect(health.checks).toContain("pii-dry-run-block");
    expect(health.checks).toContain("bigquery-schema-import");
    expect(health.checks).toContain("information-schema-sync");
    expect(health.checks).toContain("admin-user-management");
    expect(health.checks).toContain("admin-settings-console");
  });

  it("ships canary and rollback controls as configured data", () => {
    expect(releaseTracks.some((track) => track.environment === "canary")).toBe(
      true
    );
    expect(
      phase2FeatureFlags.some((flag) => flag.id === "bigquery-run-gate")
    ).toBe(true);
  });
});
