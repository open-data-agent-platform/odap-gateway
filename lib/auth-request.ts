import {
  SESSION_COOKIE,
  getPublicSession,
  getSessionRole,
  isAuthProvider,
  readCookie,
  verifyAuthPayload,
  type AuthEnv,
  type AuthSession
} from "./auth";
import { getAdminDb, type AdminStorageEnv } from "./admin-store";

export type AuthenticatedRequest = {
  ok: true;
  session: AuthSession;
};

export type AuthRequestFailure = {
  ok: false;
  response: Response;
  code: "auth_not_configured" | "unauthenticated" | "admin_required" | "admin_authority_unavailable";
};

export async function getSessionFromRequest(request: Request, env: AuthEnv) {
  const secret = env.AUTH_COOKIE_SECRET;
  if (!secret) {
    return null;
  }

  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  const session = await verifyAuthPayload<AuthSession>(token, secret);
  // OAuth state is also signed, but does not identify an authenticated subject.
  return session && isAuthProvider(session.provider) && typeof session.providerId === "string" &&
    session.providerId.trim() ? session : null;
}

export async function requireAdminSession(
  request: Request,
  env: AuthEnv & AdminStorageEnv
): Promise<AuthenticatedRequest | AuthRequestFailure> {
  if (!env.AUTH_COOKIE_SECRET) {
    return {
      ok: false,
      code: "auth_not_configured",
      response: jsonResponse(
        {
          ok: false,
          code: "auth_not_configured",
          message: "OAuth session cookies are not configured."
        },
        { status: 401 }
      )
    };
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return {
      ok: false,
      code: "unauthenticated",
      response: jsonResponse(
        {
          ok: false,
          code: "unauthenticated",
          message: "Sign in before opening the admin console.",
          loginUrl: "/login?returnTo=%2Fadmin"
        },
        { status: 401 }
      )
    };
  }

  if (getSessionRole(session) !== "admin") {
    return {
      ok: false,
      code: "admin_required",
      response: jsonResponse(
        {
          ok: false,
          code: "admin_required",
          message: "Your account is signed in but is not an administrator.",
          user: getPublicSession(session)
        },
        { status: 403 }
      )
    };
  }

  // A signed role is a login-time claim, not continuing authority. Never
  // initialize/seed storage on an authorization read or fall back on its failure.
  const configured = getAdminDb(env);
  let current: { role: string; email: string } | null;
  try {
    if (!configured) throw new Error("Missing authority store");
    current = await configured.db.prepare(
      "SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?"
    ).bind(`${session.provider}:${session.providerId}`, session.provider, session.providerId)
      .first<{ role: string; email: string }>();
  } catch {
    return {
      ok: false,
      code: "admin_authority_unavailable",
      response: jsonResponse({
        ok: false,
        code: "admin_authority_unavailable",
        message: "Current administrator authority could not be verified."
      }, { status: 503 })
    };
  }
  if (!current || current.role !== "admin" || typeof current.email !== "string" || !current.email.trim()) {
    return {
      ok: false,
      code: "admin_required",
      response: jsonResponse({
        ok: false,
        code: "admin_required",
        message: "Current administrator access is required."
      }, { status: 403 })
    };
  }

  return {
    ok: true,
    session: { ...session, email: current.email }
  };
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(body), {
    ...init,
    headers
  });
}
