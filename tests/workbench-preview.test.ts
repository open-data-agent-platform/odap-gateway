import { describe, expect, it, vi } from "vitest";
import { requestWorkbenchPreview } from "../lib/workbench-preview";
import worker from "../worker";

const signal = new AbortController().signal;
const input = { sql:"SELECT order_id FROM `demo.orders` WHERE order_date >= CURRENT_DATE();", workspace:"demo", queryType:"fixture" };
const live = {status:"approved",mode:"live",persisted:true,runId:"fixture-run",scannedBytes:128,estimatedCostUsd:0.01,
  expectedRuntimeMs:10,referencedTables:["demo.orders"],projectedColumns:1,checks:[{status:"pass",label:"Scope",detail:"Checked"}],
  jobReference:{projectId:"fixture-project",location:"US"},gateLabel:"untrusted-label"};
const read = (send: typeof fetch) => requestWorkbenchPreview(input,signal,send);
const reply = (body: unknown,status = 200) => read(async () => Response.json(body,{status}));

describe("workbench dry-run decisions", () => {
  it.each([[401,"sign_in"],[403,"denied"],[400,"invalid"],[503,"unavailable"]] as const)(
    "prioritizes HTTP %i over an apparent successful preview",async (status,state) => {
      expect(await reply({ok:true,preview:live,message:"private"},status)).toEqual({state});
    });
  it("never promotes missing, malformed or failed responses to a simulation",async () => {
    for (const body of [{ok:false,preview:live}, {ok:true}, {preview:live}, ...[
      {mode:"demo"}, {status:"paid"}, {mode:undefined}, {scannedBytes:-1}, {estimatedCostUsd:null}, {referencedTables:[2]},
      {checks:[{status:"pass",label:{}}]}, {persisted:"true"}, {runId:""}, {error:{code:"transport_failure"}}
    ].map(p => ({ok:true,preview:{...live,...p}}))]) {
      expect(await reply(body)).toEqual({state:"unavailable"});
    }
    expect(await read(async () => new Response("<html>Login</html>"))).toEqual({state:"unavailable"});
    expect(await read(async () => {throw new Error("private");})).toEqual({state:"unavailable"});
  });
  it("distinguishes successful previews, review requirements and failed jobs from a grant",async () => {
    const send = vi.fn(async () => Response.json({ok:true,preview:live}));
    const result = await read(send);
    expect(result).toMatchObject({state:"ready",preview:{mode:"live",status:"approved",auditId:"fixture-run",jobRef:"fixture-project / US"}});
    expect(JSON.stringify(result)).not.toContain("untrusted-label");
    expect(send).toHaveBeenCalledWith("/api/query/dry-run",expect.objectContaining({
      method:"POST",redirect:"error",cache:"no-store",credentials:"same-origin",signal,body:JSON.stringify(input)
    }));
    expect(await reply({ok:true,preview:{...live,status:"needs_approval",persisted:false}}))
      .toMatchObject({state:"ready",preview:{status:"needs_approval",auditId:null}});
    expect(await reply({ok:true,preview:{...live,status:"blocked",error:{code:"bigquery_request_failed"}}})).toEqual({state:"unavailable"});
  });
  it("handles actual Worker simulation, pre-warehouse policy denial and a sign-in failure",async () => {
    const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network allowed"));
    const inProcess = (production = false): typeof fetch => (path,init) => worker.fetch(
      new Request(new URL(String(path),"https://fixture.test"),init),{GATEWAY_MODE:production ? "production" : "demo",
        ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}},{waitUntil:() => undefined});
    try {
      expect(await read(inProcess())).toMatchObject({state:"ready",preview:{mode:"simulated",auditId:null}});
      expect(await requestWorkbenchPreview({...input,sql:"SELECT customer_id FROM `demo.orders` WHERE order_date >= CURRENT_DATE();"},
        signal,inProcess())).toEqual({state:"denied"});
      expect(await read(inProcess(true))).toEqual({state:"sign_in"});
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
