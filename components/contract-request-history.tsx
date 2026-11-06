"use client";

import { FileClock } from "lucide-react";
import { Fragment } from "react";
import { inspectOwnProposal } from "../lib/request-inspection";
import { ControlObjectLookup } from "./control-object-lookup";
import { RequesterDelegationConsent } from "./requester-delegation-consent";
import { RequesterDelegationHistory } from "./requester-delegation-history";

export function ContractRequestHistory() {
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <FileClock className="h-6 w-6 text-sky-400" aria-hidden="true" />My contract request
    </h1>
    <ControlObjectLookup kind="Request" load={inspectOwnProposal}>{r => {
      const scope = r.grantReference && { tenantId: r.tenantId, requestId: r.id, grantId: r.grantReference.grantId,
        agentId: r.requestedAgentId, releaseId: r.releaseId, actionDigest: r.actionDigest, expiresAt: r.grantReference.expiresAt };
      return <>
      <h2 className="text-base font-semibold">Recorded proposal</h2>
      <p className="mt-2 text-sm text-slate-300">This record confirms submission only. It does not authorize execution.</p>
      <dl className="mt-3 text-sm">{[["Recorded at (UTC)", r.requestedAt], ["Semantic release", r.releaseId],
        ["Requested agent", r.requestedAgentId], ["Action digest", r.actionDigest]].map(([label, value]) =>
        <div key={label} className="grid min-w-0 gap-1 border-b border-white/10 py-2 sm:grid-cols-[12rem_1fr]">
          <dt className="text-slate-400">{label}</dt><dd className="min-w-0 break-all font-mono">{value}</dd>
        </div>)}</dl>
      <h3 className="mt-6 text-base font-semibold">Historical owner grant</h3>
      {scope && r.grantReference ? <Fragment key={scope.tenantId + ":" + scope.grantId}>
        <dl className="mt-2 grid gap-2 text-sm">{[["Grant ID", r.grantReference.grantId], ["Recorded at (UTC)", r.grantReference.grantedAt],
          ["Original expiry (UTC)", r.grantReference.expiresAt]].map(([label, value]) =>
          <div key={label} className="grid min-w-0 gap-1 sm:grid-cols-[12rem_1fr]"><dt className="text-slate-400">{label}</dt>
            <dd className="min-w-0 break-all font-mono">{value}</dd></div>)}</dl>
        <p className="mt-2 text-sm text-slate-300">Historical record only. Current eligibility has not been checked.</p>
        <RequesterDelegationHistory scope={scope}>
          <RequesterDelegationConsent scope={scope} />
        </RequesterDelegationHistory>
      </Fragment> : <p className="mt-2 text-sm text-slate-300">{r.grantReference === null ?
        "No owner grant was recorded at lookup time." : "Grant history is unavailable."}</p>}
    </>; }}</ControlObjectLookup>
  </section>;
}
