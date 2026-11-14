"use client";

import Link from "next/link";
import { Search, ShieldOff } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { inspectDispatchStop, recordReviewedDispatchStop, type DispatchStopAction, type DispatchStopInspection, type DispatchStopReport } from "../lib/dispatch-stop-inspection";
import { usePrivateInspection } from "./use-private-inspection";

const messages = {
  idle: "", loading: "Checking stored stop...", invalid: "Enter tenant and intent IDs using letters, numbers, hyphens or underscores.",
  unauthenticated: "Sign in to inspect the stop record.", denied: "Intent unavailable or current tenant owner access is missing.",
  unavailable: "Stop evidence is unavailable. No stop status verified.",
  ineligible: "Stored state changed. Read the stop record again before deciding.",
  unknown: "Stop not verified. It may already be stored. Check the stop record before retrying."
};
const states = { "not-stopped": "No stop recorded", stopped: "Stop recorded", "legacy-stop": "Historical stop without attribution",
  "already-claimed": "Handoff already claimed", "already-settled": "Settlement already recorded" };

function StopReview({ reviewed, hide }: { reviewed: DispatchStopReport; hide: () => void }) {
  const [confirmed, setConfirmed] = useState(false), submitted = useRef(false);
  const { view, inspect } = usePrivateInspection<DispatchStopAction>();
  const report = view.state === "idle" ? reviewed : view.state === "ready" ? view.report : null;
  const record = () => {
    if (!confirmed || submitted.current) return;
    submitted.current = true; setConfirmed(false);
    void inspect(signal => recordReviewedDispatchStop(reviewed, signal));
  };
  return <section aria-label="Stored stop evidence" className="space-y-5">
    <p className="break-all text-sm text-slate-300">Intent {reviewed.intentId} / {reviewed.tenantId}</p>
    <h2 role="status" className="text-base font-semibold text-amber-200">{report ? states[report.state] : messages[view.state === "ready" ? "idle" : view.state]}</h2>
    {report?.state === "stopped" && <dl className="grid gap-4 border-y border-white/10 py-5 text-sm sm:grid-cols-2">
      {[["Original stopper", report.stoppedBy], ["Stop recorded at", report.stoppedAt]].map(([label, value]) =>
        <div key={label} className="min-w-0"><dt className="text-slate-400">{label}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}
    </dl>}
    <p className="text-sm text-slate-300">Local handoff only. No provider cancellation, budget release or execution permission.</p>
    {report?.state === "not-stopped" && !submitted.current && <label className="flex items-start gap-3 text-sm text-slate-200">
      <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="focus-ring mt-1 h-4 w-4 shrink-0 accent-sky-300" />
      <span>I request a stop before handoff for this intent.</span>
    </label>}
    <div className="flex flex-wrap gap-3">
      {reviewed.state === "not-stopped" && <button type="button" disabled={!confirmed || submitted.current || view.state === "loading"} onClick={record}
        className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-amber-300/60 px-3 py-2 text-sm text-amber-200 disabled:opacity-50">
        <ShieldOff size={16} aria-hidden="true" className="shrink-0" />Record stop</button>}
      {submitted.current && <button type="button" disabled={view.state === "loading"} onClick={() => {
        void inspect(signal => inspectDispatchStop(reviewed.tenantId, reviewed.intentId, signal));
      }} className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-white/20 px-3 py-2 text-sm text-sky-200 disabled:opacity-50">
        <Search size={16} aria-hidden="true" className="shrink-0" />Check stop record</button>}
      <button type="button" onClick={hide} className="focus-ring text-sm text-sky-300 underline">Hide evidence</button>
    </div>
    {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fdispatch-stop" className="focus-ring text-sm text-sky-300 underline">Sign in</Link>}
  </section>;
}

export function DispatchStopPage() {
  const [tenant, setTenant] = useState(""), [intent, setIntent] = useState("");
  const { view, clear, inspect } = usePrivateInspection<DispatchStopInspection>();
  async function submit(event: FormEvent) {
    event.preventDefault(); await inspect(signal => inspectDispatchStop(tenant, intent, signal));
  }
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold"><ShieldOff className="h-6 w-6 shrink-0 text-sky-400" aria-hidden="true" />Pre-dispatch stop</h1>
    <nav aria-label="Related evidence" className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-sky-300">
      <Link href="/job-recovery" className="focus-ring underline">Job recovery</Link>
      <Link href="/cancellation-evidence" className="focus-ring underline">Cancellation request</Link>
      <Link href="/cost" className="focus-ring underline">Budget accounting</Link>
    </nav>
    <form onSubmit={submit} className="mt-6 grid gap-3 border-b border-white/10 pb-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      {([["tenant", "Tenant ID", tenant, setTenant], ["intent", "Intent ID", intent, setIntent]] as const).map(([key, label, value, setValue]) =>
        <label key={key} htmlFor={`stop-${key}`} className="grid min-w-0 gap-2 text-sm text-slate-300">{label}
          <input id={`stop-${key}`} autoComplete="off" maxLength={128} spellCheck={false} value={value}
            onChange={event => { clear(); setValue(event.target.value); }} className="focus-ring h-10 min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono text-slate-100" />
        </label>)}
      <button type="submit" disabled={!tenant || !intent || view.state === "loading"}
        className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
        <Search size={16} aria-hidden="true" />{view.state === "ready" ? "Read again" : "Inspect stop"}</button>
    </form>
    <p role="status" className="my-4 text-sm text-slate-300">{messages[view.state === "ready" ? "idle" : view.state]}
      {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fdispatch-stop" className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
    </p>
    {view.state === "ready" && <StopReview reviewed={view.report} hide={clear} />}
  </section>;
}
