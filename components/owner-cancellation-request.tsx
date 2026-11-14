"use client";

import Link from "next/link";
import { FileClock, Search } from "lucide-react";
import { useRef, useState } from "react";
import type { RecoveryReport } from "../lib/recovery-inspection";
import { recordReviewedCancellation, recoverReviewedCancellation, type OwnerCancellationResult } from "../lib/owner-cancellation-request";
import { usePrivateInspection } from "./use-private-inspection";

const messages = {
  idle: "No cancellation request submitted here.", loading: "Checking request evidence...",
  ineligible: "Request recording is unavailable for the current stored job. Read recovery evidence again.",
  unauthenticated: "Sign in to access the cancellation request.", denied: "Current owner access or the bound claim is unavailable.",
  incompatible: "Cancellation request recording is not configured on this installation.",
  unknown: "Request not verified. It may already be stored. Check the recorded request before retrying."
};

export function OwnerCancellationRequest({ report }: { report: RecoveryReport }) {
  const [confirmed, setConfirmed] = useState(false);
  const submitted = useRef(false);
  const { view, inspect } = usePrivateInspection<OwnerCancellationResult>();
  const record = () => {
    if (!confirmed || submitted.current) return;
    submitted.current = true; setConfirmed(false);
    void inspect(signal => recordReviewedCancellation(report, signal));
  };
  return <section aria-label="Record cancellation request" className="space-y-3 border-t border-white/10 pt-5">
    <h2 className="text-base font-semibold">Cancellation request</h2>
    <p className="text-sm text-amber-200">Recording a request does not contact BigQuery, confirm cancellation or release reserved budget.</p>
    {!submitted.current && <label className="flex items-start gap-3 text-sm text-slate-200">
      <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}
        className="focus-ring mt-1 h-4 w-4 shrink-0 accent-sky-300" />
      <span>I request cancellation of the job shown above.</span>
    </label>}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={!confirmed || submitted.current || view.state === "loading"} onClick={record}
        className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-amber-300/60 px-3 py-2 text-sm text-amber-200 disabled:opacity-50">
        <FileClock size={16} aria-hidden="true" className="shrink-0" />Record request</button>
      {submitted.current && <button type="button" disabled={view.state === "loading"} onClick={() => {
        void inspect(signal => recoverReviewedCancellation(report, signal));
      }} className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-white/20 px-3 py-2 text-sm text-sky-200 disabled:opacity-50">
        <Search size={16} aria-hidden="true" className="shrink-0" />Check recorded request</button>}
    </div>
    <p role="status" className="text-sm text-slate-300">{view.state === "recorded" ? "Request recorded. Cancellation not confirmed." : messages[view.state]}</p>
    {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fjob-recovery" className="focus-ring text-sm text-sky-300 underline">Sign in</Link>}
    {view.state === "recorded" && <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {[["Original requester", view.report.requestedBy], ["Request recorded at", view.report.requestedAt]].map(([label, value]) =>
        <div key={label} className="min-w-0"><dt className="text-slate-400">{label}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}
    </dl>}
  </section>;
}
