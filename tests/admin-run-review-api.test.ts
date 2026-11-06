import { describe, expect, it } from "vitest";
import { adminAuthority } from "./fixtures/admin-authority";
import {
  onRequestGet,
  onRequestPatch
} from "../functions/api/admin/run-reviews/[id]";
import {
  createSessionCookie,
  signAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("admin run review API", () => {
  it("requires an admin session for updates", async () => {
    const response = await onRequestPatch({
      request: new Request("https://odap-gateway.local/api/admin/run-reviews/run-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" })
      }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "run-1"
      }
    });

    expect(response.status).toBe(401);
  });

  it("requires an admin session for detail reads", async () => {
    const response = await onRequestGet({
      request: new Request("https://odap-gateway.local/api/admin/run-reviews/run-1"),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "run-1"
      }
    });

    expect(response.status).toBe(401);
  });

  it("rejects invalid status values", async () => {
    const response = await onRequestPatch({
      request: await createAdminRequest({ status: "needs_approval" }),
      env: {
        AUTH_COOKIE_SECRET: secret, DB: adminAuthority()
      },
      params: {
        id: "run-1"
      }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_run_status"
    });
  });

  it("cannot verify current authority without D1", async () => {
    const response = await onRequestPatch({
      request: await createAdminRequest({ status: "approved" }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "run-1"
      }
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "admin_authority_unavailable"
    });
  });

  it("cannot authorize detail reads without D1", async () => {
    const response = await onRequestGet({
      request: await createAdminRequest({}, "GET"),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "run-1"
      }
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "admin_authority_unavailable"
    });
  });
});

async function createAdminRequest(
  body: Record<string, unknown>,
  method = "PATCH"
) {
  const cookie = await createCookie({
    provider: "google",
    providerId: "123",
    email: "owner@example.com",
    name: "Owner",
    role: "admin",
    expiresAt: Date.now() + 60_000
  });

  return new Request("https://odap-gateway.local/api/admin/run-reviews/run-1", {
    method,
    headers: {
      Cookie: cookie,
      Origin: "https://odap-gateway.local",
      "Content-Type": "application/json"
    },
    body: method === "GET" ? undefined : JSON.stringify(body)
  });
}

async function createCookie(session: AuthSession) {
  const token = await signAuthPayload(session, secret);
  return createSessionCookie(token, true);
}
