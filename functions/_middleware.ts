import {
  getSessionFromRequest,
  jsonResponse
} from "../lib/auth-request";
import {
  getSessionRole,
  type AuthEnv
} from "../lib/auth";

type PagesMiddlewareContext = {
  request: Request;
  env: AuthEnv;
  next: () => Promise<Response>;
};

export async function onRequest(context: PagesMiddlewareContext) {
  const url = new URL(context.request.url);

  if (!isAdminPageRequest(url.pathname)) {
    return context.next();
  }

  if (!context.env.AUTH_COOKIE_SECRET) {
    return redirectToLogin(url, "auth_not_configured");
  }

  const session = await getSessionFromRequest(context.request, context.env);
  if (!session) {
    return redirectToLogin(url, "unauthenticated");
  }

  if (getSessionRole(session) !== "admin") {
    return jsonResponse(
      {
        ok: false,
        code: "admin_required",
        message: "Administrator access is required for /admin."
      },
      { status: 403 }
    );
  }

  return context.next();
}

function isAdminPageRequest(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function redirectToLogin(requestUrl: URL, error: string) {
  const loginUrl = new URL("/login", requestUrl.origin);
  loginUrl.searchParams.set("returnTo", "/admin");
  loginUrl.searchParams.set("error", error);

  return Response.redirect(loginUrl, 302);
}
