import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  environment: "node", include: ["integrations/postgresql/*.integration.ts"],
  pool: "forks", maxWorkers: 1, testTimeout: 15000, hookTimeout: 30000,
  reporters: ["default", "json"], outputFile: { json: "postgresql-results.json" },
} });
