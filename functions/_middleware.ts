import { requireAdminSession } from "../lib/auth-request";
import { isAdminPageRequest } from "../lib/admin-page-path";
import { type AuthEnv } from "../lib/auth";
import { type AdminStorageEnv } from "../lib/admin-store";

type PagesMiddlewareContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  next: () => Promise<Response>;
};

export async function onRequest(context: PagesMiddlewareContext) {
  const url = new URL(context.request.url);

  if (!isAdminPageRequest(url.pathname)) {
    return context.next();
  }

  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.code === "auth_not_configured" || auth.code === "unauthenticated"
      ? redirectToLogin(url, auth.code) : auth.response;
  }

  return context.next();
}

function redirectToLogin(requestUrl: URL, error: string) {
  const loginUrl = new URL("/login", requestUrl.origin);
  loginUrl.searchParams.set("returnTo", "/admin");
  loginUrl.searchParams.set("error", error);

  return Response.redirect(loginUrl, 302);
}
