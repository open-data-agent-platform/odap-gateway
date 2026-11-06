import {
  getProviderCredentials,
  isAuthProvider,
  type AuthEnv,
  type AuthProvider
} from "../../../../lib/auth";
import type { AdminStorageEnv } from "../../../../lib/admin-store";
import { issueOAuthState } from "../../../../lib/oauth-state";

type AuthStartContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    provider?: string;
  };
};

export async function onRequestGet(context: AuthStartContext) {
  const provider = context.params.provider;
  const url = new URL(context.request.url);

  if (!provider || !isAuthProvider(provider)) {
    return redirectToLogin(url, "unsupported_provider");
  }

  const secret = context.env.AUTH_COOKIE_SECRET;
  const credentials = getProviderCredentials(provider, context.env);
  if (!secret || !credentials.clientId || !credentials.clientSecret) {
    return redirectToLogin(url, "auth_not_configured", provider);
  }

  let challenge;
  try {
    challenge = await issueOAuthState(context.request, context.env, provider);
  } catch {
    return redirectToLogin(url, "oauth_state_unavailable", provider);
  }
  const callbackUrl = `${url.origin}/api/auth/callback/${provider}`;
  const authorizeUrl = createAuthorizeUrl(
    provider,
    credentials.clientId,
    callbackUrl,
    challenge.state
  );

  return new Response(null, {status: 302, headers: {
    Location: authorizeUrl, "Set-Cookie": challenge.cookie, "Cache-Control": "no-store"
  }});
}

function createAuthorizeUrl(
  provider: AuthProvider,
  clientId: string,
  callbackUrl: string,
  state: string
) {
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "select_account");
    return url.toString();
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

function redirectToLogin(
  requestUrl: URL,
  error: string,
  provider?: AuthProvider
) {
  const loginUrl = new URL("/login", requestUrl.origin);
  loginUrl.searchParams.set("error", error);
  if (provider) {
    loginUrl.searchParams.set("provider", provider);
  }

  return Response.redirect(loginUrl, 302);
}
