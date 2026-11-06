import { describe, expect, it, vi } from "vitest";
import { loadDocsFeedback, sendDocsFeedback } from "../lib/docs-feedback-client";
import worker from "../worker";

const signal = new AbortController().signal;
const item = {id:"stored",kind:"question",topic:"Docs",authorName:"Reader",message:"A stored question.",
  status:"approved",createdAt:"2026-11-06T00:00:00.000Z"};
const list = {ok:true,persisted:true,storageBinding:"DB",feedback:[item]};
const accepted = {ok:true,accepted:true,pendingReview:true,persisted:true,storageBinding:"DB",feedback:{...item,status:"pending"}};
const input = {kind:"question" as const,topic:"Docs",authorName:"Reader",authorEmail:"reader@example.test",
  message:item.message,company:""};
const reply = (body: unknown): typeof fetch => async () => Response.json(body);

describe("confirmed docs feedback responses",() => {
  it.each(["DB","ODAP_GATEWAY_DB"])("accepts only stored public content from %s",async storageBinding => {
    const send = vi.fn(reply({...list,storageBinding}));
    expect(await loadDocsFeedback(signal,send)).toEqual({state:"ready",feedback:[item]});
    expect(send).toHaveBeenCalledWith("/api/docs/feedback",{method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal});
    expect(await loadDocsFeedback(signal,reply({...list,feedback:[]}))).toEqual({state:"ready",feedback:[]});
    expect(await sendDocsFeedback(input,signal,reply({...accepted,storageBinding})))
      .toEqual({state:"confirmed",feedback:accepted.feedback});
  });

  it.each([201,400,401,403,404,405,500,503])("never accepts HTTP %i even with an apparent success body",async status => {
    expect(await loadDocsFeedback(signal,async () => Response.json(list,{status}))).toEqual({state:"unavailable"});
    expect(await sendDocsFeedback(input,signal,async () => Response.json(accepted,{status}))).toEqual({state:"unconfirmed"});
  });

  it.each([{},null,[],{...list,ok:false},{...list,ok:"true"},{...list,persisted:false},
    {...list,persisted:"true"},{...list,storageBinding:null},{...list,storageBinding:"unknown"},
    {...list,feedback:null},{...list,feedback:[item,item]},{...list,feedback:[accepted.feedback]}])(
    "refuses missing, unpersisted or non-public list content: %j",async body => {
      expect(await loadDocsFeedback(signal,reply(body))).toEqual({state:"unavailable"});
    });

  it.each([{id:""},{kind:"answer"},{topic:null},{authorName:[]},{message:42},{createdAt:undefined},
    {status:"released"},{answerText:{}},{answeredBy:null},{answeredAt:false}])(
    "rejects malformed public fields: %j",async patch => {
      expect(await loadDocsFeedback(signal,reply({...list,feedback:[{...item,...patch}]}))).toEqual({state:"unavailable"});
      expect(await sendDocsFeedback(input,signal,reply({...accepted,feedback:{...accepted.feedback,...patch}})))
        .toEqual({state:"unconfirmed"});
    });

  it.each([{},null,[],{...accepted,ok:false},{...accepted,persisted:false},{...accepted,accepted:false},
    {...accepted,pendingReview:false},{...accepted,storageBinding:null},{...accepted,feedback:null},
    {...accepted,feedback:item},{...accepted,feedback:{...accepted.feedback,answerText:"Not yet reviewed."}},
    {...accepted,feedback:{...accepted.feedback,answeredBy:"Someone"}},
    {...accepted,feedback:{...accepted.feedback,answeredAt:"now"}}])(
    "does not manufacture acceptance from an unconfirmed response: %j",async body => {
      expect(await sendDocsFeedback(input,signal,reply(body))).toEqual({state:"unconfirmed"});
    });

  it("does not retry, expose transport diagnostics or turn redirects/HTML into feedback",async () => {
    for (const send of [vi.fn(async () => {throw new TypeError("private network error");}),
      vi.fn(async () => new Response("<html>Login</html>")),
      vi.fn(async () => Object.defineProperty(Response.json(accepted),"redirected",{value:true}))]) {
      expect(await sendDocsFeedback(input,signal,send)).toEqual({state:"unconfirmed"});
      expect(send).toHaveBeenCalledTimes(1);
      expect(await loadDocsFeedback(signal,send)).toEqual({state:"unavailable"});
      expect(send).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps unexpected server fields and author contact out of public UI state",async () => {
    const result = await loadDocsFeedback(signal,reply({...list,feedback:[{...item,authorEmail:"private@example.test",secret:"private"}]}));
    expect(result).toEqual({state:"ready",feedback:[item]});
    expect(JSON.stringify(result)).not.toContain("private");
    const send = vi.fn(reply(accepted));
    await sendDocsFeedback(input,signal,send);
    expect(send).toHaveBeenCalledWith("/api/docs/feedback",{method:"POST",credentials:"same-origin",cache:"no-store",
      redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),signal});
  });

  it("does not reinterpret actual Worker no-storage and honeypot responses as success",async () => {
    const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No external requests allowed"));
    const inProcess: typeof fetch = (path,init) => worker.fetch(new Request(new URL(String(path),"https://gateway.test"),init),
      {ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}},{waitUntil:() => undefined});
    try {
      expect(await loadDocsFeedback(signal,inProcess)).toEqual({state:"unavailable"});
      expect(await sendDocsFeedback(input,signal,inProcess)).toEqual({state:"unconfirmed"});
      expect(await sendDocsFeedback({...input,company:"bot"},signal,inProcess)).toEqual({state:"unconfirmed"});
      expect(network).not.toHaveBeenCalled();
    } finally {network.mockRestore();}
  });
});
