"use client";

import { ShieldCheck, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { MatchedRequest } from "../lib/owner-grant-review";
import { grantMatchedRequest, type GrantResult } from "../lib/owner-grant-decision";

export function OwnerGrantDecision({ match, close }: { match: MatchedRequest; close: () => void }) {
  const [result, setResult] = useState<GrantResult | { state: "ready" | "pending" }>({ state: "ready" });
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => active.current?.abort(), []);
  async function grant() {
    if (active.current || (result.state !== "ready" && result.state !== "unknown")) return;
    const controller = new AbortController();
    active.current = controller;
    setResult({ state: "pending" });
    const next = await grantMatchedRequest(match, controller.signal);
    if (!controller.signal.aborted) setResult(next);
    active.current = null;
  }
  return <section aria-label="Owner grant decision" className="space-y-2 border-l-2 border-amber-400/60 pl-3 text-sm">
    <h4 className="font-semibold">Grant decision</h4>
    <p className="break-words">{match.reviewedAction.metricId} on {match.reviewedAction.target} / {match.releaseId}</p>
    <p className="break-all font-mono">{JSON.stringify(match.reviewedAction.parameters)}</p>
    <div className="flex flex-wrap gap-2">
      {(result.state === "ready" || result.state === "unknown" || result.state === "pending") &&
        <button type="button" disabled={result.state === "pending"} onClick={() => void grant()}
          className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-amber-300/60 px-3 font-semibold text-amber-200 disabled:opacity-50">
          <ShieldCheck size={16} aria-hidden="true" />{result.state === "unknown" ? "Retry same grant" : "Record owner grant"}</button>}
      {result.state === "ready" && <button type="button" onClick={close} className="focus-ring flex min-h-10 items-center gap-2 px-3">
        <X size={16} aria-hidden="true" />Close without granting</button>}
    </div>
    <p role="status" className="break-words text-slate-200">
      {result.state === "pending" && "Recording owner grant..."}
      {result.state === "unknown" && "No verified acknowledgement. The grant may have been recorded."}
      {result.state === "refused" && "Grant not confirmed on this attempt. Check the current request and policy again."}
      {result.state === "expired" && "The acknowledged grant has expired. No renewal was requested."}
      {result.state === "recorded" && <>Grant recorded: <code className="break-all">{result.grantId}</code>. Expires at <time dateTime={result.expiresAt}>{result.expiresAt}</time>. No contract was issued.</>}
    </p>
  </section>;
}
