import { describe, expect, it } from "vitest";
import type { SchemaCatalogTable } from "../lib/admin-store";
import { evaluateSchemaCatalog } from "../lib/schema-policy";

const table=(id: string,workspace="demo",name="demo.orders",restricted=false): SchemaCatalogTable=>({
  id,workspace,name,description:"Synthetic identity fixture",rowCount:0,updatedAt:"fixture",
  fields:[{id:id+"-contact",name:"contact",type:"STRING",mode:"NULLABLE",description:"Synthetic contact",
    pii:restricted,queryable:!restricted,usedInExamples:false,updatedAt:"fixture"}]
});
const query="SELECT contact FROM demo.orders";

describe("unambiguous preview catalog identity",()=>{
  it.each([
    ["exact duplicate","demo","demo.orders"],
    ["quoted table","demo","`demo.orders`"],
    ["padded table","demo"," demo.orders "],
    ["workspace case","DEMO","demo.orders"],
    ["padded workspace"," demo ","demo.orders"],
    ["empty workspace fallback"," ","demo.orders"]
  ])("refuses %s regardless of record order",(_label,workspace,name)=>{
    const restricted=table("restricted","demo","demo.orders",true),permissive=table("permissive",workspace,name);
    for(const catalog of [[restricted,permissive],[permissive,restricted]]){
      const result=evaluateSchemaCatalog(query,"demo",catalog,"d1");
      expect(result.blocked).toBe(true);
      expect(result.reasons).toEqual(["demo.orders has ambiguous catalog identity in the demo workspace"]);
      expect(result.checks.every(check=>check.status==="warn")).toBe(true);
      expect(result).toMatchObject({workspace:"demo",source:"d1",referencedTables:["demo.orders"]});
    }
  });
  it("does not merge duplicate copies even when their policies agree",()=>{
    const first=table("same");
    expect(evaluateSchemaCatalog(query,"demo",[first,structuredClone(first)]).blocked).toBe(true);
  });
  it("refuses ambiguous identity even when the query has no field references",()=>{
    expect(evaluateSchemaCatalog("SELECT COUNT(*) FROM demo.orders","demo",[table("a"),table("b")]).blocked).toBe(true);
  });
  it("does not let unrelated workspace or table duplicates affect the selected identity",()=>{
    const catalog=[table("selected"),table("peer-a","peer"),table("peer-b","peer","demo.orders",true),
      table("unrelated-a","demo","demo.other"),table("unrelated-b","demo","demo.other",true)];
    const before=structuredClone(catalog);
    expect(evaluateSchemaCatalog(query,"demo",catalog).blocked).toBe(false);
    expect(catalog).toEqual(before);
  });
  it("retains restrictions for one unambiguous row",()=>{
    const result=evaluateSchemaCatalog(query,"demo",[table("only","demo","demo.orders",true)]);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain("demo.orders.contact is not queryable");
    expect(result.reasons).toContain("demo.orders.contact is marked PII");
  });
  it("preserves exact project-qualified identities and never infers suffix equivalence",()=>{
    const catalog=[table("a","demo","project-a.demo.orders"),table("b","demo","project-b.demo.orders",true)];
    expect(evaluateSchemaCatalog("SELECT contact FROM `project-a.demo.orders`","demo",catalog).blocked).toBe(false);
    expect(evaluateSchemaCatalog("SELECT contact FROM `project-b.demo.orders`","demo",catalog).blocked).toBe(true);
    expect(evaluateSchemaCatalog(query,"demo",catalog).blocked).toBe(true);
  });
});
