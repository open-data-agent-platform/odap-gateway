import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe } from "vitest";
import { openPostgresSqliteControl } from "../integrations/postgresql/sqlite-control";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { seedPostgresControl } from "./fixtures/postgresql-control";
import { postgresEvidenceCases } from "./fixtures/postgresql-evidence-cases";

let directory: string, store: ReturnType<typeof openPostgresSqliteControl>;
describe("PostgreSQL evidence on native Node SQLite", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-pg-evidence-"));
    const file = join(directory, "ledger.db"); initializePostgresLocalFixture(file);
    store = openPostgresSqliteControl(file); await seedPostgresControl(store.db);
  });
  afterEach(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  postgresEvidenceCases(() => store.db);
});
