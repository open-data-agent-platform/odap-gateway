import { canonicalControlJson, isControlTimestamp } from "../../lib/control-objects";
import { exactFields } from "../../lib/control-command-request";

export type PostgresAgentScope = Readonly<{
  audience: string; tenantId: string; delegationId: string; requesterId: string; agentId: string; keyId: string;
  requestId: string; releaseId: string; sourceId: string; contractId: string; actionDigest: string;
  statementDigest: string; definitionDigest: string; connectionDigest: string; role: string;
  budgetId: string; target: string; expiresAt: string;
}>;

/** Compare independently trusted consent terms before signing. Never derive expected
 * terms merely by parsing the same untrusted challenge. Private keys stay in the host.
 */
export async function signPostgresAgentCommand(challenge: string, expected: PostgresAgentScope,
  operation: "execute" | "inspect", privateKey: CryptoKey) {
  if (!exactFields(expected, ["audience", "tenantId", "delegationId", "requesterId", "agentId", "keyId", "requestId", "releaseId",
    "sourceId", "contractId", "actionDigest", "statementDigest", "definitionDigest", "connectionDigest", "role", "budgetId", "target", "expiresAt"]) ||
      !Object.values(expected).every(value => typeof value === "string" && value.length > 0) ||
      !["execute", "inspect"].includes(operation) || new URL(expected.audience).origin !== expected.audience ||
      !expected.audience.startsWith("https://") || !isControlTimestamp(expected.expiresAt) || Date.parse(expected.expiresAt) <= Date.now() ||
      typeof challenge !== "string" || challenge.length > 8192 ||
      canonicalControlJson({ purpose: "odap.postgresql.agent-" + operation + ".v1", ...expected }) !== challenge ||
      privateKey.type !== "private" || privateKey.algorithm.name !== "ECDSA" ||
      (privateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" || !privateKey.usages.includes("sign")) {
    throw new Error("PostgreSQL Agent consent does not match signing request");
  }
  const bytes = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(challenge)));
  if (bytes.length !== 64) throw new Error("Unexpected PostgreSQL Agent signature format");
  return { delegationId: expected.delegationId, signature: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") };
}
