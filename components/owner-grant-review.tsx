"use client";

import Link from "next/link";
import { ListChecks } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { checkOwnerReview, validReviewIds, type ReviewIds } from "../lib/owner-grant-review";
import type { MetricAction } from "../lib/review-contract-request";
import { usePrivateInspection } from "./use-private-inspection";
import { OwnerGrantDecision } from "./owner-grant-decision";

const labels = { requesterId: "Requester ID", requestId: "Request ID", requestedAgentId: "Requested agent ID", policyRevision: "Policy revision" };
const messages = {
  idle: "", loading: "Checking request and policy...", matched: "Request and policy matched at review time. Checking a match does not grant access.",
  noMatch: "No current match for this request, action and policy.", signedOut: "Sign in to review this request.",
  denied: "You do not have access to review this request.", invalid: "Check the request identifiers.",
  tooLarge: "The review exceeds 16 KiB.", unavailable: "The match could not be verified. Try again."
};
export function OwnerGrantReview({ tenantId, releaseId, action }: { tenantId: string; releaseId: string; action: MetricAction | null }) {
  const [ids, setIds] = useState<ReviewIds>({ requesterId: "", requestId: "", requestedAgentId: "", policyRevision: "" });
  const { view, clear, inspect } = usePrivateInspection<Awaited<ReturnType<typeof checkOwnerReview>>>();
  // Parameters live in the sibling metric form. Invalidate before showing a new action.
  useLayoutEffect(clear, [action, tenantId, releaseId, clear]);
  const valid = !!action && validReviewIds(ids);
  return <><form aria-label="Owner grant review" className="space-y-3 border-t border-white/10 pt-5" onSubmit={e => {
    e.preventDefault();
    if (valid && action && view.state !== "loading") void inspect(signal => checkOwnerReview(tenantId, releaseId, ids, action, signal));
  }}>
    <h3 className="text-sm font-semibold">Owner grant review</h3>
    <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(labels) as (keyof ReviewIds)[]).map(key =>
      <label key={key} className="min-w-0 text-sm text-slate-300">{labels[key]}
        <input className="focus-ring mt-1 block w-full min-w-0 rounded-md border border-white/15 bg-[#10151d] px-3 py-2 font-mono text-sm"
          autoComplete="off" spellCheck={false} maxLength={key === "requesterId" || key === "policyRevision" ? 256 : 128}
          value={ids[key]} onChange={e => { clear(); setIds({ ...ids, [key]: e.target.value }); }} />
      </label>)}</div>
    <button type="submit" disabled={!valid || view.state === "loading"} className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-sky-300/50 px-4 py-2 text-sm font-semibold text-sky-200 disabled:opacity-50">
      <ListChecks size={16} aria-hidden="true" />Check request match</button>
    <p role="status" className="text-sm text-slate-200">{messages[view.state]}
      {view.state === "signedOut" && <Link href="/login?returnTo=%2Fsemantic-review" className="ml-2 text-sky-300 underline">Sign in</Link>}</p>
  </form>
    {view.state === "matched" && <OwnerGrantDecision match={view.match} close={clear} />}
  </>;
}
