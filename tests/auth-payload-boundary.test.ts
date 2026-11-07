import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signAuthPayload, verifyAuthPayload, type AuthSession, type OAuthState } from "../lib/auth";

const secret = "synthetic-auth-payload-boundary";
const now = 1_800_000_000_000;
const session: AuthSession = { provider: "google", providerId: "fixture",
  email: "fixture@example.test", name: "Fixture", role: "member", expiresAt: now + 60_000 };
const state: OAuthState = { provider: "google", nonce: "00000000-0000-4000-8000-000000000001",
  returnTo: "/", expiresAt: now + 60_000 };

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); });

describe("signed authentication payload admission", () => {
  it.each([
    ["numeric string", String(now + 60_000)],
    ["non-numeric string", "never"],
    ["array", [now + 60_000]],
    ["object", {}],
    ["fractional timestamp", now + 0.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects a correctly signed %s expiry", async (_label, expiresAt) => {
    // The signer is deliberately given malformed data to exercise verification,
    // not to claim an attacker can manufacture a valid signature.
    const token = await signAuthPayload({ ...session, expiresAt } as AuthSession, secret);
    await expect(verifyAuthPayload(token, secret)).resolves.toBeNull();
  });

  it.each([0, -1])("expires at the exact deadline or later: %i ms", async delta => {
    const token = await signAuthPayload({ ...session, expiresAt: now + delta }, secret);
    await expect(verifyAuthPayload(token, secret)).resolves.toBeNull();
  });

  it.each([{ kind: "session", payload: session }, { kind: "OAuth state", payload: state }])(
    "preserves a valid $kind payload before expiry", async ({ payload }) => {
    const value = { ...payload, expiresAt: now + 1 };
    await expect(verifyAuthPayload(await signAuthPayload(value, secret), secret)).resolves.toEqual(value);
  });

  it.each([".", ".extra", ".extra.more"])("rejects appended token segments: %s", async suffix => {
    const token = await signAuthPayload(session, secret);
    await expect(verifyAuthPayload(token + suffix, secret)).resolves.toBeNull();
  });

  it.each([undefined, "", "payload", ".signature", "payload."])("refuses missing token segments: %s", async token => {
    await expect(verifyAuthPayload(token, secret)).resolves.toBeNull();
  });
});
