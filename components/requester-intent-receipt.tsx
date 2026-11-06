"use client";

import { FileSearch } from "lucide-react";
import { inspectOwnIntentReceipt, type IntentReceiptScope } from "../lib/receipt-inspection";
import { outcomeLabels } from "../lib/receipt-summary";
import { usePrivateInspection } from "./use-private-inspection";

export function RequesterIntentReceipt({ scope }: { scope: IntentReceiptScope }) {
  const { view, inspect } = usePrivateInspection<Awaited<ReturnType<typeof inspectOwnIntentReceipt>>>();
  const messages = { idle: "", loading: "Checking receipt...", invalid: "Invalid intent reference.",
    unauthenticated: "Sign in to see the receipt.", denied: "You do not have access to this tenant.",
    not_found: "No matching intent is visible.", unavailable: "Receipt could not be verified." };
  const receipt = view.state === "ready" ? view.snapshot.receipt : null;
  return <section aria-label="Intent receipt" className="space-y-2">
    <button type="button" disabled={view.state === "loading"} onClick={() => void inspect(signal => inspectOwnIntentReceipt(scope, signal))}
      className="focus-ring flex min-h-10 items-center gap-2 rounded-md border border-white/20 px-3 disabled:opacity-50">
      <FileSearch size={16} aria-hidden="true" />Look up receipt</button>
    <p role="status" className="break-words text-slate-300">{view.state !== "ready" ? messages[view.state] : !receipt ?
      "No receipt is linked to this intent yet." : <>
        <strong>{receipt.outcome === "pending" ? "Pending receipt" : "Final receipt: " + outcomeLabels[receipt.outcome]}</strong>
        {receipt.outcome === "pending" && ". No final outcome is recorded."}{" "}
        <code className="break-all">{receipt.id}</code>{" "}<time dateTime={receipt.recordedAt}>{receipt.recordedAt}</time>
      </>}</p>
  </section>;
}
