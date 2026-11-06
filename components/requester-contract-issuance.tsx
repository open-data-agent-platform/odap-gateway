"use client";

import { FileCheck2 } from "lucide-react";
import { useRef } from "react";
import { issueForReviewedDelegation, type IssuanceScope } from "../lib/requester-contract-issuance";
import { usePrivateInspection } from "./use-private-inspection";

export function RequesterContractIssuance({ scope, delegation }: {
  scope: IssuanceScope; delegation: Parameters<typeof issueForReviewedDelegation>[1]
}) {
  const { view, inspect } = usePrivateInspection<Awaited<ReturnType<typeof issueForReviewedDelegation>>>();
  const submitted = useRef(false);
  const messages = { idle: "Issuance does not reserve budget or execute a query.", loading: "Checking issuance...",
    ineligible: "Delegation is not eligible for issuance.", refused: "The issuer refused this command.",
    unknown: "Issuance not verified. The contract may already exist. Look up the issued contract before retrying." };
  return <section aria-label="Approval Contract issuance" className="space-y-2 border-t border-white/10 pt-3">
    <button type="button" disabled={view.state !== "idle"} onClick={() => {
      if (submitted.current) return;
      submitted.current = true;
      void inspect(signal => issueForReviewedDelegation(scope, delegation, signal));
    }} className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-sky-400/50 px-3 text-sky-200 disabled:opacity-50">
      <FileCheck2 size={16} aria-hidden="true" />Issue Approval Contract</button>
    <p role="status" className="break-words text-slate-300">{view.state === "recorded" ?
      <>Recorded contract: <code className="break-all">{view.contractId}</code> ({view.contractState} at lookup).</> : messages[view.state]}</p>
  </section>;
}
