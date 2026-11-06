"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ObjectInspection } from "../lib/object-inspection";
import { maxReceiptIdLength } from "../lib/receipt-id";
import { usePrivateInspection } from "./use-private-inspection";

const inputStyle = "focus-ring h-10 w-full min-w-0 rounded-md border border-white/20 bg-white/5 px-3 font-mono text-slate-100";

export function ControlObjectLookup<T extends { tenantId: string; id: string }>({ kind, load, children }: {
  kind: "Contract" | "Receipt" | "Request";
  load: (tenant: string, id: string, signal: AbortSignal) => Promise<ObjectInspection<T>>;
  children: (snapshot: T) => ReactNode;
}) {
  const [tenant, setTenant] = useState("");
  const [id, setId] = useState("");
  const { view, clear, inspect } = usePrivateInspection<ObjectInspection<T>>();
  const name = kind.toLowerCase();
  const returnTo = { Receipt: "/evidence-receipt", Contract: "/approval-contract", Request: "/contract-request" }[kind];
  const messages = {
    idle: "", loading: "Reading " + name + "...", invalid: kind === "Receipt" ? "Enter a valid tenant ID and issued receipt ID." : "Use letters, numbers, hyphens or underscores for both IDs.",
    unauthenticated: "Sign in to view this " + name + ".", denied: "You do not have access to this tenant.",
    not_found: kind + " not found or no longer visible.", unavailable: kind + " details are unavailable. Try again."
  };
  return <>
    <form className="mt-6 grid gap-3 border-b border-white/10 pb-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={e => { e.preventDefault(); void inspect(signal => load(tenant,id,signal)); }}>
      <label className="grid min-w-0 gap-2 text-sm text-slate-300">Tenant ID
        <input autoComplete="off" spellCheck={false} maxLength={128} value={tenant} className={inputStyle}
          onChange={e => { clear(); setTenant(e.target.value); }} />
      </label>
      <label className="grid min-w-0 gap-2 text-sm text-slate-300">{kind} ID
        <input autoComplete="off" spellCheck={false} maxLength={kind === "Receipt" ? maxReceiptIdLength : 128} value={id} className={inputStyle}
          onChange={e => { clear(); setId(e.target.value); }} />
      </label>
      <button type="submit" disabled={!tenant || !id || view.state === "loading"}
        className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-sky-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50">
        <Search className="h-4 w-4" aria-hidden="true" />{view.state === "ready" ? "Refresh" : "Inspect " + name}
      </button>
    </form>
    <p role="status" className="my-4 break-all text-sm text-slate-300">
      {view.state === "ready" ? kind + " " + view.snapshot.id + " in " + view.snapshot.tenantId : messages[view.state]}
      {view.state === "unauthenticated" && <Link href={"/login?returnTo=" + encodeURIComponent(returnTo)} className="focus-ring ml-2 text-sky-300 underline">Sign in</Link>}
    </p>
    {view.state === "ready" && children(view.snapshot)}
  </>;
}
