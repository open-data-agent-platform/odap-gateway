"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Github, ShieldCheck } from "lucide-react";

type LoginMessage = {
  tone: "success" | "error";
  text: string;
};

const errorMessages: Record<string, string> = {
  auth_not_configured: "OAuth credentials are not configured yet.",
  invalid_state: "The sign-in request expired. Please try again.",
  oauth_state_unavailable: "Sign-in is temporarily unavailable. Please try again later.",
  oauth_denied: "Sign-in was cancelled.",
  oauth_failed: "The provider could not complete sign-in.",
  unsupported_provider: "This sign-in provider is not supported."
};

export function LoginPanel() {
  const [message, setMessage] = useState<LoginMessage | null>(null);
  const [returnTo, setReturnTo] = useState("/admin");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const destination = params.get("returnTo");
    if (destination && ["/sql", "/semantic-review", "/evidence-coverage", "/approval-contract", "/contract-request", "/evidence-receipt"].includes(destination)) setReturnTo(destination);
    const error = params.get("error");

    if (error) {
      setMessage({
        tone: "error",
        text: errorMessages[error] ?? "Sign-in could not be completed."
      });
      return;
    }

    if (params.get("logout")) {
      setMessage({
        tone: "success",
        text: "Signed out."
      });
    }
  }, []);

  return (
    <section className="app-shell-bg min-h-[calc(100vh-56px)] py-10">
      <div className="relative mx-auto grid max-w-6xl gap-6 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-[#34a853]" />
            <h1 className="text-3xl font-semibold tracking-normal text-slate-50">
              Sign in to Open Data Agent Platform
            </h1>
          </div>
          <p className="mt-4 max-w-xl text-base leading-7 text-slate-500">
            Use your Google or GitHub account to access admin controls, saved
            query history, and workspace release gates.
          </p>
        </div>

        <div className="glass-panel glow-border overflow-hidden rounded-lg">
          <div className="border-b border-white/10 px-5 py-4">
            <h2 className="text-base font-semibold text-slate-50">
              Continue with one click
            </h2>
          </div>
          <div className="space-y-3 p-5">
            {message ? (
              <div
                className={
                  message.tone === "success"
                    ? "rounded-lg border border-[#34a853]/20 bg-[#34a853]/[0.08] px-4 py-3 text-sm font-medium text-[#4ade80]"
                    : "rounded-lg border border-[#ea4335]/20 bg-[#ea4335]/[0.08] px-4 py-3 text-sm font-medium text-[#f87171]"
                }
              >
                {message.text}
              </div>
            ) : null}

            <ProviderLink
              href={`/api/auth/start/google?returnTo=${encodeURIComponent(returnTo)}`}
              label="Continue with Google"
              icon={<GoogleMark />}
            />
            <ProviderLink
              href={`/api/auth/start/github?returnTo=${encodeURIComponent(returnTo)}`}
              label="Continue with GitHub"
              icon={<Github className="h-5 w-5" />}
            />

            <p className="pt-2 text-xs leading-5 text-slate-600">
              Open Data Agent Platform only stores your signed-in profile and
              session cookie.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProviderLink({
  href,
  label,
  icon
}: {
  href: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <a
      href={href}
      className="focus-ring flex h-12 items-center justify-center gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-4 text-sm font-semibold text-slate-100 transition hover:border-[#4285f4]/40 hover:bg-white/[0.06]"
    >
      {icon}
      {label}
    </a>
  );
}

function GoogleMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-sm font-bold text-[#4285f4]"
    >
      G
    </span>
  );
}
