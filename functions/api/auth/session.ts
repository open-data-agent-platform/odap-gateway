import {
  getPublicSession,
  type AuthEnv
} from "../../../lib/auth";
import { getSessionFromRequest } from "../../../lib/auth-request";

type SessionContext = {
  request: Request;
  env: AuthEnv;
};

export async function onRequestGet(context: SessionContext) {
  const secret = context.env.AUTH_COOKIE_SECRET;
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json"
  };

  if (!secret) {
    return new Response(
      JSON.stringify({ authenticated: false, configured: false }),
      { headers }
    );
  }

  const session = await getSessionFromRequest(context.request, context.env);

  return new Response(
    JSON.stringify({
      authenticated: Boolean(session),
      configured: true,
      user: session ? getPublicSession(session) : null
    }),
    { headers }
  );
}
