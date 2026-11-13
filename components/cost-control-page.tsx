"use client";

import Link from "next/link";
import { RefreshCw, WalletCards } from "lucide-react";
import { useState, type FormEvent } from "react";
import { formatMicroUsd, inspectBudget, type BudgetInspection } from "../lib/budget-inspection";
import { usePrivateInspection } from "./use-private-inspection";

const messages = {
  idle: "", loading: "Reading budget...", invalid: "Enter tenant and budget IDs using letters, numbers, hyphens or underscores.",
  unauthenticated: "Sign in to view budget accounting.", denied: "Budget unavailable or current tenant owner access is missing.",
  incompatible: "Combined accounting is not available on this installation.", unavailable: "Budget accounting is unavailable. Try again."
} as const;
const componentLabels = [["sql", "SQL"], ["model", "Model"], ["tool", "Tool"]] as const;
const ledgerLabels = [["limitMicroUsd", "Budget limit"], ["reservedMicroUsd", "Reserved"],
  ["spentMicroUsd", "Spent"], ["overrunMicroUsd", "Overrun"]] as const;
const issueLabels = [["invalidSqlReceipts", "Unlinked SQL receipts"], ["invalidAuxiliaryAudits", "Invalid model/tool audit links"],
  ["invalidAuxiliaryBills", "Mismatched model/tool bills"]] as const;

export function CostControlPage() {
  const [tenant, setTenant] = useState("");
  const [budget, setBudget] = useState("");
  const { view, clear, inspect } = usePrivateInspection<BudgetInspection>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await inspect(signal => inspectBudget(tenant, budget, signal));
  }
  const report = view.state === "ready" ? view.report : null;
  return <section className="mx-auto min-h-[65vh] max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <WalletCards aria-hidden="true" className="h-6 w-6 shrink-0 text-sky-400" />Budget accounting
    </h1>
    <Link href="/evidence-coverage" className="focus-ring mt-3 inline-block text-sm text-sky-300 underline">Evidence coverage</Link>
    <form onSubmit={submit} className="mt-6 grid gap-3 border-b border-white/10 pb-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      {([["tenant", "Tenant ID", tenant, setTenant], ["budget", "Budget ID", budget, setBudget]] as const).map(([key, label, value, setValue]) =>
        <label key={key} htmlFor={`cost-${key}`} className="grid min-w-0 gap-2 text-sm text-slate-300">{label}
          <input id={`cost-${key}`} autoComplete="off" maxLength={128} spellCheck={false} value={value}
            onChange={event => { clear(); setValue(event.target.value); }}
            className="focus-ring h-10 min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono text-slate-100" />
        </label>)}
      <button type="submit" disabled={!tenant || !budget || view.state === "loading"}
        className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
        <RefreshCw className="h-4 w-4" aria-hidden="true" />{report ? "Refresh" : "View budget"}
      </button>
    </form>
    <p role="status" className="my-4 break-words text-sm text-slate-300">
      {report ? `Budget ${report.budgetId} / ${report.tenantId}` : messages[view.state === "ready" ? "idle" : view.state]}
      {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fcost" className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
    </p>
    {report && <div className="space-y-6">
      <div className="border-l-2 border-current pl-3">
        <h2 className={`text-base font-semibold ${report.consistent ? "text-emerald-300" : "text-amber-300"}`}>
          {report.consistent ? "Recorded accounting reconciles" : "Recorded accounting needs review"}
        </h2>
        <p className="mt-2 text-sm text-slate-300">{report.totals.pendingComponents} components awaiting final bills</p>
        {report.sql.recorded + report.model.recorded + report.tool.recorded === 0 &&
          <p className="mt-2 text-sm text-slate-300">No recorded components for this budget.</p>}
      </div>
      <dl className="grid grid-cols-1 gap-4 border-b border-white/10 pb-5 sm:grid-cols-2">
        {ledgerLabels.map(([key, label]) => <div key={key} className="min-w-0"><dt className="text-sm text-slate-400">{label}</dt>
          <dd className="mt-1 break-all font-mono text-lg tabular-nums">{formatMicroUsd(report.ledger[key])}</dd></div>)}
      </dl>
      <div className="overflow-x-auto" role="region" aria-label="Recorded component costs" tabIndex={0}>
        <table className="w-full min-w-[640px] text-right text-sm">
          <caption className="pb-3 text-left font-semibold">Recorded components (USD)</caption>
          <thead className="text-slate-400"><tr>{["Component", "Recorded", "Settled", "Pending", "Final charges", "Pending reserves"]
            .map((label, index) => <th key={label} scope="col" className={`px-2 py-2 font-normal ${index === 0 ? "text-left" : ""}`}>{label}</th>)}</tr></thead>
          <tbody>{componentLabels.map(([key, label]) => <tr key={key} className="border-t border-white/10">
            <th scope="row" className="px-2 py-3 text-left font-normal">{label}</th>
            <td className="px-2 tabular-nums">{report[key].recorded}</td><td className="px-2 tabular-nums">{report[key].settled}</td>
            <td className="px-2 tabular-nums">{report[key].pending}</td>
            <td className="px-2 font-mono">{formatMicroUsd(report[key].recordedActualMicroUsd)}</td>
            <td className="px-2 font-mono">{formatMicroUsd(report[key].pendingReservedMicroUsd)}</td>
          </tr>)}</tbody>
          <tfoot><tr className="border-t border-white/20 font-semibold"><th scope="row" className="px-2 py-3 text-left">Total</th>
            <td colSpan={2}></td><td className="px-2">{report.totals.pendingComponents}</td>
            <td className="px-2 font-mono">{formatMicroUsd(report.totals.recordedActualMicroUsd)}</td>
            <td className="px-2 font-mono">{formatMicroUsd(report.totals.pendingReservedMicroUsd)}</td></tr></tfoot>
        </table>
      </div>
      {!report.consistent && <section aria-labelledby="budget-issues" className="border-t border-white/10 pt-5">
        <h2 id="budget-issues" className="text-base font-semibold text-amber-300">Reconciliation issues</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt>Reserve difference (records minus ledger)</dt><dd className="mt-1 break-all font-mono">{formatMicroUsd(report.difference.reservedMicroUsd)}</dd></div>
          <div><dt>Charge difference (records minus ledger)</dt><dd className="mt-1 break-all font-mono">{formatMicroUsd(report.difference.chargedMicroUsd)}</dd></div>
          <div><dt>Ledger counters consistent</dt><dd>{report.countersConsistent ? "Yes" : "No"}</dd></div>
          <div><dt>Unattributed tenant records</dt><dd>{report.issues.hasUnattributedRecords ? "Present" : "None recorded"}</dd></div>
          {issueLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{report.issues[key]}</dd></div>)}
        </dl>
      </section>}
      <p className="border-t border-white/10 pt-4 text-sm leading-6 text-slate-400">
        Recorded accounting only, not complete workflow cost. Pending reserves are not final charges.
        Issuer authenticity is unverified. This report grants no execution authority.
      </p>
    </div>}
  </section>;
}
