import type { Metadata } from "next";
import Link from "next/link";
import {
  BookOpenCheck,
  CheckCircle2,
  DatabaseZap,
  HelpCircle,
  MessageSquareText,
  ShieldCheck
} from "lucide-react";
import { DocsFeedbackPanel } from "@/components/docs-feedback-panel";
import { MainSiteBar } from "@/components/main-site-bar";
import { SiteFooter } from "@/components/site-footer";
import { gatewayPath } from "@/lib/gateway-path";
import {
  docsFaqs,
  docsGuides
} from "@/lib/docs-content";
import { SOURCE_REPOSITORY_URL } from "@/lib/open-source";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Open Data Agent Platform user guides, FAQs, comments, and questions for schema-aware SQL generation and governed dry-runs."
};

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-[#090d17] text-[#edeae1]">
      <header className="sticky top-0 z-40 border-b border-[#edeae1]/10 bg-[#090d17]/90 backdrop-blur-xl">
        <MainSiteBar />
        <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-2 px-4 sm:gap-4 sm:px-8">
          <a href={gatewayPath("/")} className="flex items-center gap-2 text-[#edeae1]">
            <span className="glow-border flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#4285f4] via-[#a855f7] to-[#34a853] text-white shadow-[0_0_24px_rgba(66,133,244,0.28)]">
              <DatabaseZap className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold sm:text-base">ODAP Gateway</span>
          </a>
          <nav className="flex items-center gap-2 text-xs font-semibold">
            <a
              href={gatewayPath("/")}
              className="focus-ring hidden h-9 items-center rounded-md border border-[#2b3654] px-3 text-[#edeae1] transition hover:border-[#9aa2b7] sm:inline-flex"
            >
              Home
            </a>
            <Link
              href="/tools"
              className="focus-ring inline-flex h-9 items-center rounded-md bg-[#c9a35a] px-3 text-[#090d17] transition hover:bg-[#e4c887]"
            >
              Open tools
            </Link>
            <a
              href={SOURCE_REPOSITORY_URL}
              className="focus-ring hidden h-9 items-center rounded-md border border-[#2b3654] px-3 text-[#edeae1] transition hover:border-[#9aa2b7] sm:inline-flex"
              target="_blank"
              rel="noreferrer"
            >
              Source Code
            </a>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-[#edeae1]/10 bg-[linear-gradient(180deg,#090d17_0%,#111a2e_66%,#090d17_100%)]">
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(237,234,225,0.04)_1px,transparent_1px),linear-gradient(180deg,rgba(237,234,225,0.04)_1px,transparent_1px)] bg-[size:76px_76px] opacity-35" />
        <div className="relative mx-auto grid max-w-[1180px] gap-8 px-5 py-12 sm:px-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.58fr)] lg:items-end lg:py-16">
          <div>
            <p className="font-[var(--font-mono)] text-xs font-medium uppercase text-[#c9a35a]">
              Documentation
            </p>
            <h1 className="mt-4 max-w-3xl font-[var(--font-display)] text-4xl font-semibold leading-tight text-[#edeae1] sm:text-5xl">
              User guides, FAQs, and community questions.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-[#9aa2b7]">
              A dedicated place to learn Open Data Agent Platform workflows,
              review common questions, and leave comments or questions for the
              product team.
            </p>
          </div>
          <div className="rounded-lg border border-[#2b3654] bg-[#151f37] p-5 shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-[#c9a35a]" />
              <h2 className="text-lg font-semibold text-[#edeae1]">
                Docs workflow
              </h2>
            </div>
            <div className="mt-5 space-y-3">
              {[
                "Read the guide",
                "Check the FAQ",
                "Ask a question",
                "Review updates"
              ].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <CheckCircle2 className="h-4 w-4 text-[#4ade80]" />
                  <span className="text-sm text-[#9aa2b7]">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1180px] gap-5 px-5 py-10 sm:px-8 lg:grid-cols-[240px_minmax(0,1fr)] lg:py-14">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <nav className="rounded-lg border border-[#edeae1]/10 bg-[#111a2e] p-4">
            <p className="font-[var(--font-mono)] text-xs uppercase text-[#6e7690]">
              Contents
            </p>
            <div className="mt-4 grid gap-2 text-sm">
              <a className="rounded-md px-3 py-2 text-[#9aa2b7] transition hover:bg-white/[0.04] hover:text-[#edeae1]" href="#guides">
                User guides
              </a>
              <a className="rounded-md px-3 py-2 text-[#9aa2b7] transition hover:bg-white/[0.04] hover:text-[#edeae1]" href="#faq">
                FAQ
              </a>
              <a className="rounded-md px-3 py-2 text-[#9aa2b7] transition hover:bg-white/[0.04] hover:text-[#edeae1]" href="#community">
                Comments and questions
              </a>
            </div>
          </nav>
        </aside>

        <div className="min-w-0 space-y-8">
          <section id="guides" className="rounded-lg border border-[#edeae1]/10 bg-[#111a2e] p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <BookOpenCheck className="h-5 w-5 text-[#7fa6ff]" />
              <h2 className="text-2xl font-semibold text-[#edeae1]">
                User guides
              </h2>
            </div>
            <div className="mt-6 grid gap-4">
              {docsGuides.map((guide) => (
                <article
                  key={guide.id}
                  className="rounded-lg border border-[#edeae1]/10 bg-[#090d17] p-5"
                >
                  <h3 className="text-lg font-semibold text-[#edeae1]">
                    {guide.title}
                  </h3>
                  <p className="mt-2 text-sm leading-7 text-[#9aa2b7]">
                    {guide.summary}
                  </p>
                  <ol className="mt-4 grid gap-3">
                    {guide.steps.map((step, index) => (
                      <li key={step} className="flex gap-3 text-sm leading-6 text-[#9aa2b7]">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#c9a35a]/25 bg-[#c9a35a]/10 font-[var(--font-mono)] text-[11px] font-semibold text-[#e4c887]">
                          {index + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          </section>

          <section id="faq" className="rounded-lg border border-[#edeae1]/10 bg-[#111a2e] p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <HelpCircle className="h-5 w-5 text-[#c9a35a]" />
              <h2 className="text-2xl font-semibold text-[#edeae1]">
                Frequently asked questions
              </h2>
            </div>
            <div className="mt-6 divide-y divide-[#edeae1]/10 rounded-lg border border-[#edeae1]/10 bg-[#090d17]">
              {docsFaqs.map((item) => (
                <details key={item.question} className="group p-4">
                  <summary className="cursor-pointer list-none text-base font-semibold text-[#edeae1] marker:hidden">
                    <span className="inline-flex items-start gap-3">
                      <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[#7fa6ff]" />
                      {item.question}
                    </span>
                  </summary>
                  <p className="mt-3 ps-7 text-sm leading-7 text-[#9aa2b7]">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </section>

          <DocsFeedbackPanel />
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
