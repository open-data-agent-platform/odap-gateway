import { requestEvidenceCoverage, type CoverageEnv } from "./coverage-request";

const tool = {
  name: "odap_evidence_coverage",
  description: "Count recorded evidence states for a tenant you own.",
  inputSchema: { type: "object", properties: { tenantId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" } },
    required: ["tenantId"], additionalProperties: false },
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
export async function handleCoverageToolRequest(request: Request, env: CoverageEnv, message: unknown) {
  if (!isRpcRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || !isRpcId(message.id)) {
    return rpcError(null, -32600, "Invalid request");
  }
  const { id, method, params } = message;
  if (method === "tools/list") {
    if (params !== undefined && (!isRpcRecord(params) || Object.keys(params).some(k => k !== "_meta")))
      return rpcError(id, -32602, "Invalid parameters");
    return { jsonrpc: "2.0" as const, id, result: { tools: [tool] } };
  }
  if (method !== "tools/call") return rpcError(id, -32601, "Method not found");
  if (!isRpcRecord(params) || params.name !== tool.name || !isRpcRecord(params.arguments) ||
      Object.keys(params).some(k => !["name", "arguments", "_meta"].includes(k)) ||
      Object.keys(params.arguments).length !== 1 || !Object.hasOwn(params.arguments, "tenantId") ||
      typeof params.arguments.tenantId !== "string") return rpcError(id, -32602, "Invalid tool call");
  const { body } = await requestEvidenceCoverage(request, env, params.arguments.tenantId);
  return { jsonrpc: "2.0" as const, id, result: {
    isError: !body.ok, content: [{ type: "text" as const, text: JSON.stringify(body) }]
  } };
}
