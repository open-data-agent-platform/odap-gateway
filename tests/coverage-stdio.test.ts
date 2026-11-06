import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string, entry: string;
const exec = promisify(execFile);
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });
const init = (version = "2025-06-18") => rpc(1, "initialize", { protocolVersion: version, capabilities: {},
  clientInfo: { name: "local-pipe-client", version: "1" } });
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = (id: number, tenantId = "t") => rpc(id, "tools/call", { name: "odap_evidence_coverage",
  arguments: { tenantId }, _meta: { principalId: "google:alternate", role: "owner" } });
const line = (value: unknown) => JSON.stringify(value) + "\n";

async function withClient(check: (client: ReturnType<typeof connect>) => Promise<void>) {
  const client = connect();
  const timeout = setTimeout(() => client.child.kill(), 12_000);
  try { await check(client); }
  finally {
    clearTimeout(timeout);
    if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill();
    await client.closed;
  }
}
function connect() {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const k of ["PATH","SystemRoot","TEMP","TMP","ODAP_TEST_PYTHON"]) if (process.env[k]) env[k] = process.env[k];
  const child = spawn(process.execPath, [entry,file], { stdio: "pipe", windowsHide: true, env });
  const closed = new Promise<number | null>((resolve,reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let diagnostics = "";
  child.stderr.on("data", b => { diagnostics += b.toString(); });
  child.stdin.on("error", () => {}); // write() reports a closed pipe to its caller.
  const write = (data: string | Buffer) => new Promise<void>((resolve,reject) =>
    child.stdin.write(data, err => err ? reject(err) : resolve()));
  const read = async () => {
    const next = await output.next();
    if (next.done) throw new Error("Pipe closed before reply");
    return JSON.parse(next.value);
  };
  const finish = async (expected = 0) => {
    child.stdin.end();
    expect(await closed).toBe(expected);
    expect((await output.next()).done).toBe(true);
    return diagnostics;
  };
  return { child, closed, write, read, finish };
}

describe("local coverage MCP over stdio", { timeout: 20_000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-coverage-pipe-"));
    file = join(dir,"fixture.db");
    entry = join(dir,"build/tests/fixtures/coverage-stdio-host.js");
    await exec(process.execPath,[require.resolve("typescript/bin/tsc"),"-p","tests/fixtures/tsconfig.coverage-stdio.json",
      "--outDir",join(dir,"build")]);
    await jobSqlite(file,"setup");
    await jobSqlite(file,"run","INSERT INTO control_memberships VALUES('t','google:pipe-owner','owner',1)");
  }, 40_000);
  afterAll(async () => { if (dir) await rm(dir,{ recursive:true,force:true }); });

  it("negotiates, lists and reads, then rejects a revoked owner on the same connection", async () => {
    await withClient(async c => {
      await c.write(line(initialized) + line(call(0)) + line(init()) + line(call(2)));
      expect(await c.read()).toMatchObject({ id:0,error:{ code:-32002 } });
      expect(await c.read()).toMatchObject({ id:1,result:{ protocolVersion:"2025-06-18",capabilities:{ tools:{} } } });
      expect(await c.read()).toMatchObject({ id:2,error:{ code:-32002 } });
      await c.write(line(initialized) + line(rpc(3,"tools/list")) + line(call(4)) + line(call(5,"peer")));
      expect((await c.read()).result.tools.map((t: { name: string }) => t.name)).toEqual(["odap_evidence_coverage"]);
      const success = await c.read();
      expect(success).toMatchObject({ id:4,result:{ isError:false } });
      expect(JSON.parse(success.result.content[0].text)).toMatchObject({ ok:true,coverage:{ admitted:1,missingEvidence:1 } });
      const denied = await c.read();
      expect(denied).toMatchObject({ id:5,result:{ isError:true } });
      expect(JSON.parse(denied.result.content[0].text)).toEqual({ ok:false,code:"tenant_access_denied" });
      await jobSqlite(file,"run","UPDATE control_memberships SET active=0 WHERE principal_id='google:pipe-owner'");
      await c.write(line(call(6)) + line({ ...init(), id: 7 }));
      const revoked = await c.read();
      expect(revoked).toMatchObject({ id:6,result:{ isError:true } });
      expect(JSON.parse(revoked.result.content[0].text)).toEqual({ ok:false,code:"tenant_access_denied" });
      expect(await c.read()).toMatchObject({ id:7,error:{ code:-32600 } });
      expect(await c.finish()).toBe("");
      await expect(c.write(line(call(7)))).rejects.toThrow();
    });
    await withClient(async c => {
      await c.write(line(call(8)));
      expect(await c.read()).toMatchObject({ id:8,error:{ code:-32002 } });
      expect(await c.finish()).toBe("");
    });
  });

  it("offers the supported version, ignores premature notifications and drops partial frames at EOF", async () => {
    await withClient(async c => {
      await c.write(line(rpc(11,"initialize",{})) + line(initialized) + line(init("unsupported")));
      expect(await c.read()).toMatchObject({ id:11,error:{ code:-32602 } });
      expect(await c.read()).toMatchObject({ id:1,result:{ protocolVersion:"2025-06-18" } });
      await c.write(line(call(12)) + JSON.stringify(initialized)); // Missing newline cannot complete the handshake.
      expect(await c.read()).toMatchObject({ id:12,error:{ code:-32002 } });
      expect(await c.finish()).toBe("");
    });
  });

  it("handles fragmented UTF-8, CRLF and malformed frames without echoing private bytes", async () => {
    await withClient(async c => {
      await c.write(Buffer.from([0xff,10]));
      expect(await c.read()).toEqual({ jsonrpc:"2.0",id:null,error:{ code:-32700,message:"Parse error" } });
      const bytes = Buffer.from(JSON.stringify({ jsonrpc:"2.0",id:"test-\u00e9",method:"ping" })+"\r\n");
      const split = bytes.indexOf(0xc3) + 1;
      await c.write(bytes.subarray(0,split));
      await c.write(bytes.subarray(split));
      expect(await c.read()).toEqual({ jsonrpc:"2.0",id:"test-\u00e9",result:{} });
      await c.write(line(initialized) + line(rpc(10,"ping")).trimEnd());
      expect(await c.finish()).toBe("");
    });
  });
  it("accepts exactly 64 KiB and closes an oversized frame without processing its tail", async () => {
    await withClient(async c => {
      await c.write(JSON.stringify(rpc(9,"ping")).padEnd(64 * 1024) + "\n");
      expect(await c.read()).toEqual({ jsonrpc:"2.0",id:9,result:{} });
      await c.write("x".repeat(64 * 1024));
      await c.write("x\n" + line(init()));
      expect(await c.finish(1)).toBe("Local fixture session terminated\n");
    });
  });
});
