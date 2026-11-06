import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1Result } from "../lib/d1";
import { recordQueryDryRun } from "../lib/admin-store";
import { estimateDryRun } from "../lib/phase2";
import worker from "../worker";

const uuid = "12345678-1234-4234-8234-123456789abc";
const id = "run-20261106000000-12345678";
const input = {workspace:"fixture",queryType:"Local preview",sql:"SELECT 1",preview:estimateDryRun("SELECT 1")};
const confirmed = (): D1Result[] => [
  {success:true,results:[{id}]}, {success:true,results:[{id}]},
  {success:true,results:[{id:uuid}]}, {success:true,results:[{confirmed:1}]}
];
function fixture(result: unknown = confirmed()) {
  const run = vi.fn(async () => ({success:true}));
  const prepare = vi.fn(() => {
    const statement = {bind:() => statement,run,all:async () => ({success:true,results:[]}),first:async () => null};
    return statement;
  });
  const batch = vi.fn(async () => result as D1Result[]);
  return {db:{prepare,batch} as D1Database,prepare,run,batch};
}

describe("dry-run history acknowledgment boundary",() => {
  beforeEach(() => {
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z"));
    vi.spyOn(crypto,"randomUUID").mockReturnValue(uuid);
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

  it.each([undefined,null,{},[],[confirmed()[0]], [...confirmed(),confirmed()[0]]])(
    "refuses an incomplete batch envelope: %j",async value => {
      const primary = fixture(), fallback = fixture();
      primary.batch.mockResolvedValue(value as D1Result[]);
      await expect(recordQueryDryRun({ODAP_GATEWAY_DB:primary.db,DB:fallback.db},input))
        .rejects.toThrow("Dry-run history transaction not confirmed");
      expect(primary.batch).toHaveBeenCalledTimes(1);
      expect(fallback.prepare).not.toHaveBeenCalled();
    });

  describe.each([0,1,2,3])("batch result %i",index => {
    it.each([undefined,null,{}, {success:false,results:[]}, {results:[]}, {success:true},
      {success:true,results:null}, {success:true,results:{}}, {success:true,results:[]},
      {success:true,results:[{},{}]}, {success:"true",results:[{}]}])(
      "rejects an unconfirmed or malformed statement: %j",async value => {
        const results = confirmed();
        results[index] = value as D1Result;
        const {db,batch,run} = fixture(results);
        await expect(recordQueryDryRun({DB:db},input)).rejects.toThrow("Dry-run history transaction not confirmed");
        expect(batch).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(8);
      });
    it("rejects substituted returned identity or confirmation",async () => {
      const results = confirmed();
      results[index].results = [index === 3 ? {confirmed:0} : {id:"other"}];
      await expect(recordQueryDryRun({DB:fixture(results).db},input)).rejects.toThrow("Dry-run history transaction not confirmed");
    });
  });

  it("uses one batch after initialization and only accepts matching confirmations",async () => {
    const {db,batch,run} = fixture();
    expect(await recordQueryDryRun({ODAP_GATEWAY_DB:db},input)).toEqual({id,persisted:true,storageBinding:"ODAP_GATEWAY_DB"});
    expect(batch).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(8);
  });

  it("propagates uncertain transaction failure without falling back or retrying",async () => {
    const primary = fixture(), fallback = fixture(), failure = new Error("Synthetic uncertain commit");
    primary.batch.mockRejectedValue(failure);
    await expect(recordQueryDryRun({ODAP_GATEWAY_DB:primary.db,DB:fallback.db},input)).rejects.toBe(failure);
    expect(primary.batch).toHaveBeenCalledTimes(1);
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it.each([false,true])("Worker reports only a confirmed history result, confirmed=%s",async valid => {
    const {db} = fixture(valid ? confirmed() : [{success:false,error:"private-history-diagnostic"}]);
    vi.spyOn(console,"error").mockImplementation(() => {});
    const response = await worker.fetch(new Request("https://gateway.test/api/query/dry-run",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)
    }),{DB:db,GATEWAY_MODE:"demo",ASSETS:{fetch:async () => {throw new Error("Unexpected assets");}}},
    {waitUntil:() => {throw new Error("Unexpected background operation");}});
    const body = await response.json();
    if (valid) {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ok:true,runId:id,persisted:true,preview:{persisted:true,runId:id}});
    } else {
      expect(response.status).toBe(500);
      expect(body).toMatchObject({ok:false,code:"internal_error"});
      expect(body).not.toHaveProperty("persisted");
      expect(body).not.toHaveProperty("preview");
      expect(JSON.stringify(body)).not.toContain("private-history-diagnostic");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
