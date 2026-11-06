import {
  SESSION_TTL_SECONDS,
  createSessionCookie,
  getAuthRoleForEmail,
  getProviderCredentials,
  isAuthProvider,
  signAuthPayload,
  type AuthEnv,
  type AuthProvider,
  type AuthSession,
  type OAuthState
} from "../../../../lib/auth";
import {
  upsertAuthenticatedUser,
  type AdminStorageEnv
} from "../../../../lib/admin-store";
import { consumeOAuthState, clearOAuthCookie } from "../../../../lib/oauth-state";
import { fetchOAuthJson as fetchJson } from "../../../../lib/oauth-provider-json";

type AuthCallbackContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    provider?: string;
  };
};

type ProviderCredentials = {
  clientId: string;
  clientSecret: string;
};

type ProviderProfile = {
  providerId: string;
  email: string;
  name: string;
  avatarUrl?: string;
};

export async function onRequestGet(context: AuthCallbackContext) {
  const provider = context.params.provider;
  const url = new URL(context.request.url);

  if (!provider || !isAuthProvider(provider)) {
    return redirectToLogin(url, "unsupported_provider");
  }

  const code = url.searchParams.get("code");
  const denied = url.searchParams.has("error");
  const secret = context.env.AUTH_COOKIE_SECRET;
  const credentials = getProviderCredentials(provider, context.env);

  if (!secret || !credentials.clientId || !credentials.clientSecret) {
    return redirectToLogin(url, "auth_not_configured", provider);
  }
  const providerCredentials: ProviderCredentials = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret
  };

  if (!code && !denied) return redirectToLogin(url, "invalid_state", provider);
  let state: OAuthState | null;
  try {
    state = await consumeOAuthState(context.request, context.env, provider);
  } catch {
    return redirectToLogin(url, "oauth_state_unavailable", provider);
  }
  if (!state) {
    return redirectToLogin(url, "invalid_state", provider);
  }
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", clearOAuthCookie(url));
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {status: response.status, headers});
  };
  if (denied || !code) return finish(redirectToLogin(url, "oauth_denied", provider));

  try {
    const callbackUrl = `${url.origin}/api/auth/callback/${provider}`;
    const profile =
      provider === "google"
        ? await fetchGoogleProfile(code, providerCredentials, callbackUrl)
        : await fetchGithubProfile(code, providerCredentials, callbackUrl);
    const sessionPayload = {
      provider,
      providerId: profile.providerId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      role: getAuthRoleForEmail(profile.email, context.env),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
    } satisfies AuthSession;

    try {
      const storedUser = await upsertAuthenticatedUser(
        context.env,
        sessionPayload
      );
      if (!storedUser.persisted || !storedUser.role) {
        return finish(redirectToLogin(url, "auth_user_persist_failed", provider));
      }
      sessionPayload.role = storedUser.role;
    } catch {
      console.error(
        JSON.stringify({
          event: "auth_user_persist_failed",
          provider
        })
      );
      return finish(redirectToLogin(url, "auth_user_persist_failed", provider));
    }

    const session = await signAuthPayload(sessionPayload, secret);
    const destination = new URL(state.returnTo, url.origin);
    destination.searchParams.set("login", "success");

    return finish(new Response(null, {
      status: 302,
      headers: {
        Location: destination.toString(),
        "Set-Cookie": createSessionCookie(session, url.protocol === "https:")
      }
    }));
  } catch {
    // Provider/parser exceptions can contain token or profile response fragments.
    console.error(
      JSON.stringify({
        event: "oauth_callback_failed",
        provider
      })
    );
    return finish(redirectToLogin(url, "oauth_failed", provider));
  }
}

async function fetchGoogleProfile(
  code: string,
  credentials: ProviderCredentials,
  callbackUrl: string
) {
  const token = await postForm("https://oauth2.googleapis.com/token", {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl
  });
  const accessToken = getString(token, "access_token");
  if (!accessToken) {
    throw new Error("Google token response did not include access_token");
  }

  const profile = await fetchJson("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  const providerId = getString(profile, "sub");
  const email = getEmail(profile);
  const avatarUrl = getString(profile, "picture");

  if (!providerId || !email || !isRecord(profile) || profile.email_verified !== true) {
    throw new Error("Google profile did not include a verified email and identity");
  }
  const name = getString(profile, "name") || email;

  return {
    providerId,
    email,
    name,
    avatarUrl
  } satisfies ProviderProfile;
}

async function fetchGithubProfile(
  code: string,
  credentials: ProviderCredentials,
  callbackUrl: string
) {
  const token = await postForm("https://github.com/login/oauth/access_token", {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    redirect_uri: callbackUrl
  });
  const accessToken = getString(token, "access_token");
  if (!accessToken) {
    throw new Error("GitHub token response did not include access_token");
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "odap-gateway"
  };
  const profile = await fetchJson("https://api.github.com/user", { headers });
  const login = getString(profile, "login");
  const id = getString(profile, "id") || String(getNumber(profile, "id") ?? "");
  // A public profile field (or a constructed noreply address) is not
  // verification evidence for role bootstrap or account persistence.
  const email = await fetchGithubPrimaryEmail(accessToken);
  const avatarUrl = getString(profile, "avatar_url");

  if (!id || !email) {
    throw new Error("GitHub profile did not include a verified primary email and identity");
  }
  const name = getString(profile, "name") || login || email;

  return {
    providerId: id,
    email,
    name,
    avatarUrl
  } satisfies ProviderProfile;
}

async function fetchGithubPrimaryEmail(accessToken: string) {
  const data = await fetchJson("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "odap-gateway"
    }
  });

  if (!Array.isArray(data)) {
    return undefined;
  }

  const primary = data.filter(
    (item) =>
      isRecord(item) &&
      item.primary === true &&
      item.verified === true
  );

  return primary.length === 1 ? getEmail(primary[0]) : undefined;
}

async function postForm(url: string, form: Record<string, string>) {
  return fetchJson(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(form)
  });
}

function getString(record: unknown, key: string) {
  if (!isRecord(record)) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function getEmail(record: unknown) {
  const email = getString(record, "email")?.trim().toLowerCase();
  return email && !/\s/.test(email) ? email : undefined;
}

function getNumber(record: unknown, key: string) {
  if (!isRecord(record)) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
