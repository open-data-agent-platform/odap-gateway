"use client";
import { gatewayPath } from "@/lib/gateway-path";

import { Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { proposeMetricRequest, validRequestId, type MetricAction, type RequestDraft } from "../lib/review-contract-request";

const messages = {
  pending: "Submitting request...",
  proposed: "Proposal recorded. No execution was authorized.",
  refused: "Submission refused. Check the release and tenant access.",
  unknown: "No acknowledgement. The original request may have been recorded.",
  retryRefused: "Retry refused. The outcome of the original request is still unknown."
};
type Attempt = { draft: RequestDraft; state: keyof typeof messages };

export function ReviewContractRequest({ tenantId, releaseId, action }: { tenantId: string; releaseId: string; action: MetricAction | null }) {
  const [agent, setAgent] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const unresolved = attempt?.state === "unknown" || attempt?.state === "retryRefused";
  const same = attempt?.draft.requestedAgentId === agent && attempt.draft.releaseId === releaseId &&
    JSON.stringify(attempt.draft.action) === JSON.stringify(action);
  const ready = attempt?.state !== "pending" && (unresolved || (action && validRequestId(agent) && !(same && attempt?.state === "proposed")));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || active.current) return;
    // Retry the snapshot, never rebuild an ambiguous request from editable fields.
    const draft = attempt && (unresolved || same) ? attempt.draft :
      action && { requestId: crypto.randomUUID(), releaseId, requestedAgentId: agent, action };
    if (!draft) return;
    const controller = new AbortController();
    active.current = controller;
    setAttempt({ draft, state: "pending" });
    const outcome = await proposeMetricRequest(tenantId, draft, controller.signal);
    if (!controller.signal.aborted) {
      setAttempt({ draft, state: unresolved && outcome === "refused" ? "retryRefused" : outcome });
      active.current = null;
    }
  }

  return <form onSubmit={submit} aria-label="Contract request" className="space-y-3 border-t border-white/10 pt-5">
    <h3 className="text-sm font-semibold">Contract request</h3>
    <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="text-sm text-slate-300">Requested agent ID
        <input className="focus-ring mt-1 block w-full min-w-0 rounded-md border border-white/15 bg-[#10151d] px-3 py-2 font-mono text-sm"
          autoComplete="off" spellCheck={false} maxLength={128} value={agent} disabled={attempt?.state === "pending" || unresolved}
          onChange={e => setAgent(e.target.value)} /></label>
      <button type="submit" disabled={!ready} className="focus-ring flex min-h-10 items-center justify-center gap-2 rounded-md border border-sky-300/50 px-4 py-2 text-sm font-semibold text-sky-200 disabled:opacity-50">
        <Send size={16} aria-hidden="true" />{unresolved ? "Retry original request" : "Submit request"}</button>
    </div>
    {attempt && <div className="space-y-1 text-sm text-slate-300">
      <p role="status">{messages[attempt.state]}</p>
      <p className="break-all">Request ID: <a className="focus-ring font-mono text-sky-300 underline" target="_blank" rel="noopener noreferrer"
        title="Look up the stored proposal in a new tab" href={gatewayPath("/api/control/") + tenantId + "/contract-request/" + attempt.draft.requestId}>{attempt.draft.requestId}</a></p>
      <details><summary className="cursor-pointer">Submitted inputs</summary>
        <dl className="mt-2 space-y-1 break-all"><dt>Agent</dt><dd>{attempt.draft.requestedAgentId}</dd>
          <dt>Parameters</dt><dd className="whitespace-pre-wrap font-mono">{JSON.stringify(attempt.draft.action.parameters)}</dd></dl>
      </details>
    </div>}
  </form>;
}
