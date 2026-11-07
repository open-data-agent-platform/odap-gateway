import { authorizeControlRequest } from "./control-storage";
import { routeId } from "./control-command-request";
import { readBudgetReconciliation } from "./budget-reconciliation";

export type BudgetReconciliationEnv = Parameters<typeof authorizeControlRequest>[1];
const failure = (status: number, code: string) => ({ status, body: { ok: false as const, code } });

export async function requestBudgetReconciliation(request: Request, env: BudgetReconciliationEnv,
  tenant: unknown, budgetId: unknown) {
  if (typeof tenant !== "string" || !routeId.test(tenant) || typeof budgetId !== "string" || !routeId.test(budgetId))
    return failure(400, "invalid_control_path");
  try {
    const auth = await authorizeControlRequest(request, env, tenant);
    if (!auth.ok) return failure(auth.status, auth.code);
    if (auth.role !== "owner") return failure(403, "tenant_access_denied");
    // Read compatibility only after authentication, and never cache ownership or schema capability.
    const capability = await auth.access.db.prepare(`SELECT (SELECT count(*) FROM sqlite_master
      WHERE type='table' AND name IN ('auxiliary_cost_reservations','auxiliary_cost_settlements')) AS tables
      FROM control_memberships WHERE tenant_id=? AND principal_id=? AND active=1 AND role='owner'`)
      .bind(tenant,auth.access.principalId).first<{ tables: number }>();
    if (!capability) return failure(403, "tenant_access_denied");
    if (capability.tables === 0 || capability.tables === 1) return failure(503, "budget_accounting_unavailable");
    if (capability.tables !== 2) throw new Error("Invalid accounting capability");
    // The data statement rechecks current ownership even after a successful capability read.
    const reconciliation = await readBudgetReconciliation(auth.access,budgetId);
    if (!reconciliation) return failure(403, "tenant_access_denied");
    return { status: 200, body: { ok: true as const, reconciliation } };
  } catch {
    return failure(503, "control_storage_unavailable");
  }
}
