import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileWarning,
  LockKeyhole,
  ShieldCheck,
  SlidersHorizontal,
  TableProperties
} from "lucide-react";
import { schemaTables } from "@/lib/demo-data";
import { phase2FeatureFlags } from "@/lib/phase2";

const policies = [
  {
    id: "no_select_star",
    name: "Block SELECT *",
    description:
      "Generated SQL must project specific columns so BigQuery dry-run can estimate cost and schema exposure.",
    status: "Enabled",
    severity: "High"
  },
  {
    id: "limit_required",
    name: "Require safe bounds",
    description:
      "Queries need LIMIT, WHERE, or partition filters before they can pass review.",
    status: "Enabled",
    severity: "Medium"
  },
  {
    id: "pii_protection",
    name: "Protect PII fields",
    description:
      "Sensitive fields are hidden from generated SQL unless an admin marks them queryable.",
    status: "Enabled",
    severity: "High"
  },
  {
    id: "array_filter_required",
    name: "Review unfiltered arrays",
    description:
      "Nested ARRAY and STRUCT access requires a reviewer when filters are missing.",
    status: "Guarded",
    severity: "Medium"
  }
];

const sensitivePattern = /\b(email|phone|address|ssn|ip|actor_ref|customer_id|session_ref)\b/i;

export function TeamPoliciesPage() {
  const fieldCount = schemaTables.reduce(
    (total, table) => total + table.fields.length,
    0
  );
  const piiFields = schemaTables.flatMap((table) =>
    table.fields
      .filter((field) => sensitivePattern.test(field.name))
      .map((field) => ({
        table: table.name,
        name: field.name,
        type: field.type
      }))
  );
  const schemaFlag = phase2FeatureFlags.find((flag) => flag.id === "schema-admin");

  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-6 lg:py-8">
      <div className="relative mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-5">
            <section className="glass-panel rounded-lg p-5 lg:p-6">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="h-6 w-6 text-[#34a853]" />
                    <h1 className="text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
                      Governance policies
                    </h1>
                  </div>
                  <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                    Control how AI-generated SQL uses schema, cost gates,
                    PII fields, and approval workflows before execution.
                  </p>
                </div>
                <div className="rounded-lg border border-[#34a853]/20 bg-[#34a853]/10 p-4 lg:min-w-[260px]">
                  <p className="text-xs font-semibold uppercase text-[#4ade80]">
                    Schema policy rollout
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-slate-50">
                    {schemaFlag?.rollout ?? 100}%
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    {schemaFlag?.environment ?? "staging"} /{" "}
                    {schemaFlag?.status ?? "enabled"}
                  </p>
                </div>
              </div>
            </section>

            <div className="grid gap-5 sm:grid-cols-3">
              <PolicyMetric
                icon={SlidersHorizontal}
                label="Policies"
                value={String(policies.length)}
                detail="Active governance rules"
              />
              <PolicyMetric
                icon={TableProperties}
                label="Schema fields"
                value={String(fieldCount)}
                detail={`${schemaTables.length} shared tables`}
              />
              <PolicyMetric
                icon={LockKeyhole}
                label="PII fields"
                value={String(piiFields.length)}
                detail="Blocked by default"
              />
            </div>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={FileWarning}
                title="Policy rules"
                action="Team scope"
              />
              <div className="grid gap-px bg-white/[0.07] md:grid-cols-2">
                {policies.map((policy) => (
                  <article key={policy.id} className="bg-[#0a0f1c] p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-[var(--font-mono)] text-xs text-slate-600">
                          {policy.id}
                        </p>
                        <h2 className="mt-2 text-base font-semibold text-slate-100">
                          {policy.name}
                        </h2>
                      </div>
                      <PolicyPill status={policy.status} />
                    </div>
                    <p className="mt-3 text-sm leading-7 text-slate-500">
                      {policy.description}
                    </p>
                    <p className="mt-4 text-xs font-semibold text-slate-600">
                      Severity: {policy.severity}
                    </p>
                  </article>
                ))}
              </div>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={Database}
                title="Schema catalog"
                action={`${schemaTables.length} tables`}
              />
              <div className="divide-y divide-white/[0.07]">
                {schemaTables.map((table) => (
                  <div key={table.name} className="px-5 py-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-[var(--font-mono)] text-sm font-semibold text-[#60a5fa]">
                        {table.name}
                      </p>
                      <span className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-slate-400">
                        {table.columnCount} columns
                      </span>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {table.fields.map((field) => {
                        const pii = sensitivePattern.test(field.name);

                        return (
                          <div
                            key={field.name}
                            className="rounded-lg border border-white/[0.08] bg-black/[0.16] px-3 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <p className="min-w-0 truncate font-[var(--font-mono)] text-xs font-semibold text-slate-200">
                                {field.name}
                              </p>
                              <span className="rounded bg-white/[0.05] px-2 py-1 text-[10px] font-semibold text-slate-500">
                                {field.type}
                              </span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <FieldPill active={!pii} label="Queryable" />
                              <FieldPill active={pii} label="PII" tone="danger" />
                              {field.key ? (
                                <FieldPill active label="Key" tone="warning" />
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-5">
            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={AlertTriangle}
                title="Execution guardrails"
                action="Required"
              />
              <div className="space-y-3 p-4">
                {[
                  "Direct execution is blocked until dry-run succeeds.",
                  "All generated SQL must be logged with actor and cost.",
                  "Risky SQL moves to reviewer and approver workflow.",
                  "PII fields are excluded unless an admin enables access."
                ].map((item) => (
                  <div
                    key={item}
                    className="flex gap-3 rounded-lg border border-white/[0.08] bg-black/[0.16] p-4 text-sm leading-6 text-slate-500"
                  >
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#34a853]" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle
                icon={LockKeyhole}
                title="PII inventory"
                action={`${piiFields.length} fields`}
              />
              <div className="divide-y divide-white/[0.07]">
                {piiFields.map((field) => (
                  <div key={`${field.table}.${field.name}`} className="px-5 py-4">
                    <p className="font-[var(--font-mono)] text-sm font-semibold text-slate-100">
                      {field.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{field.table}</p>
                    <p className="mt-2 text-xs font-semibold text-[#f87171]">
                      {field.type} / blocked by default
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}

function PolicyMetric({
  icon: Icon,
  label,
  value,
  detail
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="glass-panel rounded-lg p-5">
      <Icon className="h-5 w-5 text-[#60a5fa]" />
      <p className="mt-4 text-xs font-semibold uppercase text-slate-600">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-slate-50">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  action
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  action: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-[#60a5fa]" />
        <h2 className="text-base font-semibold text-slate-50">{title}</h2>
      </div>
      <span className="text-xs font-semibold text-slate-600">{action}</span>
    </div>
  );
}

function PolicyPill({ status }: { status: string }) {
  const className =
    status === "Enabled"
      ? "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]"
      : "border-[#fbbc05]/25 bg-[#fbbc05]/10 text-[#facc15]";

  return (
    <span
      className={`inline-flex w-fit rounded px-2 py-1 text-[11px] font-semibold ${className}`}
    >
      {status}
    </span>
  );
}

function FieldPill({
  active,
  label,
  tone = "default"
}: {
  active: boolean;
  label: string;
  tone?: "default" | "danger" | "warning";
}) {
  const className = active
    ? {
        default: "border-[#34a853]/25 bg-[#34a853]/10 text-[#4ade80]",
        danger: "border-[#ea4335]/25 bg-[#ea4335]/10 text-[#f87171]",
        warning: "border-[#fbbc05]/25 bg-[#fbbc05]/10 text-[#facc15]"
      }[tone]
    : "border-white/[0.08] bg-white/[0.035] text-slate-600";

  return (
    <span
      className={`rounded border px-2 py-1 text-[10px] font-semibold ${className}`}
    >
      {label}
    </span>
  );
}
