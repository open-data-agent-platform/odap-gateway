"use client";

import Link from "next/link";
import { Download, FileCheck2, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { inspectSettledEvidence, settledEvidenceFile, type SettledEvidenceInspection } from "../lib/settled-evidence-inspection";
import { usePrivateInspection } from "./use-private-inspection";

const messages = {
  idle: "", loading: "Reading settled evidence...", invalid: "Enter tenant and intent IDs using letters, numbers, hyphens or underscores.",
  unauthenticated: "Sign in to read settled evidence.", denied: "Settled evidence unavailable or current tenant owner access is missing.",
  incompatible: "Settled evidence access is not configured on this installation.", unavailable: "No consistent evidence bundle is available. Try again."
} as const;
const outcomes: Record<string, string> = { succeeded: "Success recorded", failed: "Failure recorded", cancelled: "Cancellation recorded" };

export function SettledEvidencePage() {
  const [tenant, setTenant] = useState("");
  const [intent, setIntent] = useState("");
  const { view, clear, inspect } = usePrivateInspection<SettledEvidenceInspection>();
  const [downloadFailed, setDownloadFailed] = useState(false);
  const hide = () => { clear(); setDownloadFailed(false); };
  async function submit(event: FormEvent) {
    event.preventDefault(); setDownloadFailed(false);
    await inspect(signal => inspectSettledEvidence(tenant, intent, signal));
  }
  const report = view.state === "ready" ? view.report : null;
  function download(kind: "json" | "digest") {
    if (!report) return;
    let url: string | undefined;
    try {
      const file = settledEvidenceFile(report, kind);
      url = URL.createObjectURL(new Blob([file.content], { type: file.type }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name;
      anchor.click(); setDownloadFailed(false);
    } catch { setDownloadFailed(true); }
    finally { if (url) { const used = url; setTimeout(() => URL.revokeObjectURL(used), 0); } }
  }
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <FileCheck2 aria-hidden="true" className="h-6 w-6 shrink-0 text-sky-400" />Settled evidence
    </h1>
    <nav aria-label="Related evidence" className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-sky-300">
      <Link href="/evidence-receipt" className="focus-ring underline">Evidence receipt</Link>
      <Link href="/job-recovery" className="focus-ring underline">Job recovery</Link>
    </nav>
    <form onSubmit={submit} className="mt-6 grid gap-3 border-b border-white/10 pb-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      {([["tenant", "Tenant ID", tenant, setTenant], ["intent", "Intent ID", intent, setIntent]] as const).map(([key, label, value, setValue]) =>
        <label key={key} htmlFor={`settled-${key}`} className="grid min-w-0 gap-2 text-sm text-slate-300">{label}
          <input id={`settled-${key}`} autoComplete="off" maxLength={128} spellCheck={false} value={value}
            onChange={event => { hide(); setValue(event.target.value); }}
            className="focus-ring h-10 min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono text-slate-100" />
        </label>)}
      <button type="submit" disabled={!tenant || !intent || view.state === "loading"}
        className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
        <Search className="h-4 w-4" aria-hidden="true" />{report ? "Read again" : "Read settled evidence"}
      </button>
    </form>
    <p role="status" className="my-4 break-all text-sm text-slate-300">
      {report ? `Intent ${report.intentId} / ${report.tenantId}` : messages[view.state === "ready" ? "idle" : view.state]}
      {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fsettled-evidence" className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
    </p>
    {report && <section aria-label="Settled evidence bundle" className="space-y-5">
      <div className="border-l-2 border-current pl-3">
        <h2 className={`text-base font-semibold ${report.outcome === "succeeded" ? "text-emerald-300" : "text-amber-300"}`}>{outcomes[report.outcome]}</h2>
        <p className="mt-2 text-sm text-slate-300">Stored settlement. Bundle consistency checked.</p>
      </div>
      <dl className="grid gap-4 border-y border-white/10 py-5 text-sm sm:grid-cols-2">
        {[["Final receipt", report.receiptId], ["Recorded charge", report.actualMicroUsd.toLocaleString("en-US") + " micro-USD"],
          ["Audience", report.audience], ["Issuer authentication", "Not established"], ["SHA-256", report.digest]].map(([label, value]) =>
          <div key={label} className={`min-w-0 ${label === "SHA-256" ? "sm:col-span-2" : ""}`}><dt className="text-slate-400">{label}</dt>
            <dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        {([["json", "Download JSON"], ["digest", "Download checksum"]] as const).map(([kind, label]) =>
          <button key={kind} type="button" title={label} onClick={() => download(kind)}
            className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-md border border-white/20 px-3 py-2 text-sm text-sky-300">
            <Download className="h-4 w-4 shrink-0" aria-hidden="true" />{label}</button>)}
        <button type="button" onClick={hide} className="focus-ring min-h-10 px-2 text-sm text-sky-300 underline">Hide evidence</button>
      </div>
      {downloadFailed && <p role="alert" className="text-sm text-amber-300">Download could not start. Try again.</p>}
      <p className="text-sm leading-6 text-slate-400">Private tenant evidence. This checksum does not authenticate an issuer or establish independent custody.
        No provider contact, execution or settlement authority.</p>
    </section>}
  </section>;
}
