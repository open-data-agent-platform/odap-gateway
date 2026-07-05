import {
  SESSION_COOKIE,
  getPublicSession,
  getSessionRole,
  readCookie,
  verifyAuthPayload,
  type AuthEnv,
  type AuthSession
} from "./auth";

export type AuthenticatedRequest = {
  ok: true;
  session: AuthSession;
};

export type AuthRequestFailure = {
  ok: false;
  response: Response;
  code: "auth_not_configured" | "unauthenticated" | "admin_required";
};

export async function getSessionFromRequest(request: Request, env: AuthEnv) {
  const secret = env.AUTH_COOKIE_SECRET;
  if (!secret) {
    return null;
  }

  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  return verifyAuthPayload<AuthSession>(token, secret);
}

export async function requireAdminSession(
  request: Request,
  env: AuthEnv
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

  return {
    ok: true,
    session
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
