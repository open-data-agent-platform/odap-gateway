"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogIn, LogOut } from "lucide-react";

type SessionState =
  | { status: "loading" }
  | { status: "guest" }
  | {
      status: "authenticated";
      user: {
        provider: "google" | "github";
        email: string;
        name: string;
        avatarUrl?: string;
        role: "admin" | "member";
      };
    };

export function AccountMenu() {
  const session = useAuthSession();

  if (session.status === "authenticated") {
    const initial = session.user.name.charAt(0).toLowerCase();

    return (
      <div className="flex items-center gap-2">
        <Link
          href={session.user.role === "admin" ? "/admin" : "/"}
          title={session.user.email}
          className="focus-ring hidden items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-2 py-1 text-xs text-slate-300 transition hover:bg-white/[0.06] sm:flex"
        >
          {session.user.avatarUrl ? (
            <span
              aria-hidden="true"
              className="h-6 w-6 rounded-full bg-cover bg-center"
              style={{ backgroundImage: `url("${session.user.avatarUrl}")` }}
            />
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[#4285f4] to-[#a855f7] text-xs font-semibold text-white">
              {initial}
            </span>
          )}
          <span className="max-w-28 truncate">{session.user.name}</span>
        </Link>
        <a
          href="/api/auth/logout"
          title="Sign out"
          aria-label="Sign out"
          className="focus-ring rounded-md p-2 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
        >
          <LogOut className="h-4 w-4" />
        </a>
      </div>
    );
  }

  return (
    <Link
      href="/login"
      className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-br from-[#4285f4] to-[#a855f7] px-3 text-xs font-semibold text-white shadow-[0_0_22px_rgba(168,85,247,0.28)] transition hover:brightness-110"
    >
      <LogIn className="h-3.5 w-3.5" />
      Sign in
    </Link>
  );
}

function useAuthSession() {
  const [session, setSession] = useState<SessionState>({
    status: "loading"
  });

  useEffect(() => {
    let active = true;

    fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "include"
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!active) {
          return;
        }

        if (isSessionResponse(data)) {
          setSession({ status: "authenticated", user: data.user });
        } else {
          setSession({ status: "guest" });
        }
      })
      .catch(() => {
        if (active) {
          setSession({ status: "guest" });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return session;
}

function isSessionResponse(value: unknown): value is {
  authenticated: true;
  user: {
    provider: "google" | "github";
    email: string;
    name: string;
    avatarUrl?: string;
    role: "admin" | "member";
  };
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record.authenticated !== true) {
    return false;
  }

  const user = record.user;
  if (typeof user !== "object" || user === null) {
    return false;
  }

  const userRecord = user as Record<string, unknown>;
  return (
    (userRecord.provider === "google" || userRecord.provider === "github") &&
    typeof userRecord.email === "string" &&
    typeof userRecord.name === "string" &&
    (userRecord.role === "admin" || userRecord.role === "member") &&
    (typeof userRecord.avatarUrl === "string" ||
      typeof userRecord.avatarUrl === "undefined")
  );
}
