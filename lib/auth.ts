export type AuthProvider = "google" | "github";
export type AuthRole = "admin" | "member";

export type AuthEnv = {
  AUTH_COOKIE_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ADMIN_EMAILS?: string;
};

export type AuthSession = {
  provider: AuthProvider;
  providerId: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role?: AuthRole;
  expiresAt: number;
};

export type OAuthState = {
  provider: AuthProvider;
  nonce: string;
  returnTo: string;
  expiresAt: number;
};

export const SESSION_COOKIE = "odap_gateway_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const STATE_TTL_SECONDS = 60 * 10;

const encoder = new TextEncoder();

export function isAuthProvider(value: string): value is AuthProvider {
  return value === "google" || value === "github";
}

export function sanitizeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  if (value.startsWith("/api/auth")) {
    return "/";
  }

  return value.slice(0, 180);
}

export function getProviderCredentials(provider: AuthProvider, env: AuthEnv) {
  if (provider === "google") {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET
    };
  }

  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET
  };
}

export function getPublicSession(session: AuthSession) {
  return {
    provider: session.provider,
    email: session.email,
    name: session.name,
    avatarUrl: session.avatarUrl,
    role: getSessionRole(session)
  };
}

export function getSessionRole(session: Pick<AuthSession, "role">): AuthRole {
  return session.role === "admin" ? "admin" : "member";
}

export function getAuthRoleForEmail(email: string, env: AuthEnv): AuthRole {
  return isAdminEmail(email, env) ? "admin" : "member";
}

export function isAdminEmail(email: string, env: AuthEnv) {
  const normalizedEmail = normalizeEmail(email);

  return parseAdminEmails(env.ADMIN_EMAILS).includes(normalizedEmail);
}

export function parseAdminEmails(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function signAuthPayload(
  payload: AuthSession | OAuthState,
  secret: string
) {
  const encodedPayload = base64UrlEncode(
    encoder.encode(JSON.stringify(payload))
  );
  const signature = await signData(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export async function verifyAuthPayload<T extends AuthSession | OAuthState>(
  token: string | undefined,
  secret: string
) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = await signData(encodedPayload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encodedPayload))
    ) as T;

    if (!payload.expiresAt || payload.expiresAt < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return undefined;
  }

  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const prefix = `${name}=`;
  const match = cookies.find((cookie) => cookie.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
}

export function createSessionCookie(value: string, secure = true) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function clearSessionCookie(secure = true) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

async function signData(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value)
  );

  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}
