import { describe, expect, it } from "vitest";
import {
  getAuthRoleForEmail,
  getPublicSession,
  isAdminEmail,
  parseAdminEmails,
  sanitizeReturnTo,
  signAuthPayload,
  verifyAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("auth helpers", () => {
  it("signs and verifies a session payload", async () => {
    const session = {
      provider: "google",
      providerId: "123",
      email: "analyst@example.com",
      name: "Data Analyst",
      role: "member",
      expiresAt: Date.now() + 60_000
    } satisfies AuthSession;

    const token = await signAuthPayload(session, secret);
    const verified = await verifyAuthPayload<AuthSession>(token, secret);

    expect(verified).toMatchObject({
      provider: "google",
      email: "analyst@example.com"
    });
  });

  it("rejects tampered tokens", async () => {
    const token = await signAuthPayload(
      {
        provider: "github",
        providerId: "456",
        email: "dev@example.com",
        name: "Developer",
        role: "member",
        expiresAt: Date.now() + 60_000
      } satisfies AuthSession,
      secret
    );

    const [payload, signature] = token.split(".");
    const tamperedSignature = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    const tampered = `${payload}.${tamperedSignature}`;

    await expect(verifyAuthPayload<AuthSession>(tampered, secret)).resolves.toBe(
      null
    );
  });

  it("keeps OAuth return paths local", () => {
    expect(sanitizeReturnTo("/admin")).toBe("/admin");
    expect(sanitizeReturnTo("https://evil.example")).toBe("/");
    expect(sanitizeReturnTo("//evil.example")).toBe("/");
    expect(sanitizeReturnTo("/api/auth/logout")).toBe("/");
  });

  it("assigns admin role from comma-separated emails", () => {
    const env = {
      ADMIN_EMAILS: " owner@example.com,Ops@Example.com "
    };

    expect(parseAdminEmails(env.ADMIN_EMAILS)).toEqual([
      "owner@example.com",
      "ops@example.com"
    ]);
    expect(isAdminEmail("OPS@example.com", env)).toBe(true);
    expect(getAuthRoleForEmail("guest@example.com", env)).toBe("member");
  });

  it("exposes a normalized public role", () => {
    const publicSession = getPublicSession({
      provider: "github",
      providerId: "456",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      expiresAt: Date.now() + 60_000
    });

    expect(publicSession.role).toBe("admin");
  });
});
