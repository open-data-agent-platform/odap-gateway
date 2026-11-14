import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onRequestGet } from "../functions/api/control/[tenant]/dispatch-stops/[id]";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { dispatchStopReadCases } from "./fixtures/dispatch-stop-read-cases";
import { recoveryCookie, recoveryEnv } from "./fixtures/delegated-recovery-request-cases";

let directory: string, file: string, template: string;
const db = jobDatabase(() => file);
const members = () => jobSqlite(file,"run","INSERT INTO control_memberships VALUES('t','google:operator','owner',1),('t','google:owner','owner',1),('t','google:reader','reader',1)");
const call = async () => onRequestGet({ request: new Request("https://gateway.test/api/control/t/dispatch-stops/i",
  { headers: { Cookie: await recoveryCookie() } }), env: recoveryEnv(db), params: { tenant: "t", id: "i" } });

describe("stored dispatch stop reads on SQLite", { timeout: 30000 }, () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(),"odap-stop-read-")); file = template = join(directory,"template.db");
    await jobSqlite(file,"setup"); await members();
  });
  beforeEach(async () => { file = join(directory,crypto.randomUUID()+".db"); await copyFile(template,file); });
  afterAll(async () => { if (directory) await rm(directory,{ recursive: true,force: true }); });
  dispatchStopReadCases(() => db);
  it("reads initialized schema 0032 without changing any database bytes", async () => {
    file = join(directory,crypto.randomUUID()+".db"); await jobSqlite(file,"setup-v32"); await members();
    const before = await readFile(file), r = await call(); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ dispatchStop: { state: "not-stopped" } }); expect(await readFile(file)).toEqual(before);
  });
  it("refuses unsupported legacy schema without changing any database bytes", async () => {
    file = join(directory,crypto.randomUUID()+".db"); await jobSqlite(file,"setup-v10"); await members();
    const before = await readFile(file), r = await call(); expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false,code: "control_storage_unavailable" }); expect(await readFile(file)).toEqual(before);
  });
  it.each([false,true])("preserves historical stop attribution and claim precedence=%s", async claimed => {
    file = join(directory,crypto.randomUUID()+".db"); await jobSqlite(file,"setup-v10"); await members();
    if (claimed) {
      const { prepareIntentJob } = await import("../lib/bigquery-job-storage");
      await prepareIntentJob({ db,tenantId: "t",principalId: "google:operator" },"i",{ BIGQUERY_PROJECT_ID: "fixture-project",BIGQUERY_LOCATION: "US" });
      await jobSqlite(file,"run","INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','google:operator',128)");
    }
    await jobSqlite(file,"run","INSERT INTO dispatch_stopped_intents VALUES('t','i','legacy')");
    await jobSqlite(file,"apply-pre-dispatch-stop"); const before = await readFile(file), r = await call(); expect(r.status).toBe(200);
    const body = await r.json(); expect(body.dispatchStop.state).toBe(claimed ? "already-claimed" : "legacy-stop");
    expect(body.dispatchStop).not.toHaveProperty("stoppedBy"); expect(body.dispatchStop).not.toHaveProperty("stoppedAt");
    expect(await readFile(file)).toEqual(before);
  });
});
