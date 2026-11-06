"use client";

import { Check, History, Wallet, X } from "lucide-react";
import { useRef } from "react";
import { inspectOwnAdmission } from "../lib/admission-history";
import { confirmBudgetReservation, inspectBudgetQuote, type BudgetScope } from "../lib/requester-budget-admission";
import { usePrivateInspection } from "./use-private-inspection";
import { RequesterIntentReceipt } from "./requester-intent-receipt";

type View = Awaited<ReturnType<typeof inspectBudgetQuote | typeof confirmBudgetReservation>>;

export function RequesterBudgetReservation({ scope, canReview }: { scope: BudgetScope; canReview: boolean }) {
  const { view, inspect } = usePrivateInspection<Awaited<ReturnType<typeof inspectOwnAdmission>>>();
  const messages = { idle: "", loading: "Checking reservation history...", invalid: "Invalid contract reference.",
    denied: "You do not have access to this tenant.", unauthenticated: "Sign in to see reservation history.",
    not_found: "No reservation record is visible for this contract.", unavailable: "Reservation history is unavailable." };
  return <><section aria-label="Reservation history" className="space-y-2 border-t border-white/10 pt-3">
    <button type="button" disabled={view.state === "loading"} onClick={() => void inspect(signal => inspectOwnAdmission(scope, signal))}
      className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-white/20 px-3 disabled:opacity-50">
      <History size={16} aria-hidden="true" />Look up reservation</button>
    <p role="status" className="break-words text-slate-300">{view.state === "ready" ? <>
      Original reservation: <strong>{view.snapshot.originalMicroUsd.toLocaleString("en-US")} micro-USD</strong> from <code className="break-all">{view.snapshot.budgetId}</code>.
      {" "}Intent: <code className="break-all">{view.snapshot.intentId}</code>. This is not the current hold or final charge.
    </> : messages[view.state]}</p>
    {view.state === "ready" && <RequesterIntentReceipt key={view.snapshot.intentId} scope={view.snapshot} />}
  </section>{canReview && (view.state === "idle" || view.state === "not_found") && <ReservationCommand scope={scope} />}</>;
}

function ReservationCommand({ scope }: { scope: BudgetScope }) {
  const { view, inspect, clear } = usePrivateInspection<View>();
  const submitted = useRef(false);
  const messages = { idle: "", loading: "Checking budget reservation...",
    invalid: "This quote is no longer valid.", unauthenticated: "Sign in to review this reservation.",
    denied: "You do not have access to this tenant.", not_found: "No eligible reservation is available for this contract.",
    unavailable: "Budget quote unavailable.", refused: "Budget admission refused for this attempt.",
    unknown: "Reservation not verified. Look up the reservation before retrying." };
  const button = "focus-ring inline-flex min-h-10 items-center gap-2 rounded-md border border-white/20 px-3 disabled:opacity-50";
  return <section aria-label="Budget reservation" className="space-y-2 border-t border-white/10 pt-3">
    {view.state !== "ready" && view.state !== "acknowledged" && view.state !== "unknown" && <button type="button" className={button} disabled={view.state === "loading"}
      onClick={() => { submitted.current = false; void inspect(signal => inspectBudgetQuote(scope, signal)); }}>
      <Wallet size={16} aria-hidden="true" />Review budget reservation</button>}
    {view.state === "ready" ? <>
      <p className="break-words">Reserve <strong>{view.snapshot.microUsd.toLocaleString("en-US")} micro-USD</strong> from <code className="break-all">{view.snapshot.budgetId}</code>
        {" "}for contract <code className="break-all">{view.snapshot.contractId}</code>? This consumes the contract and creates an execution intent. No query will run.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => {
        if (submitted.current) return;
        submitted.current = true;
        void inspect(signal => confirmBudgetReservation(scope, view.snapshot, signal));
      }}><Check size={16} aria-hidden="true" />Confirm reservation</button>
        <button type="button" className={button} onClick={clear}><X size={16} aria-hidden="true" />Cancel</button></div>
    </> : <p role="status" className="break-words text-slate-300">{view.state === "acknowledged" ?
      <>{view.replay ? "Prior reservation acknowledged." : "Reservation acknowledged."} Intent: <code className="break-all">{view.intentId}</code>.</>
      : messages[view.state]}</p>}
  </section>;
}
