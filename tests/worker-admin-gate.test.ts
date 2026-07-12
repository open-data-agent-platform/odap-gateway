import { describe, expect, it } from "vitest";
import worker from "../worker";
import {
  createSessionCookie,
  signAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("worker admin gate", () => {
  it("keeps public health response free of deployment internals", async () => {
    const response = await worker.fetch(
      new Request("https://odap-gateway.local/api/health"),
      {
        AUTH_COOKIE_SECRET: secret,
        ASSETS: {
          fetch: async () => new Response("asset")
        }
      },
      {
        waitUntil: () => undefined
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "odap-gateway"
    });
  });

  it("requires admin auth for detailed health metadata", async () => {
    const response = await worker.fetch(
      new Request("https://odap-gateway.local/api/admin/health"),
      {
        AUTH_COOKIE_SECRET: secret,
        ASSETS: {
          fetch: async () => new Response("asset")
        }
      },
      {
        waitUntil: () => undefined
      }
    );

    expect(response.status).toBe(401);
  });

  it.each(["/admin", "/admin.html", "/admin.txt"])(
    "redirects unauthenticated admin asset requests for %s",
    async (pathname) => {
      const response = await worker.fetch(
        new Request(`https://odap-gateway.local${pathname}`),
        {
          AUTH_COOKIE_SECRET: secret,
          ASSETS: {
            fetch: async () => new Response("asset")
          }
        },
        {
          waitUntil: () => undefined
        }
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("location")).toContain(
        "/login?returnTo=%2Fadmin"
      );
    }
  );

  it("routes admin schema import requests through the worker API table", async () => {
    const cookie = await createCookie({
      provider: "google",
      providerId: "123",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      expiresAt: Date.now() + 60_000
    });
    const response = await worker.fetch(
      new Request("https://odap-gateway.local/api/admin/schema-import", {
        method: "POST",
        headers: {
          Cookie: cookie
        },
        body: JSON.stringify({
          workspace: "demo",
          dataset: "demo_dataset"
        })
      }),
      {
        AUTH_COOKIE_SECRET: secret,
        BIGQUERY_PROJECT_ID: "demo-project",
        BIGQUERY_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
        BIGQUERY_PRIVATE_KEY: "not-used-without-d1",
        ASSETS: {
          fetch: async () => new Response("asset")
        }
      },
      {
        waitUntil: () => undefined
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "storage_not_configured"
    });
  });
});

async function createCookie(session: AuthSession) {
  const token = await signAuthPayload(session, secret);

  return createSessionCookie(token, true);
}
