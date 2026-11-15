import type { ControlAccess } from "./control-storage";

export type PostgresFailureCode = "57014" | "42501";

// Trusted provider-observation API only; never accept these facts over REST/MCP.
export async function recordPostgresFailure(access: ControlAccess, requestId: string, intentId: string,
  statementDigest: string, sqlState: PostgresFailureCode) {
  if (sqlState !== "57014" && sqlState !== "42501") throw new Error("Unsupported PostgreSQL terminal code");
  const row = await access.db.prepare(`INSERT INTO postgresql_terminal_failures
    (tenant_id,request_id,intent_id,statement_digest,sql_state)
    SELECT tenant_id,request_id,intent_id,statement_digest,? FROM postgresql_read_claims
    WHERE tenant_id=? AND request_id=? AND intent_id=? AND statement_digest=? AND claimed_by=? RETURNING intent_id`)
    .bind(sqlState, access.tenantId, requestId, intentId, statementDigest, access.principalId).first<{ intent_id: string }>();
  return row?.intent_id === intentId;
}
