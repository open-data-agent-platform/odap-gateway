import { beforeAll, expect, it } from "vitest";
import { canonicalControlJson } from "../lib/control-objects";
import { signPostgresAgentCommand, type PostgresAgentScope } from "../integrations/postgresql/agent";

let keys: CryptoKeyPair;
beforeAll(async () => { keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); });
const scope: PostgresAgentScope = { audience: "https://gateway.test", tenantId: "tenant-a", delegationId: "delegation", requesterId: "google:reader",
  agentId: "agent", keyId: "key", requestId: "request", releaseId: "release", sourceId: "source", contractId: "contract",
  actionDigest: "sha256:" + "a".repeat(64), statementDigest: "sha256:" + "b".repeat(64), definitionDigest: "sha256:" + "c".repeat(64),
  connectionDigest: "sha256:" + "d".repeat(64), role: "reader_a", budgetId: "budget", target: "orders", expiresAt: "2099-01-01T00:00:00.000Z" };
const text = (s = scope, operation = "execute") => canonicalControlJson({ purpose: "odap.postgresql.agent-" + operation + ".v1", ...s });
it.each(["execute", "inspect"] as const)("signs only exact trusted %s terms with P-256", async operation => {
  const result = await signPostgresAgentCommand(text(scope, operation), scope, operation, keys.privateKey);
  expect(result.delegationId).toBe(scope.delegationId); expect(result.signature).toMatch(/^[0-9a-f]{128}$/);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey,
    Buffer.from(result.signature, "hex"), new TextEncoder().encode(text(scope, operation)))).toBe(true);
});
it.each(["audience", "tenantId", "requesterId", "agentId", "requestId", "sourceId", "contractId", "actionDigest", "expiresAt"] as const)(
  "refuses signing a substituted %s", async field => {
    await expect(signPostgresAgentCommand(text({ ...scope, [field]: "substituted" }), scope, "execute", keys.privateKey)).rejects.toThrow();
  });
it("rejects another operation, expired consent, noncanonical bytes, insecure audience and public keys", async () => {
  await expect(signPostgresAgentCommand(text(scope, "inspect"), scope, "execute", keys.privateKey)).rejects.toThrow();
  await expect(signPostgresAgentCommand(text(), scope, "execute", keys.publicKey)).rejects.toThrow();
  await expect(signPostgresAgentCommand(" " + text(), scope, "execute", keys.privateKey)).rejects.toThrow();
  const expired = { ...scope, expiresAt: "2000-01-01T00:00:00.000Z" };
  await expect(signPostgresAgentCommand(text(expired), expired, "execute", keys.privateKey)).rejects.toThrow();
  const insecure = { ...scope, audience: "http://gateway.test" };
  await expect(signPostgresAgentCommand(text(insecure), insecure, "execute", keys.privateKey)).rejects.toThrow();
});
it("refuses extra signing fields, including a purpose override", async () => {
  const extra = { ...scope, purpose: "odap.postgresql.agent-inspect.v1" };
  await expect(signPostgresAgentCommand(canonicalControlJson(extra), extra, "execute", keys.privateKey)).rejects.toThrow();
});
