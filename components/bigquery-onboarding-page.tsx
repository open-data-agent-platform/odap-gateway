import {
  CheckCircle2,
  Cloud,
  Database,
  FileJson,
  KeyRound,
  LoaderCircle,
  RefreshCcw,
  ShieldCheck
} from "lucide-react";

const connectionModes = [
  {
    title: "Google OAuth",
    body: "Best for Workspace users who can grant BigQuery metadata access.",
    icon: KeyRound,
    recommended: true
  },
  {
    title: "Service Account JSON",
    body: "Best for production teams that manage credentials through a secure secret store.",
    icon: FileJson,
    recommended: false
  }
];

const syncSteps = [
  "Test BigQuery project access",
  "Discover datasets and tables",
  "Import columns and nested fields",
  "Apply PII and queryable defaults",
  "Record audit event"
];

export function BigQueryOnboardingPage() {
  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-6 lg:py-8">
      <div className="relative mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-8">
        <section className="glass-panel rounded-lg p-5 lg:p-6">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
            <div>
              <div className="flex items-center gap-3">
                <Cloud className="h-6 w-6 text-[#60a5fa]" />
                <h1 className="text-3xl font-semibold tracking-normal text-slate-50 sm:text-4xl">
                  Connect BigQuery
                </h1>
              </div>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                Admins and owners can connect a BigQuery project, validate
                credentials, then start schema sync for the SQL workbench.
              </p>
            </div>
            <div className="rounded-lg border border-[#fbbc05]/20 bg-[#fbbc05]/10 p-4">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-[#facc15]" />
                <p className="text-sm font-semibold text-slate-100">
                  Security default
                </p>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-500">
                BigQuery credentials should be encrypted or stored in a secret
                manager. The UI never exposes raw credentials after save.
              </p>
            </div>
          </div>
        </section>

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-5">
            <section className="glass-panel overflow-hidden rounded-lg">
              <SectionTitle icon={Database} title="Connection method" action="Admin+" />
              <div className="grid gap-px bg-white/[0.07] md:grid-cols-2">
                {connectionModes.map((mode) => {
                  const Icon = mode.icon;

                  return (
                    <article key={mode.title} className="bg-[#0a0f1c] p-5">
                      <div className="flex items-start justify-between gap-3">
                        <Icon className="h-5 w-5 text-[#60a5fa]" />
                        {mode.recommended ? (
                          <span className="rounded border border-[#34a853]/25 bg-[#34a853]/10 px-2 py-1 text-[11px] font-semibold text-[#4ade80]">
                            Recommended
                          </span>
                        ) : null}
                      </div>
                      <h2 className="mt-4 text-base font-semibold text-slate-100">
                        {mode.title}
                      </h2>
                      <p className="mt-2 text-sm leading-7 text-slate-500">
                        {mode.body}
                      </p>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="glass-panel rounded-lg p-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
                  Connection name
                  <input
                    defaultValue="Acme Analytics Production"
                    className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none"
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-semibold text-slate-400">
                  Project ID
                  <input
                    defaultValue="acme-demo-project"
                    className="focus-ring h-10 rounded-lg border border-white/[0.08] bg-black/[0.22] px-3 text-sm text-slate-100 outline-none"
                  />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#4285f4] px-4 text-sm font-semibold text-white transition hover:bg-blue-500"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Test connection
                </button>
                <button
                  type="button"
                  className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.06]"
                >
                  <RefreshCcw className="h-4 w-4" />
                  Start schema sync
                </button>
              </div>
            </section>
          </div>

          <aside className="glass-panel overflow-hidden rounded-lg">
            <SectionTitle icon={LoaderCircle} title="Schema sync plan" action="Queued" />
            <div className="space-y-3 p-4">
              {syncSteps.map((step, index) => (
                <div
                  key={step}
                  className="flex gap-3 rounded-lg border border-white/[0.08] bg-black/[0.16] p-4"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#4285f4]/25 bg-[#4285f4]/10 font-[var(--font-mono)] text-xs font-semibold text-[#93c5fd]">
                    {index + 1}
                  </span>
                  <p className="text-sm leading-6 text-slate-500">{step}</p>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </section>
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
