"use client";

import Link from "next/link";
import { ClipboardList, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { buckets, inspectCoverage, type Inspection } from "../lib/coverage-inspection";
import { usePrivateInspection } from "./use-private-inspection";

const messages = {
  idle: "", loading: "Reading coverage...", invalid: "Enter a tenant ID using letters, numbers, hyphens or underscores.",
  unauthenticated: "Sign in to view evidence coverage.", denied: "Owner access is required for this tenant.",
  unavailable: "Coverage is unavailable. Try again."
} as const;
const format = new Intl.NumberFormat("en-US");

export function EvidenceCoveragePage() {
  const [tenant, setTenant] = useState("");
  const { view, clear, inspect } = usePrivateInspection<Inspection>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await inspect(signal => inspectCoverage(tenant,signal));
  }
  const report = view.state === "ready" ? view.report : null;
  return <section className="mx-auto min-h-[65vh] max-w-4xl px-4 py-8 sm:px-6">
    <h1 className="flex items-center gap-3 text-2xl font-semibold">
      <ClipboardList aria-hidden="true" className="h-6 w-6 text-sky-400" />Evidence coverage
    </h1>
    <Link href="/evidence-receipt" className="focus-ring mt-3 inline-block text-sm text-sky-300 underline">Inspect evidence receipt</Link>
    <form onSubmit={submit} className="mt-6 flex flex-wrap items-end gap-3 border-b border-white/10 pb-6">
      <label className="grid min-w-0 flex-1 gap-2 text-sm text-slate-300" htmlFor="coverage-tenant">Tenant ID
        <input id="coverage-tenant" autoComplete="off" maxLength={128} spellCheck={false} value={tenant}
          onChange={e => { clear(); setTenant(e.target.value); }}
          className="focus-ring h-10 min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono text-slate-100" />
      </label>
      <button type="submit" disabled={!tenant || view.state === "loading"}
        className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
        <RefreshCw className="h-4 w-4" aria-hidden="true" />{report ? "Refresh" : "View coverage"}
      </button>
    </form>
    <p role="status" className="my-4 break-words text-sm text-slate-300">
      {view.state === "ready" ? (view.report.recordedAttempts ? "Coverage for " + tenant : "No recorded attempts for " + tenant + ".") : messages[view.state]}
      {view.state === "unauthenticated" && <Link href="/login?returnTo=%2Fevidence-coverage" className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
    </p>
    {report && report.recordedAttempts > 0 && <>
      <dl className="grid grid-cols-1 gap-4 border-b border-white/10 pb-5 sm:grid-cols-3">
        {([["recordedAttempts","Recorded attempts"],["admitted","Admitted"],["missingReleaseRefusals","Missing-release refusals"]] as const)
          .map(([key,label]) => <div key={key}><dt className="text-sm text-slate-400">{label}</dt>
            <dd className="mt-1 break-all text-2xl font-semibold tabular-nums">{format.format(report[key])}</dd></div>)}
      </dl>
      <table className="mt-6 w-full text-left text-sm">
        <caption className="pb-3 text-left font-semibold">Evidence for admitted attempts</caption>
        <thead className="text-slate-400"><tr><th scope="col" className="py-2 font-normal">State</th>
          <th scope="col" className="text-right font-normal">Count</th></tr></thead>
        <tbody>{buckets.map(([key,label]) => <tr key={key} className="border-t border-white/10">
          <th scope="row" className="py-2.5 font-normal">{label}</th>
          <td className="text-right tabular-nums">{format.format(report[key])}</td></tr>)}</tbody>
      </table>
    </>}
  </section>;
}
