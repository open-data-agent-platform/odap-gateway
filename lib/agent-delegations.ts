import { canonicalControlJson } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import type { D1Database } from "./d1";
import { delegationHistory } from "./delegation-history";

type Challenge = { audience: string; tenantId: string; delegationId: string; grantId: string; requesterId: string;
  requestId: string; agentId: string; keyId: string; releaseId: string; actionDigest: string; policyRevision: string;
  projectId: string; location: string; expiresAt: string };
const fields = `d.audience,d.tenant_id AS tenantId,d.delegation_id AS delegationId,d.grant_id AS grantId,
  d.requester_id AS requesterId,d.request_id AS requestId,d.requested_agent_id AS agentId,d.key_id AS keyId,
  d.release_id AS releaseId,d.action_digest AS actionDigest,d.policy_revision AS policyRevision,
  d.project_id AS projectId,d.location,d.expires_at AS expiresAt`;
const unused = `NOT EXISTS (SELECT 1 FROM agent_delegation_proofs p WHERE p.tenant_id=d.tenant_id AND p.delegation_id=d.delegation_id)`;
const challengeText = (scope: Challenge) => canonicalControlJson({ purpose: "odap.gateway.contract-delegation-proof.v1", ...scope });

export async function readOwnDelegation({ db, tenantId, principalId }: ControlAccess, audience: string, grantId: string) {
  // Historical proof and revocation survive loss of eligibility; current membership still gates the read.
  const row = await db.prepare(`SELECT d.tenant_id AS tenantId,d.grant_id AS grantId,g.request_id AS requestId,
    d.id AS delegationId,d.agent_id AS agentId,d.key_id AS keyId,g.expires_at AS expiresAt,
    p.verified_at AS verifiedAt,d.revoked_at AS revokedAt FROM agent_delegations d
    JOIN contract_human_grants g ON g.tenant_id=d.tenant_id AND g.id=d.grant_id
    JOIN control_memberships m ON m.tenant_id=g.tenant_id AND m.principal_id=g.requester_id
    LEFT JOIN agent_delegation_proofs p ON p.tenant_id=d.tenant_id AND p.delegation_id=d.id
    WHERE d.tenant_id=? AND d.grant_id=? AND d.audience=? AND g.requester_id=? AND m.active=1
      AND m.role IN ('reader','reviewer','owner')`).bind(tenantId, grantId, audience, principalId).first();
  if (!row) return null;
  const snapshot = delegationHistory(row, tenantId, grantId);
  if (!snapshot) throw new Error("Invalid stored delegation");
  return snapshot;
}

export async function createDelegation(access: ControlAccess, audience: string, grantId: string, agentId: string, keyId: string) {
  const { db, tenantId, principalId } = access;
  // The random, database-bound delegation ID is also the single-use challenge nonce.
  const write = await db.prepare(`INSERT INTO agent_delegations(tenant_id,id,grant_id,audience,agent_id,key_id)
    SELECT g.tenant_id,?,g.grant_id,?,k.agent_id,k.key_id FROM current_delegable_grants g
    JOIN agent_verification_keys k ON k.tenant_id=g.tenant_id AND k.agent_id=g.requested_agent_id AND k.active=1
    WHERE g.tenant_id=? AND g.requester_id=? AND g.grant_id=? AND k.agent_id=? AND k.key_id=?`)
    .bind(crypto.randomUUID(), audience, tenantId, principalId, grantId, agentId, keyId).run();
  if (write.success !== true) throw new Error("Delegation storage unavailable");
  const scope = await db.prepare(`SELECT ${fields} FROM current_agent_delegations d WHERE d.tenant_id=? AND d.requester_id=?
    AND d.grant_id=? AND d.requested_agent_id=? AND d.key_id=? AND d.audience=? AND ${unused}`)
    .bind(tenantId, principalId, grantId, agentId, keyId, audience).first<Challenge>();
  return scope && { delegationId: scope.delegationId, expiresAt: scope.expiresAt, challenge: challengeText(scope) };
}

export async function revokeDelegation(access: ControlAccess, audience: string, id: string) {
  // A requester can revoke even after proof, expiry, key disablement or policy drift.
  const owned = `tenant_id=? AND audience=? AND id=? AND EXISTS (
      SELECT 1 FROM contract_human_grants g JOIN control_memberships m ON m.tenant_id=g.tenant_id AND m.principal_id=g.requester_id
      WHERE g.tenant_id=agent_delegations.tenant_id AND g.id=agent_delegations.grant_id AND m.principal_id=? AND m.active=1)`;
  const args = [access.tenantId, audience, id, access.principalId];
  const row = await access.db.prepare(`UPDATE agent_delegations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE ${owned} AND revoked_at IS NULL RETURNING revoked_at AS revokedAt`).bind(...args).first<{ revokedAt: string }>();
  return row ?? access.db.prepare(`SELECT revoked_at AS revokedAt FROM agent_delegations WHERE ${owned} AND revoked_at IS NOT NULL`)
    .bind(...args).first<{ revokedAt: string }>();
}

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16));
export async function proveDelegation(db: D1Database, audience: string, tenant: string, id: string, signature: string) {
  if (signature.length !== 128 || !/^[0-9a-f]+$/.test(signature)) return null;
  const filter = `FROM current_agent_delegations d WHERE d.tenant_id=? AND d.audience=? AND d.delegation_id=? AND ${unused}`;
  const row = await db.prepare(`SELECT ${fields},d.public_hex AS publicHex ${filter}`).bind(tenant, audience, id)
    .first<Challenge & { publicHex: string }>();
  if (!row) return null;
  const { publicHex, ...scope } = row;
  const key = await crypto.subtle.importKey("raw", bytes(publicHex), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(signature),
    new TextEncoder().encode(challengeText(scope)))) return null;
  // Signature verification is asynchronous. Recheck all mutable authority at the claim, not only at the read.
  return db.prepare(`INSERT INTO agent_delegation_proofs(tenant_id,delegation_id) SELECT d.tenant_id,d.delegation_id
    ${filter} AND d.public_hex=? RETURNING delegation_id AS delegationId,verified_at AS verifiedAt`)
    .bind(tenant, audience, id, publicHex).first<{ delegationId: string; verifiedAt: string }>();
}
