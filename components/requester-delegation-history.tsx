"use client";

import { Ban, History, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { inspectOwnDelegation } from "../lib/delegation-history";
import { inspectOwnIssuance } from "../lib/issuance-history";
import { revokeInspectedDelegation } from "../lib/requester-delegation-revocation";
import { canRequestIssuance, type IssuanceScope } from "../lib/requester-contract-issuance";
import { RequesterContractIssuance } from "./requester-contract-issuance";
import { RequesterBudgetReservation } from "./requester-budget-reservation";
import { usePrivateInspection } from "./use-private-inspection";

function RevokeControl({ id, onConfirm }: { id: string; onConfirm: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const submitted = useRef(false);
  const button = "focus-ring inline-flex min-h-10 items-center gap-2 rounded-md border border-red-300/50 px-3 text-red-200";
  if (!confirm) return <button type="button" className={button} onClick={() => setConfirm(true)}>
    <Ban size={16} aria-hidden="true" />Revoke delegation</button>;
  return <div className="space-y-2">
    <p className="break-words">Revoke <code className="break-all">{id}</code>? Earlier proofs and jobs are not undone.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} onClick={() => {
        if (submitted.current) return;
        submitted.current = true;
        onConfirm();
      }}><Ban size={16} aria-hidden="true" />Confirm revocation</button>
      <button type="button" className="focus-ring flex min-h-10 items-center gap-2 px-3" onClick={() => setConfirm(false)}>
        <X size={16} aria-hidden="true" />Keep delegation</button>
    </div>
  </div>;
}

function IssuanceHistory({ delegation, actionDigest }: { delegation: Parameters<typeof canRequestIssuance>[0]; actionDigest: string }) {
  const { view, inspect } = usePrivateInspection<Awaited<ReturnType<typeof inspectOwnIssuance>>>();
  const messages = { idle: "", loading: "Checking issuance history...", invalid: "Invalid delegation reference.",
    denied: "You do not have access to this tenant.", unauthenticated: "Sign in to see issuance history.",
    not_found: "No issuance is visible for this delegation.", unavailable: "Issuance history is unavailable." };
  return <section aria-label="Issuance history" className="space-y-2">
    <button type="button" disabled={view.state === "loading"} onClick={() => void inspect(signal => inspectOwnIssuance(delegation, signal))}
      className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-white/20 px-3 disabled:opacity-50">
      <History size={16} aria-hidden="true" />Look up issued contract</button>
    <p role="status" className="break-words text-slate-300">{view.state === "ready" ?
      <>Previously issued contract: <code className="break-all">{view.snapshot.contractId}</code>. This record does not authorize execution.</> : messages[view.state]}</p>
    {view.state === "ready" && <RequesterBudgetReservation canReview={canRequestIssuance(delegation)} scope={{
      tenantId: delegation.tenantId, contractId: view.snapshot.contractId, delegationId: delegation.delegationId,
      actionDigest, expiresAt: delegation.expiresAt }} />}
  </section>;
}

export function RequesterDelegationHistory({ scope, children }: { scope: IssuanceScope; children: ReactNode }) {
  const { view, inspect } = usePrivateInspection<Awaited<ReturnType<typeof revokeInspectedDelegation>>>();
  const messages = { idle: "", loading: "Checking delegation history...", invalid: "Invalid grant reference.",
    denied: "You do not have access to this tenant.", unauthenticated: "Sign in to see your delegation.",
    not_found: "No recorded delegation is visible for this grant.", unavailable: "Delegation history is unavailable.",
    revocation_unknown: "Revocation not verified. Look up the delegation again before retrying." };
  const showConsent = view.state === "idle" || view.state === "not_found" ||
    (view.state === "ready" && view.snapshot.revokedAt === null && view.snapshot.verifiedAt === null);
  return <><section aria-label="Delegation history" className="mt-5 space-y-3 border-t border-white/10 pt-4 text-sm">
    <button type="button" onClick={() => void inspect(signal => inspectOwnDelegation(scope, signal))}
      disabled={view.state === "loading"} className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-white/20 px-3 disabled:opacity-50">
      <History size={16} aria-hidden="true" />{view.state === "ready" ? "Refresh delegation history" : "Look up delegation"}
    </button>
    <p role="status" className="text-slate-300">{view.state === "ready" ? "Recorded delegation. Current eligibility has not been checked." : messages[view.state]}
      {view.state === "unauthenticated" && <Link className="ml-2 text-sky-300 underline" href="/login?returnTo=%2Fcontract-request">Sign in</Link>}</p>
    {view.state === "ready" && <dl className="grid gap-2">{[
      ["Delegation ID", view.snapshot.delegationId], ["Enrolled key ID", view.snapshot.keyId],
      ["Proof verified (UTC)", view.snapshot.verifiedAt ?? "No proof recorded"],
      ["Revoked (UTC)", view.snapshot.revokedAt ?? "No revocation recorded"],
      ["Original expiry (UTC)", view.snapshot.expiresAt]].map(([label, value]) =>
      <div key={label} className="grid min-w-0 gap-1 sm:grid-cols-[12rem_1fr]">
        <dt className="text-slate-400">{label}</dt><dd className="min-w-0 break-all font-mono">{value}</dd>
      </div>)}</dl>}
    {view.state === "ready" && view.snapshot.revokedAt === null &&
      <RevokeControl id={view.snapshot.delegationId} onConfirm={() => void inspect(signal => revokeInspectedDelegation(view.snapshot, signal))} />}
    {view.state === "ready" && canRequestIssuance(view.snapshot) &&
      <RequesterContractIssuance scope={scope} delegation={view.snapshot} />}
    {view.state === "ready" && view.snapshot.verifiedAt !== null && <IssuanceHistory delegation={view.snapshot} actionDigest={scope.actionDigest} />}
  </section>{(showConsent || view.state === "loading") && <div hidden={!showConsent}>{children}</div>}</>;
}
