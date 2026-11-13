"use client";

import Link from "next/link";
import { History, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { inspectRecovery, type RecoveryInspection } from "../lib/recovery-inspection";
import { usePrivateInspection } from "./use-private-inspection";

const messages = {
  idle: "", loading: "Reading stored evidence...", invalid: "Enter tenant and intent IDs using letters, numbers, hyphens or underscores.",
  unauthenticated: "Sign in to inspect recovery evidence.", denied: "Recovery evidence unavailable or current tenant owner access is missing.",
  incompatible: "Recovery inspection is not configured on this installation.", unavailable: "Recovery evidence is unavailable. Try again."
} as const;
const outcomes = { succeeded: "Success recorded", failed: "Failure recorded", cancelled: "Cancellation recorded" } as const;

export function JobRecoveryPage() {
  const [tenant, setTenant] = useState("");
  const [intent, setIntent] = useState("");
  const { view, clear, inspect } = usePrivateInspection<RecoveryInspection>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await inspect(signal => inspectRecovery(tenant, intent, signal));
  }
  const report = view.state === "ready" ? view.report : null;
  const observation = report?.observation;
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <History aria-hidden="true" className="h-6 w-6 shrink-0 text-sky-400" />Job recovery
    </h1>
    <nav aria-label="Related evidence" className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-sky-300">
      <Link href="/evidence-receipt" className="focus-ring underline">Evidence receipt</Link>
      <Link href="/cost" className="focus-ring underline">Budget accounting</Link>
    </nav>
    <form onSubmit={submit} className="mt-6 grid gap-3 border-b border-white/10 pb-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      {([["tenant", "Tenant ID", tenant, setTenant], ["intent", "Intent ID", intent, setIntent]] as const).map(([key, label, value, setValue]) =>
        <label key={key} htmlFor={`recovery-${key}`} className="grid min-w-0 gap-2 text-sm text-slate-300">{label}
          <input id={`recovery-${key}`} autoComplete="off" maxLength={128} spellCheck={false} value={value}
            onChange={event => { clear(); setValue(event.target.value); }}
            className="focus-ring h-10 min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono text-slate-100" />
        </label>)}
      <button type="submit" disabled={!tenant || !intent || view.state === "loading"}
        className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
        <Search className="h-4 w-4" aria-hidden="true" />{report ? "Read again" : "Inspect recovery"}
      </button>
    </form>
    <p role="status" className="my-4 break-all text-sm text-slate-300">
      {report ? `Intent ${report.intentId} / ${report.tenantId}` : messages[view.state === "ready" ? "idle" : view.state]}
      {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fjob-recovery" className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
    </p>
    {report && <section aria-label="Stored recovery evidence" className="space-y-5">
      <div className="border-l-2 border-current pl-3">
        <h2 className={`text-base font-semibold ${observation?.state === "succeeded" ? "text-emerald-300" : "text-amber-300"}`}>
          {observation ? outcomes[observation.state] : "No stored terminal observation"}
        </h2>
        <p className="mt-2 text-sm text-slate-300">Current provider status unknown. Provider not contacted.</p>
      </div>
      <dl className="grid gap-4 border-y border-white/10 py-5 text-sm sm:grid-cols-2">
        {[["Project", report.jobReference.projectId], ["Location", report.jobReference.location],
          ["Job ID", report.jobReference.jobId], ["Receipt at handoff", report.receiptId],
          ["Billed bytes (stored)", observation?.billedBytes == null ? "Unknown" : observation.billedBytes.toLocaleString("en-US")],
          ["Cost settlement", "Not included in this evidence"]].map(([label, value]) =>
          <div key={label} className="min-w-0"><dt className="text-slate-400">{label}</dt>
            <dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}
        {observation && [["Observed at (stored)", observation.observedAt], ["Observed by", observation.observedBy]].map(([label, value]) =>
          <div key={label} className="min-w-0"><dt className="text-slate-400">{label}</dt>
            <dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}
      </dl>
      <p className="text-sm leading-6 text-slate-400">Stored evidence only. Billed bytes are not a monetary charge.
        The handoff receipt is not a final settlement receipt. No execution or settlement authority.</p>
      <button type="button" onClick={clear} className="focus-ring text-sm text-sky-300 underline">Hide evidence</button>
    </section>}
  </section>;
}
