import { canonicalControlJson } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import type { D1Database } from "./d1";
import { routeId } from "./control-command-request";

export type PostgresAgentOperation = "execute" | "inspect";
type ScopeRow = {
  tenant_id: string; id: string; requester_id: string; release_id: string; source_id: string;
  contract_id: string; action_digest: string; statement_digest: string; definition_digest: string;
  connection_digest: string; role_name: string; budget_id: string; target: string; expires_at: string;
  delegation_id: string; agent_id: string; key_id: string; audience: string; public_hex: string;
};
declare const proofBrand: unique symbol;
export type PostgresAgentProof = { readonly [proofBrand]: true };
const verified = new WeakMap<PostgresAgentProof, { db: D1Database; row: ScopeRow; operation: PostgresAgentOperation }>();
function denied(): never { throw new Error("PostgreSQL agent operation unavailable"); }
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !routeId.test(value)) denied();
}
export function postgresAgentAudience(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) denied();
  return value;
}
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16));

function challenge(row: ScopeRow, operation: PostgresAgentOperation) {
  return canonicalControlJson({ purpose: "odap.postgresql.agent-" + operation + ".v1",
    audience: row.audience, tenantId: row.tenant_id, delegationId: row.delegation_id,
    requesterId: row.requester_id, agentId: row.agent_id, keyId: row.key_id, requestId: row.id,
    releaseId: row.release_id, sourceId: row.source_id, contractId: row.contract_id,
    actionDigest: row.action_digest, statementDigest: row.statement_digest, definitionDigest: row.definition_digest,
    connectionDigest: row.connection_digest, role: row.role_name, budgetId: row.budget_id,
    target: row.target, expiresAt: row.expires_at });
}

export async function delegatePostgresRead(access: ControlAccess, audience: string, input: {
  requestId: string; agentId: string; keyId: string;
}) {
  for (const value of Object.values(input)) id(value);
  postgresAgentAudience(audience);
  const row = await access.db.prepare(`INSERT INTO postgresql_agent_delegations
    (tenant_id,id,request_id,requester_id,agent_id,key_id,audience)
    SELECT q.tenant_id,?,q.id,q.requester_id,?,?,? FROM postgresql_current_requests q
    WHERE q.tenant_id=? AND q.id=? AND q.requester_id=? RETURNING id AS delegationId,expires_at AS expiresAt`)
    .bind(crypto.randomUUID(), input.agentId, input.keyId, audience, access.tenantId, input.requestId, access.principalId)
    .first<{ delegationId: string; expiresAt: string }>();
  return row ?? denied();
}

export async function revokePostgresDelegation(access: ControlAccess, audience: string, delegationId: string) {
  id(delegationId); postgresAgentAudience(audience);
  const filter = `tenant_id=? AND id=? AND audience=? AND requester_id=? AND EXISTS(
    SELECT 1 FROM control_memberships m WHERE m.tenant_id=postgresql_agent_delegations.tenant_id
      AND m.principal_id=postgresql_agent_delegations.requester_id AND m.active=1)`;
  const args = [access.tenantId, delegationId, audience, access.principalId];
  const row = await access.db.prepare(`UPDATE postgresql_agent_delegations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE ${filter} AND revoked_at IS NULL RETURNING revoked_at AS revokedAt`).bind(...args).first() ??
    await access.db.prepare(`SELECT revoked_at AS revokedAt FROM postgresql_agent_delegations
      WHERE ${filter} AND revoked_at IS NOT NULL`).bind(...args).first();
  return row ?? denied();
}

export async function postgresAgentChallenges(access: ControlAccess, audience: string, delegationId: string) {
  id(delegationId); postgresAgentAudience(audience);
  const row = await access.db.prepare(`SELECT * FROM postgresql_agent_scopes
    WHERE tenant_id=? AND audience=? AND delegation_id=? AND requester_id=?`)
    .bind(access.tenantId, audience, delegationId, access.principalId).first<ScopeRow>();
  if (!row) denied();
  return { delegationId, expiresAt: row.expires_at, execute: challenge(row, "execute"), inspect: challenge(row, "inspect") };
}

export async function verifyPostgresAgent(db: D1Database, audience: string, tenantId: string,
  delegationId: string, signature: string, operation: PostgresAgentOperation) {
  id(tenantId); id(delegationId); postgresAgentAudience(audience);
  if (!["execute", "inspect"].includes(operation) || typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) denied();
  const row = await db.prepare(`SELECT s.* FROM postgresql_agent_scopes s
    WHERE s.tenant_id=? AND s.audience=? AND s.delegation_id=? ${operation === "execute" ?
    "AND EXISTS(SELECT 1 FROM postgresql_claimable_reads q WHERE q.tenant_id=s.tenant_id AND q.id=s.id AND q.delegation_id=s.delegation_id)" : ""}`)
    .bind(tenantId, audience, delegationId).first<ScopeRow>();
  if (!row) denied();
  const key = await crypto.subtle.importKey("raw", hexBytes(row.public_hex), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, hexBytes(signature),
    new TextEncoder().encode(challenge(row, operation)))) denied();
  const proof = Object.freeze({}) as PostgresAgentProof;
  verified.set(proof, { db, row, operation });
  return { access: { db, tenantId, principalId: row.requester_id }, requestId: row.id, proof };
}

// Only an object created by real signature verification can authorize a delegated claim.
// The final SQL still rechecks revocation/key/membership/expiry after verification.
export function postgresAgentBinding(access: ControlAccess, row: { delegation_id?: string | null }, proof?: PostgresAgentProof) {
  if (!row.delegation_id) { if (proof) denied(); return { delegationId: null, publicHex: null }; }
  const bound = proof && verified.get(proof);
  if (!bound || bound.operation !== "execute" || bound.db !== access.db || bound.row.tenant_id !== access.tenantId ||
      bound.row.requester_id !== access.principalId || challenge(bound.row, "execute") !== challenge(row as ScopeRow, "execute") ||
      bound.row.public_hex !== (row as ScopeRow).public_hex) denied();
  return { delegationId: bound.row.delegation_id, publicHex: bound.row.public_hex };
}

export async function inspectPostgresAgent(access: ControlAccess, proof: PostgresAgentProof) {
  const bound = verified.get(proof);
  if (!bound || bound.operation !== "inspect" || bound.db !== access.db || bound.row.tenant_id !== access.tenantId ||
      bound.row.requester_id !== access.principalId) denied();
  // Same-statement current key/consent gate, not a reusable authorization boolean.
  const row = await access.db.prepare(`SELECT q.id AS requestId,q.delegation_id AS delegationId,q.agent_id AS agentId,
    q.contract_id AS contractId,c.intent_id AS intentId,o.outcome,s.stopped_at AS stoppedAt
    FROM postgresql_agent_scopes q
    LEFT JOIN postgresql_read_claims c ON c.tenant_id=q.tenant_id AND c.request_id=q.id
    LEFT JOIN postgresql_read_observations o ON o.tenant_id=q.tenant_id AND o.request_id=q.id
    LEFT JOIN postgresql_read_stops s ON s.tenant_id=q.tenant_id AND s.request_id=q.id
    WHERE q.tenant_id=? AND q.delegation_id=? AND q.audience=? AND q.public_hex=? AND q.contract_id=?`)
    .bind(access.tenantId, bound.row.delegation_id, bound.row.audience, bound.row.public_hex, bound.row.contract_id)
    .first<{ requestId: string; delegationId: string; agentId: string; contractId: string;
      intentId: string | null; outcome: string | null; stoppedAt: string | null }>();
  if (!row) denied();
  return { ...row, state: row.outcome ?? (row.intentId ? "observation-required" : row.stoppedAt ? "stopped-before-claim" : "not-submitted"),
    monetaryCost: "unpriced", receiptIds: row.intentId ? ["pg-pending-" + row.intentId, ...(row.outcome ? ["pg-observed-" + row.intentId] : [])] : [] };
}
