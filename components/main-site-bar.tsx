import { ArrowLeft } from "lucide-react";
import { MAIN_SITE_URL } from "@/lib/open-source";

export function MainSiteBar() {
  return (
    <div className="border-b border-white/10">
      <div className="mx-auto flex min-h-9 max-w-[1480px] items-center justify-between gap-4 px-4 text-xs sm:px-6 lg:px-8">
        {/* A full document navigation leaves the Gateway base path and Worker. */}
        <a
          href={MAIN_SITE_URL}
          title="Return to googlesql.com"
          className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-2 text-slate-300 transition hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to main site
        </a>
        <span className="hidden text-slate-400 sm:inline">ODAP project overview and documentation</span>
      </div>
    </div>
  );
}
