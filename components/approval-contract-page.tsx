"use client";

import { FileCheck2 } from "lucide-react";
import { inspectApprovalContract } from "../lib/contract-inspection";
import { ControlObjectLookup } from "./control-object-lookup";

const lifecycle = { authorized: "Authorized", consumed: "Consumed", revoked: "Revoked" } as const;

export function ApprovalContractPage() {
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <FileCheck2 className="h-6 w-6 text-sky-400" aria-hidden="true" />Approval contract
    </h1>
    <ControlObjectLookup kind="Contract" load={inspectApprovalContract}>{contract => <>
      <dl className="grid gap-4 border-b border-white/10 pb-5 sm:grid-cols-3">
        <div><dt className="text-sm text-slate-400">Recorded lifecycle</dt><dd className="mt-1 text-xl font-semibold">{lifecycle[contract.state]}</dd></div>
        <div><dt className="text-sm text-slate-400">Expiry at lookup</dt><dd className="mt-1 text-xl font-semibold">{contract.expiredAtLookup ? "Expired" : "Not expired"}</dd></div>
        <div><dt className="text-sm text-slate-400">Execution eligibility</dt><dd className="mt-1 text-xl font-semibold text-amber-300">Not assessed</dd></div>
      </dl>
      <h2 className="mt-5 text-base font-semibold">Contract terms</h2>
      <dl className="mt-2 text-sm">{[
        ["Action",contract.actionType], ["Target",contract.target], ["Approval mode",contract.authorityMode],
        ["Semantic release",contract.semanticReleaseId], ["Policy revision",contract.policyRevision],
        ["Source revision",contract.sourceRevision], ["Action digest",contract.actionDigest],
        ["Expires at (UTC)",contract.expiresAt], ["Checked at (UTC)",contract.checkedAt]
      ].map(([label,value]) => <div key={label} className="grid min-w-0 gap-1 border-b border-white/10 py-2 sm:grid-cols-[12rem_1fr]">
        <dt className="text-slate-400">{label}</dt><dd className="min-w-0 break-all font-mono">{value}</dd></div>)}</dl>
    </>}</ControlObjectLookup>
  </section>;
}
