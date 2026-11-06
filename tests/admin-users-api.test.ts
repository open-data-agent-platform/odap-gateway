import { describe, expect, it } from "vitest";
import { adminAuthority } from "./fixtures/admin-authority";
import { onRequestPatch } from "../functions/api/admin/users/[id]";
import {
  createSessionCookie,
  signAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("admin users API", () => {
  it("requires an admin session for user role updates", async () => {
    const response = await onRequestPatch({
      request: new Request("https://odap-gateway.local/api/admin/users/google%3A123", {
        method: "PATCH",
        body: JSON.stringify({
          role: "admin"
        })
      }),
      env: {},
      params: {
        id: "google%3A123"
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "auth_not_configured"
    });
  });

  it("validates the requested role", async () => {
    const response = await onRequestPatch({
      request: await createAdminRequest("github:456", {
        role: "owner"
      }),
      env: {
        AUTH_COOKIE_SECRET: secret, DB: adminAuthority()
      },
      params: {
        id: "github%3A456"
      }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_user_role"
    });
  });

  it("requires D1 persistence before updating roles", async () => {
    const response = await onRequestPatch({
      request: await createAdminRequest("github:456", {
        role: "admin"
      }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "github%3A456"
      }
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "admin_authority_unavailable"
    });
  });
});

async function createAdminRequest(id: string, body: Record<string, unknown>) {
  const cookie = await createCookie({
    provider: "google",
    providerId: "123",
    email: "owner@example.com",
    name: "Owner",
    role: "admin",
    expiresAt: Date.now() + 60_000
  });

  return new Request(
    `https://odap-gateway.local/api/admin/users/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        Cookie: cookie,
        Origin: "https://odap-gateway.local",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
}

async function createCookie(session: AuthSession) {
  const token = await signAuthPayload(session, secret);
  return createSessionCookie(token, true);
}
