import { canonicalControlJson, isSemanticRelease, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { compilePostgresMetric, type PostgresSource } from "./postgresql-metric-compiler";
import { exactFields, routeId } from "./control-command-request";
import { promoteSemanticRevision, retireSemanticRelease } from "./semantic-candidate-storage";
import { postgresAgentAudience, postgresAgentBinding, type PostgresAgentProof } from "./postgresql-agent";

export class PostgresControlDenied extends Error {
  constructor() { super("PostgreSQL control operation unavailable"); }
}
export function postgresControlId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !routeId.test(value)) throw new PostgresControlDenied();
}
const label = (v: unknown, max = 1024): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && v.trim() === v && !v.includes("\0");
function required<T>(v: T | null): T { if (!v) throw new PostgresControlDenied(); return v; }

export type PostgresControlRead = {
  tenant_id: string; target: string; expires_at: string;
  delegation_id: string | null; agent_id: string | null; key_id: string | null; audience: string | null; public_hex: string | null;
  id: string; source_id: string; release_id: string; requester_id: string; owner_id: string;
  connection_ref: string; connection_digest: string; source_json: string; role_name: string; budget_id: string;
  release_json: string; definition_json: string; definition_digest: string;
  action_json: string; action_digest: string; statement_digest: string; contract_id: string;
};

// Trusted catalog rows contain no passwords. The authenticated caller cannot register sources.
export async function readPostgresSource(access: ControlAccess, sourceId: string) {
  postgresControlId(sourceId);
  return required(await access.db.prepare(`SELECT s.* FROM postgresql_current_sources s
    JOIN control_memberships m ON m.tenant_id=s.tenant_id AND m.principal_id=? AND m.active=1
    WHERE s.tenant_id=? AND s.id=?`).bind(access.principalId, access.tenantId, sourceId)
    .first<{ id: string; target: string; owner_id: string; source_json: string }>());
}

export async function proposePostgresRevision(access: ControlAccess, input: {
  revisionId: string; provenanceRef: string; definition: unknown;
}) {
  postgresControlId(input.revisionId);
  if (!label(input.provenanceRef)) throw new PostgresControlDenied();
  const json = canonicalControlJson(input.definition);
  if (json.length > 32768) throw new PostgresControlDenied();
  const d = JSON.parse(json);
  const source = await readPostgresSource(access, d.sourceRevision);
  const digest = await sha256Text(json);
  const parameters = Object.fromEntries(Object.keys(d.filters ?? {}).map(name => [name, null]));
  await compilePostgresMetric({ schemaVersion: "0.1", id: input.revisionId, tenantId: access.tenantId,
    sourceRevision: source.id, owner: source.owner_id, state: "released", definitionDigest: digest }, json,
  canonicalControlJson({ profile: "odap.metric-read.v1", target: source.target, metricId: d.metricId, parameters }),
  JSON.parse(source.source_json));
  required(await access.db.prepare(`INSERT INTO semantic_candidate_revisions
    (tenant_id,id,definition_json,definition_digest,owner_id,provenance_ref,proposed_by)
    SELECT s.tenant_id,?,?,?,s.owner_id,?,m.principal_id FROM postgresql_current_sources s
    JOIN control_memberships m ON m.tenant_id=s.tenant_id AND m.principal_id=? AND m.active=1 AND m.role IN ('owner','reviewer')
    WHERE s.tenant_id=? AND s.id=? AND s.owner_id=? AND s.source_json=?
    RETURNING id`).bind(input.revisionId, json, digest, input.provenanceRef, access.principalId,
    access.tenantId, source.id, source.owner_id, source.source_json).first());
  return { revisionId: input.revisionId, definitionDigest: digest };
}

export async function reviewPostgresRevision(access: ControlAccess, revisionId: string) {
  postgresControlId(revisionId);
  const row = required(await access.db.prepare(`SELECT r.definition_json,r.definition_digest,r.owner_id,r.provenance_ref
    FROM semantic_candidate_revisions r JOIN postgresql_current_sources s
      ON s.tenant_id=r.tenant_id AND s.id=json_extract(r.definition_json,'$.sourceRevision') AND s.owner_id=r.owner_id
    JOIN control_memberships m ON m.tenant_id=r.tenant_id AND m.principal_id=? AND m.active=1 AND m.role IN ('owner','reviewer')
    WHERE r.tenant_id=? AND r.id=? AND json_extract(r.definition_json,'$.profile')='odap.postgresql-metric.v1'`)
    .bind(access.principalId, access.tenantId, revisionId)
    .first<{ definition_json: string; definition_digest: string; owner_id: string; provenance_ref: string }>());
  if (canonicalControlJson(JSON.parse(row.definition_json)) !== row.definition_json ||
      await sha256Text(row.definition_json) !== row.definition_digest) throw new PostgresControlDenied();
  return row;
}

export async function validatePostgresRevision(access: ControlAccess, input: {
  revisionId: string; reviewedDigest: string; evidenceRef: string;
}) {
  if (!label(input.evidenceRef)) throw new PostgresControlDenied();
  const r = await reviewPostgresRevision(access, input.revisionId);
  if (r.definition_digest !== input.reviewedDigest || r.owner_id !== access.principalId) throw new PostgresControlDenied();
  required(await access.db.prepare(`INSERT INTO semantic_candidate_validations
    (tenant_id,revision_id,definition_digest,validated_by,evidence_ref)
    SELECT s.tenant_id,?,?,s.owner_id,? FROM postgresql_current_sources s
    WHERE s.tenant_id=? AND s.id=? AND s.owner_id=? RETURNING revision_id`)
    .bind(input.revisionId, r.definition_digest, input.evidenceRef, access.tenantId,
      JSON.parse(r.definition_json).sourceRevision, access.principalId).first());
  return { revisionId: input.revisionId, validated: true };
}

export async function approvePostgresRevision(access: ControlAccess, input: {
  approvalId: string; revisionId: string; reviewedDigest: string; evidenceRef: string;
}) {
  postgresControlId(input.approvalId);
  const r = await reviewPostgresRevision(access, input.revisionId);
  if (r.definition_digest !== input.reviewedDigest || r.owner_id !== access.principalId) throw new PostgresControlDenied();
  required(await access.db.prepare(`INSERT INTO semantic_candidate_approvals(tenant_id,id,revision_id,approved_by)
    SELECT v.tenant_id,?,v.revision_id,v.validated_by FROM semantic_candidate_validations v
    JOIN postgresql_current_sources s ON s.tenant_id=v.tenant_id AND s.id=? AND s.owner_id=v.validated_by
    WHERE v.tenant_id=? AND v.revision_id=? AND v.definition_digest=? AND v.evidence_ref=? AND v.validated_by=? RETURNING id`)
    .bind(input.approvalId, JSON.parse(r.definition_json).sourceRevision, access.tenantId, input.revisionId,
      input.reviewedDigest, input.evidenceRef, access.principalId).first());
  return { approvalId: input.approvalId };
}

export async function promotePostgresRevision(access: ControlAccess, input: {
  releaseId: string; approvalId: string; revisionId: string;
}) {
  for (const id of Object.values(input)) postgresControlId(id);
  await reviewPostgresRevision(access, input.revisionId);
  return promoteSemanticRevision(access, input);
}

export async function previewPostgresRead(access: ControlAccess, releaseId: string, action: unknown) {
  postgresControlId(releaseId);
  const row = required(await access.db.prepare(`SELECT r.* FROM postgresql_available_releases r
    JOIN control_memberships m ON m.tenant_id=r.tenant_id AND m.principal_id=? AND m.active=1
    WHERE r.tenant_id=? AND r.release_id=?`).bind(access.principalId, access.tenantId, releaseId)
    .first<Omit<PostgresControlRead, "action_json" | "action_digest" | "statement_digest" | "contract_id" | "requester_id" | "source_id">>());
  const release: unknown = JSON.parse(row.release_json);
  if (!isSemanticRelease(release)) throw new PostgresControlDenied();
  const actionJson = canonicalControlJson(action);
  const compiled = await compilePostgresMetric(release, row.definition_json, actionJson, JSON.parse(row.source_json));
  return { row, release, compiled, actionJson };
}

export async function requestPostgresRead(access: ControlAccess, input: { requestId: string; releaseId: string; action: unknown }) {
  postgresControlId(input.requestId);
  const { row, compiled, actionJson } = await previewPostgresRead(access, input.releaseId, input.action);
  required(await access.db.prepare(`INSERT INTO postgresql_read_requests
    (tenant_id,id,requester_id,release_id,source_id,action_json,action_digest,statement_digest)
    SELECT r.tenant_id,?,m.principal_id,r.release_id,r.id,?,?,? FROM postgresql_available_releases r
    JOIN control_memberships m ON m.tenant_id=r.tenant_id AND m.principal_id=? AND m.active=1
    WHERE r.tenant_id=? AND r.release_id=? AND r.id=? AND r.definition_digest=? RETURNING id`)
    .bind(input.requestId, actionJson, compiled.actionDigest, compiled.statementDigest, access.principalId,
      access.tenantId, input.releaseId, row.id, compiled.definitionDigest).first());
  return { requestId: input.requestId, actionDigest: compiled.actionDigest, state: "awaiting-approval" as const };
}

// This read remains available for recovery after expiry, stop, retirement or source drift.
export async function inspectPostgresRead(access: ControlAccess, requestId: string) {
  postgresControlId(requestId);
  const row = required(await access.db.prepare(`SELECT q.id,q.requester_id,q.release_id,q.source_id,q.action_json,q.action_digest,
    a.contract_id,CASE WHEN d.id IS NULL THEN a.expires_at ELSE min(a.expires_at,d.expires_at) END AS expires_at,
    c.intent_id,c.claimed_at,o.outcome,s.stopped_at,
    d.id AS delegation_id,d.agent_id,d.key_id,d.audience,d.expires_at AS delegation_expires_at,d.revoked_at AS delegation_revoked_at,
    b.limit_attempts,(SELECT count(*) FROM postgresql_read_claims used WHERE used.tenant_id=q.tenant_id AND used.budget_id=v.budget_id) AS used_attempts
    FROM postgresql_read_requests q JOIN postgresql_source_versions v ON v.tenant_id=q.tenant_id AND v.id=q.source_id
    JOIN postgresql_read_budgets b ON b.tenant_id=v.tenant_id AND b.id=v.budget_id
    JOIN control_memberships m ON m.tenant_id=q.tenant_id AND m.principal_id=? AND m.active=1
      AND (m.principal_id=q.requester_id OR (m.principal_id=v.owner_id AND m.role='owner'))
    LEFT JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id
    LEFT JOIN postgresql_read_claims c ON c.tenant_id=q.tenant_id AND c.request_id=q.id
    LEFT JOIN postgresql_read_observations o ON o.tenant_id=q.tenant_id AND o.request_id=q.id
    LEFT JOIN postgresql_read_stops s ON s.tenant_id=q.tenant_id AND s.request_id=q.id
    LEFT JOIN postgresql_agent_delegations d ON d.tenant_id=q.tenant_id AND d.request_id=q.id
    WHERE q.tenant_id=? AND q.id=?`).bind(access.principalId, access.tenantId, requestId)
    .first<{ id: string; requester_id: string; release_id: string; source_id: string; action_json: string; action_digest: string;
      contract_id: string | null; expires_at: string | null; intent_id: string | null; claimed_at: string | null;
      delegation_id: string | null; agent_id: string | null; key_id: string | null; audience: string | null;
      delegation_expires_at: string | null; delegation_revoked_at: string | null;
      outcome: string | null; stopped_at: string | null; limit_attempts: number; used_attempts: number }>());
  return { ...row, budgetUnit: "read-attempt" as const, monetaryCost: "unpriced" as const,
    receiptIds: row.intent_id ? ["pg-pending-" + row.intent_id, ...(row.outcome ? ["pg-observed-" + row.intent_id] : [])] : [],
    state: row.outcome ?? (row.intent_id ? "observation-required" : row.stopped_at ? "stopped-before-claim" : "not-submitted") };
}

type PostgresApprovalInput = {
  requestId: string; releaseId: string; sourceId: string; requesterId: string; reviewedAction: unknown;
};
export async function approvePostgresRead(access: ControlAccess, input: PostgresApprovalInput) {
  return approveRead(access, input);
}
export async function approvePostgresAgentRead(access: ControlAccess, audience: string,
  input: PostgresApprovalInput & { delegationId: string; agentId: string; keyId: string }) {
  for (const value of [input.delegationId, input.agentId, input.keyId]) postgresControlId(value);
  return approveRead(access, input, { ...input, audience: postgresAgentAudience(audience) });
}
async function approveRead(access: ControlAccess, input: PostgresApprovalInput,
  agent?: { delegationId: string; agentId: string; keyId: string; audience: string }) {
  for (const id of [input.requestId, input.releaseId, input.sourceId]) postgresControlId(id);
  const actionJson = canonicalControlJson(input.reviewedAction);
  const digest = await sha256Text(actionJson), contractId = crypto.randomUUID();
  required(await access.db.prepare(`INSERT INTO postgresql_read_approvals(tenant_id,request_id,contract_id,approved_by,delegation_id)
    SELECT q.tenant_id,q.id,?,q.owner_id,? FROM postgresql_current_requests q
    WHERE q.tenant_id=? AND q.id=? AND q.release_id=? AND q.source_id=? AND q.requester_id=?
      AND q.action_json=? AND q.action_digest=? AND q.owner_id=? AND q.owner_id<>q.requester_id
      AND NOT EXISTS(SELECT 1 FROM postgresql_read_stops s WHERE s.tenant_id=q.tenant_id AND s.request_id=q.id)
      AND ${agent ? `EXISTS(SELECT 1 FROM postgresql_agent_delegations d WHERE d.tenant_id=q.tenant_id AND d.request_id=q.id
        AND d.id=? AND d.agent_id=? AND d.key_id=? AND d.audience=?)` :
    "NOT EXISTS(SELECT 1 FROM postgresql_agent_delegations d WHERE d.tenant_id=q.tenant_id AND d.request_id=q.id)"}
    RETURNING contract_id`).bind(contractId, agent?.delegationId ?? null, access.tenantId, input.requestId, input.releaseId, input.sourceId,
    input.requesterId, actionJson, digest, access.principalId,
    ...(agent ? [agent.delegationId, agent.agentId, agent.keyId, agent.audience] : [])).first());
  return { contractId };
}

export async function stopPostgresRead(access: ControlAccess, requestId: string) {
  postgresControlId(requestId);
  required(await access.db.prepare(`INSERT INTO postgresql_read_stops(tenant_id,request_id,stopped_by)
    SELECT q.tenant_id,q.id,m.principal_id FROM postgresql_read_requests q
    JOIN postgresql_source_versions s ON s.tenant_id=q.tenant_id AND s.id=q.source_id
    JOIN control_memberships m ON m.tenant_id=q.tenant_id AND m.active=1 AND m.principal_id=?
      AND (m.principal_id=q.requester_id OR (m.principal_id=s.owner_id AND m.role='owner'))
    WHERE q.tenant_id=? AND q.id=? RETURNING request_id`).bind(access.principalId, access.tenantId, requestId).first());
  return { requestId, status: "future-claim-blocked" as const, cancellationConfirmed: false };
}

export async function preparePostgresDispatch(access: ControlAccess, requestId: string, proof?: PostgresAgentProof) {
  postgresControlId(requestId);
  const row = required(await access.db.prepare(`SELECT * FROM postgresql_claimable_reads
    WHERE tenant_id=? AND id=? AND requester_id=?`).bind(access.tenantId, requestId, access.principalId).first<PostgresControlRead>());
  postgresAgentBinding(access, row, proof);
  const release: unknown = JSON.parse(row.release_json);
  if (!isSemanticRelease(release) || release.tenantId !== access.tenantId || release.id !== row.release_id ||
      release.owner !== row.owner_id || release.sourceRevision !== row.source_id) throw new PostgresControlDenied();
  const source: PostgresSource = JSON.parse(row.source_json);
  const compiled = await compilePostgresMetric(release, row.definition_json, row.action_json, source);
  if (compiled.actionDigest !== row.action_digest || compiled.definitionDigest !== row.definition_digest ||
      compiled.statementDigest !== row.statement_digest) throw new PostgresControlDenied();
  return { row, compiled, read: { release, source, definitionJson: row.definition_json, canonicalAction: row.action_json } };
}

// The claim rechecks the entire authority view in its atomic write, after PG preflight.
export async function claimPostgresRead(access: ControlAccess, row: PostgresControlRead, intentId: string, proof?: PostgresAgentProof) {
  postgresControlId(intentId);
  const agent = postgresAgentBinding(access, row, proof);
  const result = await access.db.prepare(`INSERT INTO postgresql_read_claims
    (tenant_id,request_id,intent_id,claimed_by,budget_id,statement_digest)
    SELECT q.tenant_id,q.id,?,q.requester_id,q.budget_id,q.statement_digest FROM postgresql_claimable_reads q
    WHERE q.tenant_id=? AND q.id=? AND q.requester_id=? AND q.source_id=? AND q.release_id=?
      AND q.connection_digest=? AND q.action_json=? AND q.action_digest=? AND q.definition_digest=?
      AND q.statement_digest=? AND q.contract_id=? AND q.delegation_id IS ? AND q.public_hex IS ? RETURNING intent_id`)
    .bind(intentId, access.tenantId, row.id, access.principalId, row.source_id, row.release_id,
      row.connection_digest, row.action_json, row.action_digest, row.definition_digest,
      row.statement_digest, row.contract_id, agent.delegationId, agent.publicHex).first<{ intent_id: string }>();
  return result?.intent_id === intentId;
}

// Internal observation API, not exposed as an HTTP/MCP operation or caller assertion.
export async function observePostgresRead(access: ControlAccess, requestId: string, intentId: string,
  outcome: "succeeded" | "observation-required") {
  const row = await access.db.prepare(`INSERT INTO postgresql_read_observations(tenant_id,request_id,intent_id,outcome)
    SELECT tenant_id,request_id,intent_id,? FROM postgresql_read_claims
    WHERE tenant_id=? AND request_id=? AND intent_id=? AND claimed_by=? RETURNING intent_id`)
    .bind(outcome, access.tenantId, requestId, intentId, access.principalId).first<{ intent_id: string }>();
  return row?.intent_id === intentId;
}

// Shared strict command dispatcher for both transports. Neither accepts an execution result.
export async function postgresControlCommand(access: ControlAccess, command: string, input: unknown) {
  const fields = (keys: string[]) => { if (!exactFields(input, keys)) throw new PostgresControlDenied(); return input; };
  switch (command) {
    case "propose": { const d = fields(["revisionId", "provenanceRef", "definition"]); return proposePostgresRevision(access, d as Parameters<typeof proposePostgresRevision>[1]); }
    case "review": return reviewPostgresRevision(access, fields(["revisionId"]).revisionId as string);
    case "validate": { const d = fields(["revisionId", "reviewedDigest", "evidenceRef"]); return validatePostgresRevision(access, d as Parameters<typeof validatePostgresRevision>[1]); }
    case "approve-revision": { const d = fields(["approvalId", "revisionId", "reviewedDigest", "evidenceRef"]); return approvePostgresRevision(access, d as Parameters<typeof approvePostgresRevision>[1]); }
    case "publish": { const d = fields(["releaseId", "approvalId", "revisionId"]); return promotePostgresRevision(access, d as Parameters<typeof promotePostgresRevision>[1]); }
    case "retire": { const d = fields(["releaseId", "reason"]); return retireSemanticRelease(access, d.releaseId as string, d.reason as string); }
    case "request": { const d = fields(["requestId", "releaseId", "action"]); return requestPostgresRead(access, d as Parameters<typeof requestPostgresRead>[1]); }
    case "approve-read": { const d = fields(["requestId", "releaseId", "sourceId", "requesterId", "reviewedAction"]); return approvePostgresRead(access, d as Parameters<typeof approvePostgresRead>[1]); }
    case "inspect": return inspectPostgresRead(access, fields(["requestId"]).requestId as string);
    case "stop": return stopPostgresRead(access, fields(["requestId"]).requestId as string);
    default: throw new PostgresControlDenied();
  }
}
