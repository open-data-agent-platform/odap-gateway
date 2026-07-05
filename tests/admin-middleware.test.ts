import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/_middleware";
import {
  createSessionCookie,
  signAuthPayload,
  type AuthSession
} from "../lib/auth";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("admin middleware", () => {
  it("redirects unauthenticated admin page requests to login", async () => {
    const response = await onRequest({
      request: new Request("https://odap-gateway.example/admin"),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      next: async () => new Response("ok")
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/login");
  });

  it("rejects signed-in non-admin members", async () => {
    const cookie = await createCookie({
      provider: "google",
      providerId: "123",
      email: "member@example.com",
      name: "Member",
      role: "member",
      expiresAt: Date.now() + 60_000
    });

    const response = await onRequest({
      request: new Request("https://odap-gateway.example/admin", {
        headers: {
          Cookie: cookie
        }
      }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      next: async () => new Response("ok")
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "admin_required"
    });
  });

  it("allows admin sessions through to the static page", async () => {
    const cookie = await createCookie({
      provider: "github",
      providerId: "456",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      expiresAt: Date.now() + 60_000
    });

    const response = await onRequest({
      request: new Request("https://odap-gateway.example/admin", {
        headers: {
          Cookie: cookie
        }
      }),
      env: {
        AUTH_COOKIE_SECRET: secret
      },
      next: async () => new Response("ok")
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });
});

async function createCookie(session: AuthSession) {
  const token = await signAuthPayload(session, secret);
  return createSessionCookie(token, true);
}
