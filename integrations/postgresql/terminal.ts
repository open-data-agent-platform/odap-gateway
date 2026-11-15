import { DatabaseError } from "pg";
import type { PostgresFailureCode } from "../../lib/postgresql-terminal";

// Only a metric ErrorResponse followed by same-connection rollback acknowledgement
// establishes this bounded failure. A cancel request or socket closure does not.
export async function acknowledgePostgresFailure(error: unknown, rollback: () => Promise<unknown>, stopped: () => boolean) {
  if (!(error instanceof DatabaseError) || error.severity !== "ERROR" ||
      (error.code !== "57014" && error.code !== "42501") || stopped()) return null;
  const sqlState: PostgresFailureCode = error.code;
  try {
    await rollback();
    return stopped() ? null : { outcome: "failed" as const, claim: "confirmed" as const, sqlState };
  } catch { return null; }
}
