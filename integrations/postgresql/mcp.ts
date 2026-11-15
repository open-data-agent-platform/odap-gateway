import { createMcpHandler, Server, type CallToolResult } from "@modelcontextprotocol/server";
import { authorizeControlRequest } from "../../lib/control-storage";
import { commandRequestError } from "../../lib/control-command-request";
import { readBoundedRequestJson } from "../../lib/request-json";
import { createPostgresGateway, postgresSessionTools } from "./gateway";

const unavailable = (): CallToolResult => ({ content: [{ type: "text",
  text: "PostgreSQL operation unavailable; inspect the request before retrying." }], isError: true });
const json = (code: string, status: number) => Response.json({ ok: false, code }, { status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const agentTools = () => ["execute", "inspect"].map(operation => ({
  name: "postgresql_agent_" + operation,
  description: "Scoped signed PostgreSQL Agent " + operation + ". Discovery grants no execution authority.",
  inputSchema: { type: "object" as const, properties: { delegationId: { type: "string" }, signature: { type: "string" } },
    required: ["delegationId", "signature"], additionalProperties: false },
}));

/** Stateless official MCP transport. Tool authority remains in the shared gateway.
 * Agent discovery is static/public; every data operation still needs a scoped proof.
 * Browser sessions are revalidated on every request, not trusted from initialization.
 */
export function createPostgresMcpGateway(options: Parameters<typeof createPostgresGateway>[0],
  gateway: ReturnType<typeof createPostgresGateway>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), match = /^\/postgresql\/([A-Za-z0-9_-]{1,128})\/(mcp-stream|agent-mcp-stream)$/.exec(url.pathname);
    if (url.origin !== options.origin || !match || url.search) return json("not_found", 404);
    if (request.method !== "POST") return json("method_not_allowed", 405);
    const [, tenant, mode] = match, agent = mode === "agent-mcp-stream";
    if (request.headers.has("Mcp-Session-Id")) return json("stateless_transport_required", 400);
    if (agent) {
      if (request.headers.has("Cookie") || request.headers.has("Authorization") ||
          (request.headers.has("Origin") && request.headers.get("Origin") !== options.origin) ||
          request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return json("agent_request_refused", 403);
    } else {
      const invalid = commandRequestError(request, tenant); if (invalid) return invalid;
      try {
        const auth = await authorizeControlRequest(request, options.env, tenant);
        if (!auth.ok) return json(auth.code, auth.status);
      } catch { return json("session_unavailable", 403); }
    }
    const body = await readBoundedRequestJson(request, 65536);
    if (!body.ok) return json("invalid_body", body.reason === "too_large" ? 413 : 400);
    const running = new Set<Promise<CallToolResult>>();
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "odap-postgresql", version: "0.1.0" },
        { capabilities: { tools: {} }, supportedProtocolVersions: ["2026-07-28", "2025-11-25"] });
      server.onerror = () => {};
      server.setRequestHandler("tools/list", async () => ({ tools: agent ? agentTools() : postgresSessionTools() }));
      server.setRequestHandler("tools/call", async (call, ctx) => {
        const run = async (): Promise<CallToolResult> => {
          try {
            const response = await gateway(new Request(`${options.origin}/postgresql/${tenant}/${agent ? "agent-mcp" : "mcp"}`, {
              method: "POST", headers: request.headers,
              signal: AbortSignal.any([request.signal, ctx.mcpReq.signal]),
              body: JSON.stringify({ jsonrpc: "2.0", id: "mcp-dispatch", method: "tools/call",
                params: { name: call.params.name, arguments: call.params.arguments ?? {} } }),
            }));
            const result = await response.json() as { result?: CallToolResult };
            return response.ok && result.result ? result.result : unavailable();
          } catch { return unavailable(); }
        };
        const pending = run(); running.add(pending);
        try { return await pending; } finally { running.delete(pending); }
      });
      return server;
    }, { legacy: "stateless", maxRequestBodySize: 65536, maxSubscriptions: 0, onerror: () => {} });
    try {
      const response = await handler.fetch(request, { parsedBody: body.value });
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) for (;;) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.byteLength;
          if (size > 1048576) { await reader.cancel(); return json("response_unavailable", 502); }
          chunks.push(item.value);
        }
      } finally { reader?.releaseLock(); }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store"); headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.status === 204 || response.status === 304 ? null : Buffer.concat(chunks, size),
        { status: response.status, headers });
    } catch { return json("mcp_unavailable", 400); }
    finally {
      // Transport abort is not proof that trusted provider/storage work has ended.
      await Promise.allSettled([...running]); await handler.close();
    }
  };
}
