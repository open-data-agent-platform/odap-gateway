"use client";

import Link from "next/link";
import { ReviewContractRequest } from "./review-contract-request";
import { OwnerGrantReview } from "./owner-grant-review";
import { ScanLine } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Inspection } from "../lib/review-inspection";
import { checkMetricPreview, previewAction, previewModel } from "../lib/review-metric-preview";

const messages = {
  compiled: "Compiled. No query was run, no cost was estimated and no execution was authorized.",
  pending: "Checking compilation...",
  ineligible: "This release is no longer available for preview. Inspect the revision again.",
  signedOut: "Your session has ended.",
  denied: "You no longer have access to this tenant.",
  invalid: "These parameters do not match the current release.",
  tooLarge: "The preview request exceeds 8 KiB.",
  unavailable: "Compilation could not be verified. Try again."
};
const field = "focus-ring mt-1 block w-full min-w-0 rounded-md border border-white/15 bg-[#10151d] px-3 py-2 font-mono text-sm";

export function ReviewMetricPreview({ review }: { review: Inspection }) {
  const model = useMemo(() => previewModel(review), [review]);
  const [values, setValues] = useState(new Map<string, string>());
  const [status, setStatus] = useState<keyof typeof messages | null>(null);
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const action = useMemo(() => model && previewAction(model, values), [model, values]);
  function edit(name: string, value: string) {
    current.current?.abort();
    current.current = null;
    setStatus(null);
    setValues(previous => new Map(previous).set(name, value));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!model || !action || current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setStatus("pending");
    const result = await checkMetricPreview(model, action, controller.signal);
    if (controller.signal.aborted) return;
    current.current = null;
    setStatus(result);
  }
  if (!model) return <p className="text-sm text-slate-300">Preview unavailable for this metric definition.</p>;
  return <><form aria-label="Metric preview" onSubmit={submit} className="space-y-3 border-t border-white/10 pt-5">
    <h3 className="text-sm font-semibold">Metric preview</h3>
    {model.filters.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{model.filters.map(({ name, type }) =>
      <label key={name} className="min-w-0 break-all text-sm text-slate-300">{name} <span className="text-slate-400">({type})</span>
        {type === "BOOL" ? <select className={field} value={values.get(name) ?? ""} onChange={e => edit(name, e.target.value)}>
          <option value="">Select a value</option><option value="true">True</option><option value="false">False</option>
        </select> : <input className={field} type={type === "INT64" ? "number" : "text"} step={type === "INT64" ? "1" : undefined}
          autoComplete="off" spellCheck={false} value={values.get(name) ?? ""} onChange={e => edit(name, e.target.value)} />}
      </label>)}</div>}
    <button type="submit" disabled={!action || status === "pending"}
      className="focus-ring flex h-10 items-center gap-2 rounded-md border border-sky-300/50 px-4 text-sm font-semibold text-sky-200 disabled:opacity-50">
      <ScanLine size={16} aria-hidden="true" />Check compilation
    </button>
    <p role="status" className="text-sm text-slate-200">{status && messages[status]}
      {status === "signedOut" && <Link href="/login?returnTo=%2Fsemantic-review" className="ml-2 text-sky-300 underline">Sign in</Link>}</p>
  </form>
    <ReviewContractRequest tenantId={model.tenantId} releaseId={model.releaseId} action={action} />
    {review.canRetireRelease && <OwnerGrantReview tenantId={model.tenantId} releaseId={model.releaseId} action={action} />}
  </>;
}
