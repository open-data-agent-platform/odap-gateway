"use client";

import Link from "next/link";
import { ReviewMetricPreview } from "./review-metric-preview";
import { Archive, ClipboardCheck, FileCheck, FileSearch, PackageCheck, Search, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { inspectRevision, submitApproval, submitPromotion, submitRetirement, submitValidation, submitWithdrawal,
  type InspectionResult, type RetirementReceipt, type WithdrawalReceipt } from "../lib/review-inspection";

const messages = {
  invalid: "Use 1 to 128 letters, digits, hyphens or underscores in each ID.",
  signed_out: "Sign in to inspect a revision.",
  forbidden: "You do not have access to this tenant.",
  not_found: "No visible revision matches these IDs.",
  unavailable: "The review service is unavailable. Try again.",
  inconsistent: "The revision could not be verified. No definition is displayed."
};

const decisionMessages = {
  pending: "Recording validation evidence...",
  approving: "Recording semantic approval...",
  approved: "Semantic approval recorded.",
  publishing: "Publishing semantic release...",
  published: "Semantic release published.",
  publicationReadPending: "Publication was confirmed, but the review could not verify that release yet. Inspect again.",
  publicationRefused: "Publication was refused. Check the current approval and source catalog before trying again.",
  withdrawing: "Withdrawing approval...",
  retiring: "Retiring release...",
  invalidReason: "Enter a nonblank reason of up to 1,024 characters without surrounding whitespace.",
  withdrawalReadPending: "The review does not yet match the withdrawal response. Inspect again.",
  retirementReadPending: "Retirement confirmed. The review does not yet match the retired release. Inspect again.",
  recorded: "Validation evidence recorded.",
  invalid: "Enter a nonblank reference of up to 1,024 characters without surrounding whitespace.",
  conflict: "The decision was not recorded. Inspect the revision again to see its current state.",
  denied: "You do not have permission to record this decision.",
  unknown: "The outcome could not be confirmed. Inspect the revision before trying again."
};
type Attempt = { kind: "approval" | "release"; id: string };
type Notice = keyof typeof decisionMessages | "matched" | "different" | "unresolved";
function noticeText(notice: Notice, kind: Attempt["kind"] = "approval") {
  if (notice === "matched") return "The stored " + kind + " matches your earlier attempt.";
  if (notice === "different") return "A different " + kind + " is recorded for this revision.";
  if (notice === "unresolved") return "No matching " + kind + " was visible at the last read.";
  return decisionMessages[notice];
}

export function SemanticReviewPage() {
  const [tenant, setTenant] = useState("");
  const [revision, setRevision] = useState("");
  const [view, setView] = useState<InspectionResult | "loading" | null>(null);
  const active = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const [evidence, setEvidence] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [reason, setReason] = useState("");
  const [receipt, setReceipt] = useState<WithdrawalReceipt | RetirementReceipt | null>(null);
  const withdrawal = receipt && "approvalId" in receipt ? receipt : null;
  const retirement = receipt && "retiredAt" in receipt ? receipt : null;
  const pending = notice === "pending" || notice === "approving" || notice === "publishing" || notice === "withdrawing" || notice === "retiring";
  function clear() {
    active.current?.abort();
    writing.current = null;
    setEvidence("");
    setReason("");
    setReceipt(null);
    setAttempt(null);
    setNotice(null);
    setView(null);
  }
  useEffect(() => {
    window.addEventListener("pagehide", clear);
    return () => { window.removeEventListener("pagehide", clear); active.current?.abort(); };
  }, []);
  function showTerminalRead(read: InspectionResult, receipt: WithdrawalReceipt | RetirementReceipt) {
    if (!read.ok) {
      setView(read);
      if (read.error !== "unavailable" && read.error !== "inconsistent") setReceipt(null);
      setNotice(null);
      return;
    }
    const matches = "retiredAt" in receipt
      ? read.value.state === "retired" && read.value.releaseId === receipt.releaseId && read.value.retiredAt === receipt.retiredAt
      : read.value.approvalId === receipt.approvalId && (receipt.kind === "publicationWon"
      ? read.value.releaseId === receipt.releaseId
      : read.value.state === "withdrawn" && read.value.withdrawnAt === receipt.withdrawnAt);
    setView(matches ? read : null);
    setNotice(matches ? null : "retiredAt" in receipt ? "retirementReadPending" : "withdrawalReadPending");
  }
  function showPublicationRead(read: InspectionResult, id: string) {
    setAttempt({ kind: "release", id });
    if (!read.ok) {
      setView(read);
      setNotice(read.error === "unavailable" || read.error === "inconsistent" ? "publicationReadPending" : null);
    } else if (read.value.releaseId !== id) {
      setView(null);
      setNotice("publicationReadPending");
    } else {
      setView(read);
      setNotice("published");
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const compare = notice === "unknown" || notice === "unresolved" ? attempt : null;
    const confirmed = notice === "published" || notice === "publicationReadPending" ? attempt : null;
    clear();
    setReceipt(receipt);
    const controller = new AbortController();
    active.current = controller;
    setView("loading");
    const result = await inspectRevision(tenant, revision, controller.signal);
    if (controller.signal.aborted) return;
    if (receipt) return showTerminalRead(result, receipt);
    if (confirmed?.kind === "release") return showPublicationRead(result, confirmed.id);
    setView(result);
    if (compare && result.ok) {
      const stored = compare.kind === "release" ? result.value.releaseId : result.value.approvalId;
      setAttempt(compare);
      setNotice(stored === compare.id ? "matched" : stored ? "different" : "unresolved");
    } else if (compare && !result.ok && result.error === "unavailable") {
      setAttempt(compare);
      setNotice("unknown");
    }
  }
  const result = view && view !== "loading" ? view : null;
  const inspected = result?.ok ? result.value : null;
  async function endUse(event: FormEvent<HTMLFormElement>, action: "withdraw" | "retire") {
    event.preventDefault();
    const controller = active.current;
    if (!inspected || !(action === "retire" ? inspected.canRetireRelease : inspected.canWithdrawApproval) ||
        !controller || controller.signal.aborted || writing.current) return;
    writing.current = controller;
    setAttempt(null);
    setReceipt(null);
    setNotice(action === "retire" ? "retiring" : "withdrawing");
    const outcome = action === "retire" ? await submitRetirement(inspected, reason, controller.signal)
      : await submitWithdrawal(inspected, reason, controller.signal);
    if (controller.signal.aborted) return;
    if ("approvalId" in outcome || "retiredAt" in outcome) {
      setReceipt(outcome);
      setReason("");
      setNotice(null);
      setView("loading");
      const read = await inspectRevision(inspected.tenantId, inspected.revisionId, controller.signal);
      if (!controller.signal.aborted) showTerminalRead(read, outcome);
    } else {
      setNotice(outcome.kind);
      if (outcome.kind !== "invalidReason") {
        setReason("");
        setView(null);
      }
    }
    if (writing.current === controller) writing.current = null;
  }
  async function decide(event: FormEvent<HTMLFormElement>, action: "validate" | "approve" | "publish") {
    event.preventDefault();
    const controller = active.current;
    if (!inspected || !controller || controller.signal.aborted || writing.current) return;
    if ((action === "validate" && !inspected.canRecordValidation) || (action === "approve" && !inspected.approvalEvidence) ||
        (action === "publish" && !inspected.canRequestPromotion)) return;
    const id = action === "validate" ? "" : crypto.randomUUID();
    writing.current = controller;
    setAttempt(id ? { kind: action === "publish" ? "release" : "approval", id } : null);
    setNotice(action === "publish" ? "publishing" : action === "approve" ? "approving" : "pending");
    const outcome = action === "publish" ? await submitPromotion(inspected, id, controller.signal)
      : action === "approve" ? await submitApproval(inspected, id, controller.signal) : await submitValidation(inspected, evidence, controller.signal);
    if (controller.signal.aborted) return;
    setNotice(outcome);
    if (outcome !== "invalid") {
      setEvidence("");
      setReason("");
      const refresh = outcome === "recorded" || outcome === "approved" || outcome === "published";
      setView(refresh ? "loading" : null);
      if (refresh) {
        const fresh = await inspectRevision(inspected.tenantId, inspected.revisionId, controller.signal);
        if (!controller.signal.aborted) {
          if (outcome === "published") showPublicationRead(fresh, id);
          else setView(fresh);
        }
      }
    }
    if (writing.current === controller) writing.current = null;
  }
  const field = "focus-ring mt-2 block w-full min-w-0 rounded-md border border-white/15 bg-[#10151d] px-3 py-2 font-mono text-sm text-slate-100";
  return (
    <section className="mx-auto min-h-[65vh] max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold"><FileSearch className="h-6 w-6 text-sky-400" aria-hidden="true" />Semantic review</h1>
      <form onSubmit={submit} className="mt-6 grid items-end gap-4 border-y border-white/10 py-5 sm:grid-cols-[1fr_1fr_auto]">
        <label className="min-w-0 text-sm text-slate-300">Tenant ID
          <input className={field} disabled={pending} required maxLength={128} autoComplete="off" spellCheck={false} value={tenant}
            onChange={e => { clear(); setTenant(e.target.value); }} /></label>
        <label className="min-w-0 text-sm text-slate-300">Revision ID
          <input className={field} disabled={pending} required maxLength={128} autoComplete="off" spellCheck={false} value={revision}
            onChange={e => { clear(); setRevision(e.target.value); }} /></label>
        <button type="submit" disabled={pending} className="focus-ring flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 hover:bg-sky-200 disabled:opacity-50">
          <Search size={16} aria-hidden="true" />Inspect
        </button>
      </form>
      <p role="status" className="mt-4 text-sm text-slate-300">
        {view === "loading" ? "Loading revision..." : result && !result.ok ? messages[result.error] : null}
        {result && !result.ok && result.error === "signed_out" &&
          <Link href="/login?returnTo=%2Fsemantic-review" className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
        {inspected && <span className="sr-only">Revision loaded.</span>}
      </p>
      {withdrawal && <p role="status" className="my-3 break-all text-sm text-slate-200">
        {withdrawal.kind === "publicationWon"
          ? <>Already published as <code>{withdrawal.releaseId}</code>. This request did not withdraw the approval or retire the release.</>
          : <>{withdrawal.kind === "withdrawn" ? "Approval withdrawn." : "Already withdrawn. The original reason was retained."}
            {" "}<time dateTime={withdrawal.withdrawnAt}>{withdrawal.withdrawnAt}</time></>}
      </p>}
      {retirement && <p role="status" className="my-3 break-words text-sm text-slate-200">
        {retirement.kind === "retired" ? "Release retired." : retirement.kind === "alreadyRetired" ? "Already retired. The original reason was retained." : "Already retired. No retirement time was recorded."}
        {" "}<code className="break-all">{retirement.releaseId}</code>{retirement.retiredAt && <> at <time dateTime={retirement.retiredAt}>{retirement.retiredAt}</time></>}
      </p>}
      {notice && <p role="status" className="my-3 break-words text-sm text-slate-200">{noticeText(notice, attempt?.kind)}
        {attempt && (notice === "unknown" || notice === "different" || notice === "unresolved") &&
          <span className="block break-all font-mono">Attempted {attempt.kind} ID: {attempt.id}</span>}
        {(notice === "published" || notice === "publicationReadPending") && attempt && !inspected?.releaseId &&
          <span className="block break-all font-mono">Release ID: {attempt.id}</span>}</p>}
      {inspected && <article className="min-w-0 space-y-5" aria-label="Inspected revision">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="break-all text-xl font-semibold">{inspected.metricId}</h2>
          <span aria-label={"Review state: " + inspected.state} className="border-l border-white/15 pl-3 text-sm capitalize text-sky-300">{inspected.state}</span>
        </div>
        <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
          {([["Tenant", inspected.tenantId], ["Revision", inspected.revisionId], ["Source revision", inspected.sourceRevision],
            ["Definition digest (SHA-256)", inspected.definitionDigest]] as const).map(([label, value], i) =>
            <div key={label} className={i === 3 ? "sm:col-span-3" : "min-w-0"}>
              <dt className="text-slate-400">{label}</dt><dd className="mt-1 break-all font-mono">{value}</dd>
            </div>)}
        </dl>
        {inspected.approvalId && <p className="break-all text-sm">Approval ID: <code>{inspected.approvalId}</code></p>}
        {inspected.withdrawnAt && !withdrawal && <p className="text-sm">Withdrawn at: <time dateTime={inspected.withdrawnAt}>{inspected.withdrawnAt}</time></p>}
        {inspected.state === "retired" && !retirement && <p className="text-sm">{inspected.retiredAt
          ? <>Retired at: <time dateTime={inspected.retiredAt}>{inspected.retiredAt}</time></> : "No retirement time was recorded."}</p>}
        {inspected.releaseId && <p className="break-all text-sm">Release ID: <a className="focus-ring font-mono text-sky-300 underline"
          href={"/api/control/" + inspected.tenantId + "/release/" + inspected.releaseId}>{inspected.releaseId}</a></p>}
        <div><h3 className="mb-2 text-sm font-semibold">Canonical definition</h3>
          <pre className="whitespace-pre-wrap break-all rounded-md border border-white/10 bg-[#10151d] p-4 font-mono text-sm leading-6 text-slate-200"><code>{inspected.definitionJson}</code></pre>
        </div>
        {inspected.state === "published" && !pending && <ReviewMetricPreview
          key={JSON.stringify([inspected.tenantId, inspected.revisionId, inspected.releaseId, inspected.definitionDigest])} review={inspected} />}
        {inspected.canRecordValidation && <form onSubmit={e => decide(e, "validate")} aria-label="Validation evidence"
          className="grid items-end gap-3 border-t border-white/10 pt-5 sm:grid-cols-[1fr_auto]">
          <label className="min-w-0 text-sm text-slate-300">Evidence reference
            <input className={field} required maxLength={1024} value={evidence} autoComplete="off"
              disabled={notice === "pending"} onChange={e => { setEvidence(e.target.value); setNotice(null); }} /></label>
          <button type="submit" disabled={!evidence.trim() || notice === "pending"}
            className="focus-ring flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
            <ClipboardCheck size={16} aria-hidden="true" />Record evidence
          </button>
        </form>}
        {inspected.approvalEvidence && <form onSubmit={e => decide(e, "approve")} aria-label="Semantic approval"
          className="grid items-end gap-4 border-t border-white/10 pt-5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div><h3 className="text-sm text-slate-300">Recorded evidence reference</h3>
            <p className="mt-2 whitespace-pre-wrap break-all font-mono text-sm">{inspected.approvalEvidence}</p></div>
          <button type="submit" disabled={pending}
            className="focus-ring flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
            <FileCheck size={16} aria-hidden="true" />Approve definition
          </button>
        </form>}
        {inspected.canRequestPromotion && <form onSubmit={e => decide(e, "publish")} aria-label="Semantic publication"
          className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5">
          <h3 className="text-sm font-semibold">Semantic release</h3>
          <button type="submit" disabled={pending}
            className="focus-ring flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
            <PackageCheck size={16} aria-hidden="true" />Publish release
          </button>
        </form>}
        {(inspected.canWithdrawApproval || inspected.canRetireRelease) && <form
          onSubmit={e => endUse(e, inspected.canRetireRelease ? "retire" : "withdraw")}
          aria-label={inspected.canRetireRelease ? "Release retirement" : "Approval withdrawal"}
          className="grid items-end gap-3 border-t border-white/10 pt-5 sm:grid-cols-[minmax(0,1fr)_auto]">
          {inspected.canRetireRelease && <p className="text-sm text-slate-300 sm:col-span-2">Retirement blocks future dispatches. Jobs already handed off are not cancelled.</p>}
          <label className="min-w-0 text-sm text-slate-300">{inspected.canRetireRelease ? "Retirement reason" : "Withdrawal reason"}
            <input className={field} required maxLength={1024} autoComplete="off" value={reason} disabled={pending}
              onChange={e => { setReason(e.target.value); if (notice === "invalidReason") setNotice(null); }} /></label>
          <button type="submit" disabled={pending || !reason.trim()}
            className="focus-ring flex h-10 items-center justify-center gap-2 rounded-md border border-amber-300/50 px-4 text-sm font-semibold text-amber-200 disabled:opacity-50">
            {inspected.canRetireRelease ? <><Archive size={16} aria-hidden="true" />Retire release</> : <><Undo2 size={16} aria-hidden="true" />Withdraw approval</>}
          </button>
        </form>}
      </article>}
    </section>
  );
}
