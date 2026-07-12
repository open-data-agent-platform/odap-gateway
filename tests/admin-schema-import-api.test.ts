import { describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../functions/api/admin/schema-import";
import {
  createSessionCookie,
  signAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("admin schema import API", () => {
  it("requires an admin session", async () => {
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.local/api/admin/schema-import", {
        method: "POST",
        body: JSON.stringify({
          workspace: "demo",
          dataset: "demo_dataset"
        })
      }),
      env: {
        AUTH_COOKIE_SECRET: secret
      }
    });

    expect(response.status).toBe(401);
  });

  it("requires D1 persistence before querying BigQuery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await onRequestPost({
      request: await createAdminRequest({
        workspace: "demo",
        dataset: "demo_dataset"
      }),
      env: {
        AUTH_COOKIE_SECRET: secret,
        BIGQUERY_PROJECT_ID: "demo-project",
        BIGQUERY_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
        BIGQUERY_PRIVATE_KEY: "not-used-without-d1"
      }
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "storage_not_configured"
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

  return new Request("https://odap-gateway.local/api/admin/schema-import", {
    method: "POST",
    headers: {
      Cookie: cookie
    },
    body: JSON.stringify(body)
  });
}

async function createCookie(session: AuthSession) {
  const token = await signAuthPayload(session, secret);
  return createSessionCookie(token, true);
}
