import { getPhase4Health, getPublicHealth } from "../lib/phase2";
import { getPublicSession, getSessionRole, type AuthEnv } from "../lib/auth";
import {
  getSessionFromRequest,
  jsonResponse,
  requireAdminSession
} from "../lib/auth-request";
import type { AdminStorageEnv } from "../lib/admin-store";
import type { BigQueryEnv } from "../lib/bigquery";
import { onRequestGet as onAuthStartGet } from "../functions/api/auth/start/[provider]";
import { onRequestGet as onAuthCallbackGet } from "../functions/api/auth/callback/[provider]";
import {
  onRequestGet as onAuthLogoutGet,
  onRequestPost as onAuthLogoutPost
} from "../functions/api/auth/logout";
import { onRequestGet as onAuthSessionGet } from "../functions/api/auth/session";
import { onRequestGet as onAdminStateGet } from "../functions/api/admin/state";
import { onRequestPost as onAdminSchemaImportPost } from "../functions/api/admin/schema-import";
import { onRequestPatch as onAdminFeatureFlagPatch } from "../functions/api/admin/feature-flags/[id]";
import {
  onRequestGet as onAdminRunReviewGet,
  onRequestPatch as onAdminRunReviewPatch
} from "../functions/api/admin/run-reviews/[id]";
import { onRequestPatch as onAdminSchemaFieldPatch } from "../functions/api/admin/schema-fields/[id]";
import { onRequestPost as onAdminRollbackPost } from "../functions/api/admin/rollback";
import {
  onRequestGet as onDocsFeedbackGet,
  onRequestPost as onDocsFeedbackPost
} from "../functions/api/docs/feedback";
import { onRequestGet as onAdminDocsFeedbackGet } from "../functions/api/admin/docs-feedback";
import { onRequestPatch as onAdminDocsFeedbackPatch } from "../functions/api/admin/docs-feedback/[id]";
import { onRequestPatch as onAdminUserPatch } from "../functions/api/admin/users/[id]";
import { onRequestPost as onQueryDryRunPost } from "../functions/api/query/dry-run";

type AssetFetcher = {
  fetch(request: Request): Promise<Response>;
};

type WorkerEnv = AuthEnv &
  AdminStorageEnv &
  BigQueryEnv & {
    ASSETS: AssetFetcher;
  };

type WorkerContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type RouteMatch = {
  handler: () => Promise<Response> | Response;
  allowedMethods: string[];
};

const worker = {
  async fetch(request: Request, env: WorkerEnv, context: WorkerContext) {
    try {
      const response = await handleRequest(request, env, context);
      return withSecurityHeaders(response);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "worker_request_failed",
          message: error instanceof Error ? error.message : "Unknown error"
        })
      );

      return jsonResponse(
        {
          ok: false,
          code: "internal_error",
          message: "ODAP Gateway could not complete this request."
        },
        { status: 500 }
      );
    }
  }
};

export default worker;

async function handleRequest(
  request: Request,
  env: WorkerEnv,
  context: WorkerContext
) {
  const url = new URL(request.url);
  const apiRoute = matchApiRoute(request, env, url);

  if (apiRoute) {
    if (!apiRoute.allowedMethods.includes(request.method)) {
      return methodNotAllowed(apiRoute.allowedMethods);
    }

    return apiRoute.handler();
  }

  if (isAdminPageRequest(url.pathname)) {
    const adminGate = await authorizeAdminPage(request, env);
    if (adminGate) {
      return adminGate;
    }
  }

  context.waitUntil(Promise.resolve());
  const assetResponse = await serveStaticAsset(request, env);

  return isAdminPageRequest(url.pathname)
    ? withPrivateCacheHeaders(assetResponse)
    : assetResponse;
}

function matchApiRoute(
  request: Request,
  env: WorkerEnv,
  url: URL
): RouteMatch | null {
  if (url.pathname === "/api/health") {
    return {
      allowedMethods: ["GET", "HEAD"],
      handler: () => Response.json(getPublicHealth())
    };
  }

  if (url.pathname === "/api/admin/health") {
    return {
      allowedMethods: ["GET", "HEAD"],
      handler: async () => {
        const auth = await requireAdminSession(request, env);
        if (!auth.ok) {
          return auth.response;
        }

        return jsonResponse(getPhase4Health());
      }
    };
  }

  const authStart = url.pathname.match(/^\/api\/auth\/start\/([^/]+)$/);
  if (authStart) {
    return {
      allowedMethods: ["GET"],
      handler: () =>
        onAuthStartGet({
          request,
          env,
          params: { provider: authStart[1] }
        })
    };
  }

  const authCallback = url.pathname.match(/^\/api\/auth\/callback\/([^/]+)$/);
  if (authCallback) {
    return {
      allowedMethods: ["GET"],
      handler: () =>
        onAuthCallbackGet({
          request,
          env,
          params: { provider: authCallback[1] }
        })
    };
  }

  if (url.pathname === "/api/auth/logout") {
    return {
      allowedMethods: ["GET", "POST"],
      handler: () =>
        request.method === "POST"
          ? onAuthLogoutPost({ request })
          : onAuthLogoutGet({ request })
    };
  }

  if (url.pathname === "/api/auth/session") {
    return {
      allowedMethods: ["GET", "HEAD"],
      handler: () => onAuthSessionGet({ request, env })
    };
  }

  if (url.pathname === "/api/admin/state") {
    return {
      allowedMethods: ["GET", "HEAD"],
      handler: () => onAdminStateGet({ request, env })
    };
  }

  if (url.pathname === "/api/admin/docs-feedback") {
    return {
      allowedMethods: ["GET", "HEAD"],
      handler: () => onAdminDocsFeedbackGet({ request, env })
    };
  }

  if (url.pathname === "/api/admin/schema-import") {
    return {
      allowedMethods: ["POST"],
      handler: () => onAdminSchemaImportPost({ request, env })
    };
  }

  const docsFeedback = url.pathname.match(/^\/api\/admin\/docs-feedback\/([^/]+)$/);
  if (docsFeedback) {
    return {
      allowedMethods: ["PATCH"],
      handler: () =>
        onAdminDocsFeedbackPatch({
          request,
          env,
          params: { id: docsFeedback[1] }
        })
    };
  }

  const adminUser = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUser) {
    return {
      allowedMethods: ["PATCH"],
      handler: () =>
        onAdminUserPatch({
          request,
          env,
          params: { id: adminUser[1] }
        })
    };
  }

  const featureFlag = url.pathname.match(/^\/api\/admin\/feature-flags\/([^/]+)$/);
  if (featureFlag) {
    return {
      allowedMethods: ["PATCH"],
      handler: () =>
        onAdminFeatureFlagPatch({
          request,
          env,
          params: { id: featureFlag[1] }
        })
    };
  }

  const runReview = url.pathname.match(/^\/api\/admin\/run-reviews\/([^/]+)$/);
  if (runReview) {
    return {
      allowedMethods: ["GET", "PATCH"],
      handler: () =>
        request.method === "GET"
          ? onAdminRunReviewGet({
              request,
              env,
              params: { id: runReview[1] }
            })
          : onAdminRunReviewPatch({
              request,
              env,
              params: { id: runReview[1] }
            })
    };
  }

  const schemaField = url.pathname.match(/^\/api\/admin\/schema-fields\/([^/]+)$/);
  if (schemaField) {
    return {
      allowedMethods: ["PATCH"],
      handler: () =>
        onAdminSchemaFieldPatch({
          request,
          env,
          params: { id: schemaField[1] }
        })
    };
  }

  if (url.pathname === "/api/admin/rollback") {
    return {
      allowedMethods: ["POST"],
      handler: () => onAdminRollbackPost({ request, env })
    };
  }

  if (url.pathname === "/api/query/dry-run") {
    return {
      allowedMethods: ["POST"],
      handler: () => onQueryDryRunPost({ request, env })
    };
  }

  if (url.pathname === "/api/docs/feedback") {
    return {
      allowedMethods: ["GET", "POST"],
      handler: () =>
        request.method === "POST"
          ? onDocsFeedbackPost({ request, env })
          : onDocsFeedbackGet({ request, env })
    };
  }

  if (url.pathname.startsWith("/api/admin/")) {
    return {
      allowedMethods: ["GET", "POST", "PATCH"],
      handler: async () => {
        const auth = await requireAdminSession(request, env);
        if (!auth.ok) {
          return auth.response;
        }

        return jsonResponse(
          {
            ok: false,
            code: "not_found",
            message: "Admin API route not found.",
            user: getPublicSession(auth.session)
          },
          { status: 404 }
        );
      }
    };
  }

  return null;
}

async function authorizeAdminPage(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);

  if (!env.AUTH_COOKIE_SECRET) {
    return redirectToLogin(url, "auth_not_configured");
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return redirectToLogin(url, "unauthenticated");
  }

  if (getSessionRole(session) !== "admin") {
    return jsonResponse(
      {
        ok: false,
        code: "admin_required",
        message: "Administrator access is required for /admin.",
        user: getPublicSession(session)
      },
      { status: 403 }
    );
  }

  return null;
}

async function serveStaticAsset(request: Request, env: WorkerEnv) {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) {
    return response;
  }

  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return response;
  }

  if (!hasFileExtension(url.pathname)) {
    const htmlUrl = new URL(url);
    htmlUrl.pathname =
      url.pathname === "/" ? "/index.html" : `${url.pathname}.html`;
    const htmlResponse = await env.ASSETS.fetch(
      new Request(htmlUrl.toString(), {
        headers: request.headers,
        method: request.method
      })
    );

    if (htmlResponse.status !== 404) {
      return htmlResponse;
    }
  }

  return response;
}

function isAdminPageRequest(pathname: string) {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/admin.")
  );
}

function redirectToLogin(requestUrl: URL, error: string) {
  const loginUrl = new URL("/login", requestUrl.origin);
  loginUrl.searchParams.set("returnTo", "/admin");
  loginUrl.searchParams.set("error", error);

  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: loginUrl.toString()
    }
  });
}

function methodNotAllowed(allowedMethods: string[]) {
  return jsonResponse(
    {
      ok: false,
      code: "method_not_allowed",
      message: `Use ${allowedMethods.join(" or ")} for this endpoint.`
    },
    {
      status: 405,
      headers: {
        Allow: allowedMethods.join(", ")
      }
    }
  );
}

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function withPrivateCacheHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function hasFileExtension(pathname: string) {
  return /\/[^/]+\.[^/]+$/.test(pathname);
}
