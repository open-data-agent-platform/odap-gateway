"use client";

import { Eye, FilePenLine, History, ReceiptText } from "lucide-react";
import { useRef, useState } from "react";
import { inspectEvidenceReceipt, inspectReceiptExplanation, inspectReceiptRevision, submitReceiptCorrection } from "../lib/receipt-inspection";
import { isReceiptCorrectionInput } from "../lib/receipt-correction-input";
import { outcomeLabels } from "../lib/receipt-summary";
import { ControlObjectLookup } from "./control-object-lookup";
import { usePrivateInspection } from "./use-private-inspection";

function CorrectionEditor({ revision, submit }: { revision: number; submit: (reason: string, ref: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const sending = useRef(false);
  const valid = isReceiptCorrectionInput({ expectedRevision: revision, correctedReason: reason, evidenceRef: ref });
  const field = "focus-ring w-full min-w-0 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-slate-100";
  if (!editing) return <button type="button" onClick={() => setEditing(true)}
    className="focus-ring mt-3 inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm text-sky-300">
    <FilePenLine className="h-4 w-4" aria-hidden="true" />Add correction</button>;
  return <form aria-label="Receipt correction" className="mt-4 grid gap-3 text-sm"
    onSubmit={e => { e.preventDefault(); if (valid && !sending.current) { sending.current = true; submit(reason,ref); } }}>
    <p className="text-slate-300">{revision ? "Correcting revision " + revision : "Correcting the issued reason"}</p>
    <label className="grid gap-1">Corrected reason
      <textarea className={field} rows={3} required maxLength={512} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <label className="grid gap-1">Evidence reference
      <input className={field} placeholder="ticket:42" required maxLength={160} autoComplete="off" spellCheck={false}
        value={ref} onChange={e => setRef(e.target.value)} /></label>
    {ref && /[^a-zA-Z0-9:._-]/.test(ref) && <p className="text-amber-300">Use letters, numbers, colons, periods, underscores or hyphens.</p>}
    <div className="flex flex-wrap gap-3"><button type="submit" disabled={!valid}
      className="focus-ring rounded-md bg-sky-300 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">Submit correction</button>
      <button type="button" className="focus-ring px-2" onClick={() => { setEditing(false); setReason(""); setRef(""); }}>Cancel</button></div>
  </form>;
}

function RevisionLookup({ initial, read }: { initial: number; read: (revision: number) => void }) {
  const [raw, setRaw] = useState(String(initial));
  const revision = Number(raw);
  const valid = /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(revision);
  return <form aria-label="Correction history" className="mt-4 flex flex-wrap items-end gap-3 text-sm"
    onSubmit={e => { e.preventDefault(); if (valid) read(revision); }}>
    <label className="grid gap-1 text-slate-300">Revision number
      <input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" required value={raw}
        className="focus-ring w-40 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-slate-100"
        onChange={e => setRaw(e.target.value)} /></label>
    <button type="submit" disabled={!valid} className="focus-ring inline-flex items-center gap-2 rounded-md border border-white/20 px-3 py-2 disabled:opacity-50">
      <History className="h-4 w-4" aria-hidden="true" />Inspect revision</button>
  </form>;
}

function ReceiptReasons({ tenantId, id }: { tenantId: string; id: string }) {
  const { view, inspect, clear } = usePrivateInspection<Awaited<ReturnType<typeof inspectReceiptExplanation | typeof inspectReceiptRevision | typeof submitReceiptCorrection>>>();
  const messages = { idle: "", loading: "Request in progress...", invalid: "Invalid receipt ID.",
    unauthenticated: "Sign in again to view reasons.", denied: "Only a current tenant owner can view reasons.",
    not_found: "Receipt reasons are not available for this receipt.", unavailable: "Could not read receipt reasons. Try again.",
    invalid_correction: "Invalid correction. Review the receipt before editing again.",
    conflict: "The revision has changed. Read the latest reasons before editing again.",
    uncertain: "Submission not confirmed. Inspect the attempted revision or read the latest reasons.",
    revision_unavailable: "No verified record is available for the requested revision." };
  const reread = ["recorded","conflict","uncertain","invalid_correction","historical","revision_unavailable"].includes(view.state);
  const initialRevision = view.state === "uncertain" ? view.attemptedRevision : view.state === "historical" ? view.record.revision :
    view.state === "ready" ? view.snapshot.latest?.revision : undefined;
  return <section className="mt-5" aria-label="Receipt reasons">
    <button type="button" disabled={view.state === "loading"} aria-expanded={view.state === "ready"}
      className="focus-ring inline-flex items-center gap-2 rounded-md border border-white/20 px-3 py-2 text-sm disabled:opacity-50"
      onClick={() => view.state === "ready" ? clear() : void inspect(signal => inspectReceiptExplanation(tenantId,id,signal))}>
      <Eye className="h-4 w-4" aria-hidden="true" />{view.state === "ready" ? "Hide reasons" : reread ? "Read latest reasons" : "View reasons"}
    </button>
    {view.state !== "idle" && view.state !== "ready" && view.state !== "historical" && <p role="status" className="mt-3 text-sm text-slate-300">
      {view.state === "recorded" ? "Correction recorded as revision " + view.revision + "." : messages[view.state]}</p>}
    {view.state === "ready" && <><dl className="mt-4 grid gap-5 border-y border-white/10 py-4 text-sm sm:grid-cols-2">
      <div className="min-w-0"><dt className="font-semibold text-slate-300">Reason at issuance</dt>
        <dd className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{view.snapshot.issuedReason}</dd></div>
      <div className="min-w-0"><dt className="font-semibold text-sky-300">Latest correction{view.snapshot.latest && " (revision " + view.snapshot.latest.revision + ")"}</dt>
        <dd className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{view.snapshot.latest?.correctedReason ?? "No correction recorded."}</dd></div>
    </dl><CorrectionEditor revision={view.snapshot.latest?.revision ?? 0}
      submit={(reason, ref) => void inspect(signal => submitReceiptCorrection(view.snapshot,reason,ref,signal))} /></>}
    {view.state === "historical" && <section aria-label="Historical correction" className="mt-4 border-y border-white/10 py-4">
      <h2 className="font-semibold text-sky-300">Historical correction (revision {view.record.revision})</h2>
      <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{view.record.correctedReason}</p>
      <dl className="mt-3 grid gap-2 text-sm">{[
        ["Recorded by",view.record.actor],["Recorded at (UTC)",view.record.recordedAt],["Evidence reference",view.record.evidenceRef]
      ].map(([label,value]) => <div key={label} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-slate-400">{label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
      <button type="button" onClick={clear} className="focus-ring mt-3 text-sm text-sky-300">Hide history</button>
    </section>}
    {initialRevision !== undefined && <RevisionLookup initial={initialRevision}
      read={revision => void inspect(signal => inspectReceiptRevision(tenantId,id,revision,signal))} />}
  </section>;
}

export function EvidenceReceiptPage() {
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <ReceiptText className="h-6 w-6 text-sky-400" aria-hidden="true" />Evidence receipt
    </h1>
    <ControlObjectLookup kind="Receipt" load={inspectEvidenceReceipt}>{receipt => <>
      <dl className="grid gap-4 border-b border-white/10 pb-5 sm:grid-cols-2">
        <div><dt className="text-sm text-slate-400">Recorded outcome</dt>
          <dd className="mt-1 text-xl font-semibold">{outcomeLabels[receipt.outcome]}</dd></div>
        <div><dt className="text-sm text-slate-400">Cost settlement</dt>
          <dd className="mt-1 text-xl font-semibold text-amber-300">Not verified by this receipt</dd></div>
      </dl>
      <dl className="mt-4 text-sm">{[
        ["Recorded at (UTC)",receipt.recordedAt],
        ["Approval contract reference",receipt.hasContract ? "Present" : "Not recorded"],
        ["Semantic release reference",receipt.hasSemanticRelease ? "Present" : "Not recorded"]
      ].map(([label,value]) => <div key={label} className="grid gap-1 border-b border-white/10 py-2 sm:grid-cols-[13rem_1fr]">
        <dt className="text-slate-400">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}</dl>
      <ReceiptReasons key={JSON.stringify([receipt.tenantId,receipt.id])} tenantId={receipt.tenantId} id={receipt.id} />
    </>}</ControlObjectLookup>
  </section>;
}
