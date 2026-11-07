import { jsonResponse } from "../../../../../lib/auth-request";
import { requestBudgetReconciliation, type BudgetReconciliationEnv } from "../../../../../lib/budget-reconciliation-request";

export async function onRequestGet({ request, env, params }: {
  request: Request; env: BudgetReconciliationEnv; params: { tenant: string; id: string };
}) {
  if (new URL(request.url).search) return jsonResponse({ ok: false, code: "invalid_budget_view" }, { status: 400 });
  const { body, status } = await requestBudgetReconciliation(request,env,params.tenant,params.id);
  return jsonResponse(body,{ status });
}
