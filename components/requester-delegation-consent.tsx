"use client";

import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { consentToDelegation, type ConsentResult, type ConsentScope } from "../lib/requester-delegation";
import { validRequestId } from "../lib/review-contract-request";

export function RequesterDelegationConsent({ scope }: { scope: ConsentScope }) {
  const [keyId, setKeyId] = useState("");
  const [result, setResult] = useState<ConsentResult | { state: "ready" | "pending" }>({ state: "ready" });
  const deadline = Date.parse(scope.expiresAt);
  const [expired, setExpired] = useState(() => deadline <= Date.now());
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => { clearTimeout(timer); active.current?.abort(); };
  }, [deadline]);
  async function submit() {
    if (active.current || !validRequestId(keyId) || expired || (result.state !== "ready" && result.state !== "unknown")) return;
    const controller = new AbortController();
    active.current = controller;
    setResult({ state: "pending" });
    const next = await consentToDelegation(scope, keyId, controller.signal);
    if (!controller.signal.aborted) setResult(next);
    active.current = null;
  }
  const locked = result.state !== "ready";
  return <section aria-label="Requester delegation" className="mt-6 space-y-3 border-t border-white/10 pt-4">
    <h3 className="text-base font-semibold">Delegate to <code className="break-all">{scope.agentId}</code></h3>
    {expired || result.state === "expired" ? <p className="text-sm text-slate-300">The recorded grant window has ended.</p> : <>
      <label className="grid gap-1 text-sm text-slate-300">Enrolled key ID
        <input value={keyId} disabled={locked} onChange={e => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} maxLength={128}
          className="focus-ring h-10 w-full min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono" /></label>
      {["ready", "pending", "unknown"].includes(result.state) && <button type="button" onClick={() => void submit()}
        disabled={!validRequestId(keyId) || result.state === "pending"}
        className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-sky-300/50 px-3 text-sm font-semibold text-sky-200 disabled:opacity-50">
        <KeyRound size={16} aria-hidden="true" />{result.state === "unknown" ? "Retry same delegation" : "Consent to delegation"}</button>}
      <p role="status" className="break-words text-sm text-slate-300">
        {result.state === "pending" && "Submitting consent..."}
        {result.state === "refused" && "No challenge is available on this attempt. This does not cancel prior consent."}
        {result.state === "invalid" && "Invalid request or enrolled key ID."}
        {result.state === "unknown" && "No verified acknowledgement. Consent may already have been recorded."}
        {result.state === "recorded" && <>Delegation recorded: <code className="break-all">{result.delegationId}</code>. Agent signature is a separate step.</>}
      </p>
      {result.state === "recorded" && <details className="text-sm"><summary className="cursor-pointer">Agent signing challenge</summary>
        <textarea aria-label="Exact signing challenge" readOnly value={result.challenge} rows={4}
          className="mt-2 w-full rounded border border-white/15 bg-white/5 p-2 font-mono text-xs" /></details>}
    </>}
  </section>;
}
