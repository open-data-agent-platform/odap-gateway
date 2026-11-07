import { clearSessionCookie } from "../../../lib/auth";
import { jsonResponse } from "../../../lib/auth-request";

type LogoutContext = {
  request: Request;
};

export function onRequest(context: LogoutContext) {
  if (context.request.method !== "POST") {
    return jsonResponse(
      { ok: false, code: "method_not_allowed", message: "Use POST for this endpoint." },
      { status: 405, headers: { Allow: "POST" } }
    );
  }
  const url = new URL(context.request.url);
  if (context.request.headers.get("Origin") !== url.origin) {
    return jsonResponse(
      { ok: false, code: "same_origin_required", message: "Sign out from the Gateway origin." },
      { status: 403 }
    );
  }
  const destination = new URL("/login", url.origin);
  destination.searchParams.set("logout", "1");
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: destination.toString(),
      "Set-Cookie": clearSessionCookie(destination.protocol === "https:")
    }
  });
}
