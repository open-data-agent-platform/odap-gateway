import { requestEvidenceCoverage, type CoverageEnv } from "./coverage-request";
import { requestBudgetReconciliation } from "./budget-reconciliation-request";
import { requestDelegatedRecovery, type DelegatedRecoveryEnv } from "./delegated-recovery-request";
import { requestSettledEvidence } from "./settled-evidence-request";

export type CoverageToolEnv = CoverageEnv & DelegatedRecoveryEnv;

const tool = {
  name: "odap_evidence_coverage",
  description: "Count recorded evidence states for a tenant you own.",
  inputSchema: { type: "object", properties: { tenantId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" } },
    required: ["tenantId"], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false }
} as const;
const budgetTool = {
  name: "odap_budget_reconciliation",
  description: "Inspect recorded SQL, model and tool accounting for a tenant budget you own; not complete workflow cost or execution authority.",
  inputSchema: { type: "object", properties: {
    tenantId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
    budgetId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" }
  }, required: ["tenantId", "budgetId"], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false }
} as const;
const recoveryTool = {
  name: "odap_job_recovery",
  description: "Inspect stored delegated job evidence for a tenant you own; no provider refresh, retry or settlement authority.",
  inputSchema: { type: "object", properties: {
    tenantId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
    intentId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" }
  }, required: ["tenantId", "intentId"], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false }
} as const;
const settledTool = {
  name: "odap_settled_evidence",
  description: "Read a stored settled evidence bundle for a tenant you own; no issuer authentication, provider lookup, execution or settlement authority.",
  inputSchema: { type: "object", properties: {
    tenantId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
    intentId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" }
  }, required: ["tenantId", "intentId"], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false }
} as const;

export function isRpcRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
export function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

// Post-initialization MCP request handler. The host supplies a fresh request
// carrying its session, never a cookie, role or subject from tool arguments.
export async function handleCoverageToolRequest(request: Request, env: CoverageToolEnv, message: unknown) {
  if (!isRpcRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || !isRpcId(message.id)) {
    return rpcError(null, -32600, "Invalid request");
  }
  const { id, method, params } = message;
  if (method === "tools/list") {
    if (params !== undefined && (!isRpcRecord(params) || Object.keys(params).some(k => k !== "_meta")))
      return rpcError(id, -32602, "Invalid parameters");
    return { jsonrpc: "2.0" as const, id, result: { tools: [tool, budgetTool, recoveryTool, settledTool] } };
  }
  if (method !== "tools/call") return rpcError(id, -32601, "Method not found");
  if (!isRpcRecord(params) || !isRpcRecord(params.arguments) ||
      Object.keys(params).some(k => !["name", "arguments", "_meta"].includes(k)) ||
      !Object.hasOwn(params.arguments, "tenantId") ||
      typeof params.arguments.tenantId !== "string") return rpcError(id, -32602, "Invalid tool call");
  let response;
  if (params.name === tool.name && Object.keys(params.arguments).length === 1) {
    response = await requestEvidenceCoverage(request, env, params.arguments.tenantId);
  } else if (params.name === budgetTool.name && Object.keys(params.arguments).length === 2 &&
      Object.hasOwn(params.arguments, "budgetId") && typeof params.arguments.budgetId === "string") {
    response = await requestBudgetReconciliation(request, env, params.arguments.tenantId, params.arguments.budgetId);
  } else if (params.name === recoveryTool.name && Object.keys(params.arguments).length === 2 &&
      Object.hasOwn(params.arguments, "intentId") && typeof params.arguments.intentId === "string") {
    response = await requestDelegatedRecovery(request, env, params.arguments.tenantId, params.arguments.intentId);
  } else if (params.name === settledTool.name && Object.keys(params.arguments).length === 2 &&
      Object.hasOwn(params.arguments, "intentId") && typeof params.arguments.intentId === "string") {
    response = await requestSettledEvidence(request, env, params.arguments.tenantId, params.arguments.intentId);
  } else return rpcError(id, -32602, "Invalid tool call");
  const { body } = response;
  return { jsonrpc: "2.0" as const, id, result: {
    isError: !body.ok, content: [{ type: "text" as const, text: JSON.stringify(body) }]
  } };
}
