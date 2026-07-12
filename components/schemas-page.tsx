"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  LoaderCircle,
  LockKeyhole,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
  TableProperties
} from "lucide-react";
import type { AdminState, BigQueryConfigState } from "@/lib/admin-store";
import { schemaTables } from "@/lib/demo-data";
import { cn } from "@/lib/utils";

type SchemaCatalogTable = AdminState["schemaCatalog"][number];
type SchemaCatalogField = SchemaCatalogTable["fields"][number];
type StorageState = AdminState["storage"];

type CatalogLoadState =
  | { status: "loading"; tables: SchemaCatalogTable[] }
  | {
      status: "ready";
      tables: SchemaCatalogTable[];
      storage: StorageState;
      bigQuery: BigQueryConfigState;
      generatedAt: string;
    }
  | {
      status: "locked";
      code: string;
      message: string;
      loginUrl?: string;
      tables: SchemaCatalogTable[];
    }
  | { status: "error"; message: string; tables: SchemaCatalogTable[] };

type ImportDraft = {
  workspace: string;
  dataset: string;
  projectId: string;
  tablePrefix: string;
  tableLimit: string;
};

type AdminStateResponse = {
  ok?: boolean;
  state?: AdminState;
  code?: string;
  message?: string;
  loginUrl?: string;
};

type SchemaImportResponse = {
  ok?: boolean;
  import?: {
    workspace: string;
    importedTables: number;
    importedFields: number;
    projectId: string;
    dataset: string;
  };
  code?: string;
  message?: string;
  loginUrl?: string;
};

const piiPattern = /\b(email|phone|address|ssn|ip|actor_ref|customer_id|session_ref)\b/i;
const seedCatalog = createSeedCatalog();

export function SchemasPage() {
  const [loadState, setLoadState] = useState<CatalogLoadState>({
    status: "loading",
    tables: seedCatalog
  });
  const [activeTableId, setActiveTableId] = useState<string | null>(
    seedCatalog[0]?.id ?? null
  );
  const [importDraft, setImportDraft] = useState<ImportDraft>({
    workspace: "demo",
    dataset: "demo_dataset",
    projectId: "",
    tablePrefix: "",
    tableLimit: "50"
  });
  const [pendingImport, setPendingImport] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoadState((current) => ({
      status: "loading",
      tables: current.tables.length ? current.tables : seedCatalog
    }));

    try {
      const response = await fetch("/api/admin/state", {
        cache: "no-store",
        credentials: "include"
      });
      const data = (await response.json().catch(() => null)) as
        | AdminStateResponse
        | null;

      if (response.status === 401 || response.status === 403) {
        setLoadState({
          status: "locked",
          code: data?.code ?? "admin_locked",
          message: data?.message ?? "Admin access is required.",
          loginUrl: data?.loginUrl,
          tables: seedCatalog
        });
        return;
      }

      if (!response.ok || !data?.state) {
        throw new Error(data?.message ?? "Schema catalog could not be loaded.");
      }

      const tables = data.state.schemaCatalog.length
        ? data.state.schemaCatalog
        : seedCatalog;

      setLoadState({
        status: "ready",
        tables,
        storage: data.state.storage,
        bigQuery: data.state.bigQuery,
        generatedAt: data.state.generatedAt
      });
      setActiveTableId((current) =>
        current && tables.some((table) => table.id === current)
          ? current
          : tables[0]?.id ?? null
      );
    } catch (error) {
      setLoadState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Schema catalog could not be loaded.",
        tables: seedCatalog
      });
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const tables = loadState.tables;
  const activeTable =
    tables.find((table) => table.id === activeTableId) ?? tables[0];
  const groupedCatalog = useMemo(() => groupCatalog(tables), [tables]);
  const totalFields = tables.reduce(
    (count, table) => count + table.fields.length,
    0
  );
  const totalPii = tables.reduce(
    (count, table) => count + table.fields.filter((field) => field.pii).length,
    0
  );
  const totalQueryable = tables.reduce(
    (count, table) =>
      count + table.fields.filter((field) => field.queryable).length,
    0
  );

  async function submitImport() {
    const tableLimit = Number(importDraft.tableLimit);
    setPendingImport(true);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/schema-import", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          workspace: importDraft.workspace,
          dataset: importDraft.dataset,
          projectId: importDraft.projectId,
          tablePrefix: importDraft.tablePrefix,
          tableLimit: Number.isFinite(tableLimit) ? tableLimit : undefined
        })
      });
      const data = (await response.json().catch(() => null)) as
        | SchemaImportResponse
        | null;

      if (!response.ok || !data?.import) {
        throw new Error(data?.message ?? "Schema import failed.");
      }

      setNotice(
        `Imported ${data.import.importedTables} tables and ${data.import.importedFields} fields from ${data.import.projectId}.${data.import.dataset}.`
      );
      await loadCatalog();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Schema import failed.");
    } finally {
      setPendingImport(false);
    }
  }

  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-6 lg:py-8">
      <div className="relative mx-auto grid max-w-[1480px] gap-5 px-4 sm:px-6 lg:grid-cols-[310px_minmax(0,1fr)_370px] lg:px-8">
        <aside className="glass-panel overflow-hidden rounded-lg">
          <div className="border-b border-white/[0.08] px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Database className="h-5 w-5 text-[#60a5fa]" />
                <h1 className="text-base font-semibold text-slate-50">
                  Schemas
                </h1>
              </div>
              <button
                type="button"
                title="Refresh schema"
                onClick={() => void loadCatalog()}
                className="focus-ring rounded-md p-2 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
              >
                <RefreshCcw
                  className={cn(
                    "h-4 w-4",
                    loadState.status === "loading" && "animate-spin"
                  )}
                />
              </button>
            </div>
            <CatalogStatus state={loadState} />
          </div>

          <div className="max-h-[calc(100vh-190px)] space-y-4 overflow-auto p-4">
            {groupedCatalog.map((group) => (
              <div key={group.workspace}>
                <p className="font-[var(--font-mono)] text-xs font-semibold text-slate-500">
                  {group.workspace}
                </p>
                <div className="mt-2 space-y-1">
                  {group.tables.map((table) => (
                    <button
                      key={table.id}
                      type="button"
                      onClick={() => setActiveTableId(table.id)}
                      className={cn(
                        "focus-ring flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                        table.id === activeTable?.id
                          ? "bg-[#4285f4]/15 text-[#93c5fd]"
                          : "text-slate-500 hover:bg-white/[0.05] hover:text-slate-100"
                      )}
                    >
                      <span className="min-w-0 truncate">{table.name}</span>
                      <span className="shrink-0 text-xs text-slate-700">
                        {table.fields.length}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <div className="min-w-0 space-y-5">
          <section className="glass-panel rounded-lg p-5 lg:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <TableProperties className="h-6 w-6 text-[#60a5fa]" />
                  <h2 className="truncate text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
                    {activeTable?.name ?? "Schema catalog"}
                  </h2>
                </div>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                  {activeTable?.description ??
                    "Import BigQuery schema metadata and govern queryable fields."}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs lg:min-w-[320px]">
                <TinyStat label="Tables" value={String(tables.length)} />
                <TinyStat label="Queryable" value={String(totalQueryable)} />
                <TinyStat label="PII" value={String(totalPii)} />
              </div>
            </div>
          </section>

          <section className="glass-panel overflow-hidden rounded-lg">
            <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
              <div className="flex items-center gap-3">
                <TableProperties className="h-5 w-5 text-[#60a5fa]" />
                <h2 className="text-base font-semibold text-slate-50">
                  Column list
                </h2>
              </div>
              <span className="text-xs font-semibold text-slate-600">
                {totalFields} fields
              </span>
            </div>
            {activeTable ? (
              <ColumnTable table={activeTable} />
            ) : (
              <div className="p-5 text-sm text-slate-500">
                No schema table selected.
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-5">
          <SchemaImportPanel
            draft={importDraft}
            pending={pendingImport}
            loadState={loadState}
            notice={notice}
            onDraftChange={(patch) =>
              setImportDraft((current) => ({
                ...current,
                ...patch
              }))
            }
            onSubmit={() => void submitImport()}
          />

          {activeTable ? <SampleQuery table={activeTable} /> : null}

          <section className="glass-panel rounded-lg p-5">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-[#fbbc05]" />
              <h2 className="text-base font-semibold text-slate-50">
                Governance
              </h2>
            </div>
            <div className="mt-4 space-y-3">
              {[
                "PII columns stay non-queryable by default.",
                "Imports preserve existing field policy toggles.",
                "Dry-runs block tables outside the workspace catalog."
              ].map((note) => (
                <div key={note} className="flex gap-3 text-sm leading-6 text-slate-500">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#34a853]" />
                  <span>{note}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function CatalogStatus({ state }: { state: CatalogLoadState }) {
  if (state.status === "ready") {
    return (
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold">
        <span className="rounded border border-[#34a853]/25 bg-[#34a853]/10 px-2 py-1 text-[#4ade80]">
          {state.storage.mode.toUpperCase()}
        </span>
        <span className="rounded border border-[#4285f4]/25 bg-[#4285f4]/10 px-2 py-1 text-[#93c5fd]">
          {state.bigQuery.mode}
        </span>
      </div>
    );
  }

  if (state.status === "locked") {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#fbbc05]/20 bg-[#fbbc05]/10 p-3 text-xs leading-5 text-[#fde68a]">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{state.message}</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#ea4335]/20 bg-[#ea4335]/10 p-3 text-xs leading-5 text-[#fca5a5]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{state.message}</span>
      </div>
    );
  }

  return (
    <p className="mt-3 text-xs font-semibold text-slate-600">
      Loading catalog
    </p>
  );
}

function SchemaImportPanel({
  draft,
  pending,
  loadState,
  notice,
  onDraftChange,
  onSubmit
}: {
  draft: ImportDraft;
  pending: boolean;
  loadState: CatalogLoadState;
  notice: string | null;
  onDraftChange: (patch: Partial<ImportDraft>) => void;
  onSubmit: () => void;
}) {
  const locked = loadState.status === "locked";

  return (
    <section className="glass-panel rounded-lg p-5">
      <div className="flex items-center gap-3">
        <RefreshCcw className="h-5 w-5 text-[#60a5fa]" />
        <h2 className="text-base font-semibold text-slate-50">
          BigQuery Import
        </h2>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="mt-4 grid gap-3"
      >
        <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
          Workspace
          <input
            value={draft.workspace}
            onChange={(event) =>
              onDraftChange({
                workspace: event.currentTarget.value
              })
            }
            className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            placeholder="demo"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
          Dataset
          <input
            value={draft.dataset}
            onChange={(event) =>
              onDraftChange({
                dataset: event.currentTarget.value
              })
            }
            className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            placeholder="demo"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
          Project override
          <input
            value={draft.projectId}
            onChange={(event) =>
              onDraftChange({
                projectId: event.currentTarget.value
              })
            }
            className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            placeholder="service account project"
          />
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-3">
          <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
            Table prefix
            <input
              value={draft.tablePrefix}
              onChange={(event) =>
                onDraftChange({
                  tablePrefix: event.currentTarget.value
                })
              }
              className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600"
              placeholder="optional"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
            Limit
            <input
              type="number"
              min={1}
              max={100}
              value={draft.tableLimit}
              onChange={(event) =>
                onDraftChange({
                  tableLimit: event.currentTarget.value
                })
              }
              className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={pending || locked}
          className="focus-ring mt-1 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#4285f4] px-4 text-xs font-semibold text-white shadow-[0_0_18px_rgba(66,133,244,0.22)] transition hover:bg-[#5b9bff] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          Import schema
        </button>
      </form>
      {locked ? (
        <a
          href="/login?returnTo=%2Fschemas"
          className="focus-ring mt-3 inline-flex h-9 items-center justify-center rounded-lg border border-white/[0.08] px-3 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.05]"
        >
          Sign in as admin
        </a>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-lg border border-white/[0.08] bg-black/[0.18] p-3 text-xs leading-5 text-slate-400">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

function ColumnTable({ table }: { table: SchemaCatalogTable }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead className="border-b border-white/[0.08] bg-white/[0.035] text-left text-xs font-semibold text-slate-500">
          <tr>
            <th className="px-5 py-3">Column</th>
            <th className="px-5 py-3">Type</th>
            <th className="px-5 py-3">Mode</th>
            <th className="px-5 py-3">Policy</th>
            <th className="px-5 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.06]">
          {table.fields.map((field) => (
            <tr key={field.id}>
              <td className="px-5 py-4">
                <span className="font-[var(--font-mono)] font-semibold text-slate-100">
                  {field.name}
                </span>
                {field.usedInExamples ? (
                  <span className="ml-2 rounded border border-[#fbbc05]/25 bg-[#fbbc05]/10 px-2 py-1 text-[10px] font-semibold text-[#facc15]">
                    used
                  </span>
                ) : null}
                <p className="mt-1 max-w-xl truncate text-xs text-slate-600">
                  {field.description}
                </p>
              </td>
              <td className="px-5 py-4">
                <TypeBadge type={field.type} />
              </td>
              <td className="px-5 py-4 text-slate-500">{field.mode}</td>
              <td className="px-5 py-4">
                <div className="flex flex-wrap gap-2">
                  <PolicyPill active={field.queryable} label="Queryable" />
                  <PolicyPill active={field.pii} label="PII" tone="danger" />
                </div>
              </td>
              <td className="px-5 py-4">
                <button
                  type="button"
                  onClick={() => void copyTableReference(table, field)}
                  className="focus-ring inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-semibold text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy ref
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SampleQuery({ table }: { table: SchemaCatalogTable }) {
  const firstDate =
    table.fields.find((field) => /date|time|timestamp/i.test(field.type)) ??
    table.fields[0];
  const dimensions = table.fields
    .filter((field) => field.queryable && !field.pii)
    .slice(0, 3);
  const selected = [firstDate, ...dimensions]
    .filter(Boolean)
    .map((field) => field.name);

  return (
    <section className="glass-panel rounded-lg p-5">
      <div className="flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-[#a855f7]" />
        <h2 className="text-base font-semibold text-slate-50">
          Sample query
        </h2>
      </div>
      <pre className="sql-code mt-4 overflow-auto rounded-lg border border-white/[0.08] bg-black/[0.22] p-4 text-slate-200">
        <code>{`SELECT
  ${selected.join(",\n  ")}
FROM \`${table.name}\`
LIMIT 100;`}</code>
      </pre>
    </section>
  );
}

function TinyStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 py-2">
      <span className="block text-[11px] font-medium text-slate-600">
        {label}
      </span>
      <span className="mt-1 block font-semibold text-slate-200">{value}</span>
    </span>
  );
}

function PolicyPill({
  active,
  label,
  tone = "default"
}: {
  active: boolean;
  label: string;
  tone?: "default" | "danger";
}) {
  const className = active
    ? tone === "danger"
      ? "border-[#ea4335]/25 bg-[#ea4335]/10 text-[#f87171]"
      : "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]"
    : "border-white/[0.08] bg-white/[0.035] text-slate-600";

  return (
    <span
      className={`rounded border px-2 py-1 text-[10px] font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const tone = getTypeTone(type);

  return (
    <span
      className={cn(
        "rounded px-2 py-1 text-[11px] font-semibold ring-1",
        tone
      )}
    >
      {type}
    </span>
  );
}

function getTypeTone(type: string) {
  if (/INT|NUMERIC|FLOAT|DECIMAL/i.test(type)) {
    return "bg-[#fbbc05]/[0.12] text-[#fbbc05] ring-[#fbbc05]/[0.15]";
  }

  if (/DATE|TIME/i.test(type)) {
    return "bg-[#4285f4]/[0.12] text-[#60a5fa] ring-[#4285f4]/[0.18]";
  }

  if (/BOOL/i.test(type)) {
    return "bg-[#34a853]/[0.12] text-[#4ade80] ring-[#34a853]/[0.18]";
  }

  return "bg-[#a855f7]/[0.14] text-[#d8b4fe] ring-[#a855f7]/20";
}

function groupCatalog(tables: SchemaCatalogTable[]) {
  const groups = new Map<string, SchemaCatalogTable[]>();

  tables.forEach((table) => {
    const collection = groups.get(table.workspace) ?? [];
    collection.push(table);
    groups.set(table.workspace, collection);
  });

  return Array.from(groups.entries()).map(([workspace, groupTables]) => ({
    workspace,
    tables: groupTables
  }));
}

function createSeedCatalog(): SchemaCatalogTable[] {
  const now = "2026-06-22T00:00:00.000Z";

  return schemaTables.map((table) => {
    const workspace = table.name.split(".")[0] ?? "demo";

    return {
      id: `seed-${table.name.replace(/\W+/g, "-")}`,
      workspace,
      name: table.name,
      description: "Seed schema preview used before admin D1 catalog loads.",
      rowCount: 0,
      updatedAt: now,
      fields: table.fields.map((field) => {
        const pii = piiPattern.test(field.name);

        return {
          id: `seed-${table.name.replace(/\W+/g, "-")}-${field.name}`,
          name: field.name,
          type: field.type,
          mode: field.key ? "REQUIRED" : "NULLABLE",
          description: `${field.name} from ${table.name}.`,
          pii,
          queryable: !pii,
          usedInExamples: Boolean(field.key),
          updatedAt: now
        } satisfies SchemaCatalogField;
      })
    } satisfies SchemaCatalogTable;
  });
}

async function copyTableReference(
  table: SchemaCatalogTable,
  field: SchemaCatalogField
) {
  const reference = `\`${table.name}\`.${field.name}`;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(reference);
    }
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = reference;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}
