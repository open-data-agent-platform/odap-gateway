import { describe, expect, it } from "vitest";
import { onRequestPatch } from "../functions/api/admin/schema-fields/[id]";
import {
  createSessionCookie,
  signAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("admin schema field API", () => {
  it("requires an admin session for policy updates", async () => {
    const response = await onRequestPatch({
      request: new Request(
        "https://odap-gateway.local/api/admin/schema-fields/table-demo-orders-customer-id",
        {
          method: "PATCH",
          body: JSON.stringify({ queryable: true })
        }
      ),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "table-demo-orders-customer-id"
      }
    });

    expect(response.status).toBe(401);
  });

  it("rejects empty policy updates", async () => {
    const response = await onRequestPatch({
      request: await createAdminRequest({ label: "ignored" }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "table-demo-orders-customer-id"
      }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_schema_field_policy"
    });
  });

  it("returns storage_not_configured without D1", async () => {
    const response = await onRequestPatch({
      request: await createAdminRequest({ pii: true }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      params: {
        id: "table-demo-orders-customer-id"
      }
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "storage_not_configured"
    });
  });
});

async function createAdminRequest(body: Record<string, unknown>) {
  const cookie = await createCookie({
    provider: "google",
    providerId: "123",
    email: "owner@example.com",
    name: "Owner",
    role: "admin",
    expiresAt: Date.now() + 60_000
  });

  return new Request(
    "https://odap-gateway.local/api/admin/schema-fields/table-demo-orders-customer-id",
    {
      method: "PATCH",
      headers: {
        Cookie: cookie
      },
      body: JSON.stringify(body)
    }
  );
}

async function createCookie(session: AuthSession) {
  const token = await signAuthPayload(session, secret);
  return createSessionCookie(token, true);
}
