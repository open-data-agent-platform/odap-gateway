import {
  STATE_TTL_SECONDS, sanitizeReturnTo, signAuthPayload, verifyAuthPayload,
  type AuthEnv, type AuthProvider, type OAuthState
} from "./auth";
import { getAdminDb, type AdminStorageEnv } from "./admin-store";
import { sha256Text } from "./control-objects";

type LoginEnv = AuthEnv & AdminStorageEnv;

function cookieName(url: URL) {
  if (url.protocol === "https:") return "__Host-odap_gateway_oauth";
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return "odap_gateway_oauth_local";
  throw new Error("OAuth requires HTTPS or loopback");
}

function browserCookie(url: URL, value: string, maxAge: number) {
  return [
    cookieName(url) + "=" + value, "Path=/", "Max-Age=" + maxAge,
    "HttpOnly", "SameSite=Lax", ...(url.protocol === "https:" ? ["Secure"] : [])
  ].join("; ");
}

export function clearOAuthCookie(url: URL) {
  return browserCookie(url, "", 0);
}

export async function issueOAuthState(request: Request, env: LoginEnv, provider: AuthProvider) {
  const url = new URL(request.url);
  cookieName(url);
  const configured = getAdminDb(env);
  if (!configured || !env.AUTH_COOKIE_SECRET) throw new Error("Login state unavailable");
  const browserSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const payload: OAuthState = {
    provider, nonce: crypto.randomUUID(),
    returnTo: sanitizeReturnTo(url.searchParams.get("returnTo")),
    expiresAt: Date.now() + STATE_TTL_SECONDS * 1000
  };
  const state = await signAuthPayload(payload, env.AUTH_COOKIE_SECRET);
  const stateDigest = await sha256Text("oauth-state:" + state);
  const saved = await configured.db.prepare(
    "INSERT INTO oauth_login_states (state_digest,browser_digest,provider,origin,expires_at) VALUES (?,?,?,?,?) RETURNING state_digest"
  ).bind(stateDigest, await sha256Text("oauth-browser:" + browserSecret),
    provider, url.origin, payload.expiresAt).first<{state_digest: string}>();
  if (saved?.state_digest !== stateDigest) throw new Error("Login state unavailable");
  return {state, cookie: browserCookie(url, browserSecret, STATE_TTL_SECONDS)};
}

export async function consumeOAuthState(request: Request, env: LoginEnv, provider: AuthProvider) {
  const url = new URL(request.url);
  const token = url.searchParams.get("state") ?? "";
  if (!env.AUTH_COOKIE_SECRET || token.length > 4096 || token.split(".").length !== 2) return null;
  const state = await verifyAuthPayload<OAuthState>(token, env.AUTH_COOKIE_SECRET);
  if (!state || state.provider !== provider || typeof state.nonce !== "string" ||
      !/^[0-9a-f-]{36}$/.test(state.nonce) ||
      typeof state.returnTo !== "string" || sanitizeReturnTo(state.returnTo) !== state.returnTo ||
      !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) return null;
  const prefix = cookieName(url) + "=";
  const cookies = (request.headers.get("Cookie") ?? "").split(";")
    .map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (cookies.length !== 1) return null;
  const browserSecret = cookies[0].slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(browserSecret)) return null;
  const configured = getAdminDb(env);
  if (!configured) throw new Error("Login state unavailable");
  const stateDigest = await sha256Text("oauth-state:" + token);
  // Claim before provider I/O; failures require a fresh login, not replay.
  const claimed = await configured.db.prepare(
    "DELETE FROM oauth_login_states WHERE state_digest=? AND browser_digest=? AND provider=? AND origin=? AND expires_at=? AND expires_at>? RETURNING state_digest"
  ).bind(stateDigest, await sha256Text("oauth-browser:" + browserSecret),
    provider, url.origin, state.expiresAt, Date.now()).first<{state_digest: string}>();
  return claimed?.state_digest === stateDigest ? state : null;
}
