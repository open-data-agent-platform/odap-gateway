import type { AuthEnv } from "../../lib/auth";
import type { AdminStorageEnv } from "../../lib/admin-store";
import { authorizeControlRequest } from "../../lib/control-storage";
import { commandRequestError, exactFields, routeId } from "../../lib/control-command-request";
import { approvePostgresAgentRead, postgresControlCommand, PostgresControlDenied } from "../../lib/postgresql-control";
import { readBoundedRequestJson } from "../../lib/request-json";
import { executeGovernedPostgresRead, postgresAgentOperation, type PostgresConnectionResolver } from "./control";
import { delegatePostgresRead, postgresAgentAudience, postgresAgentChallenges, revokePostgresDelegation } from "../../lib/postgresql-agent";

const commandFields: Record<string, string[]> = {
  propose: ["revisionId", "provenanceRef", "definition"], review: ["revisionId"],
  validate: ["revisionId", "reviewedDigest", "evidenceRef"],
  "approve-revision": ["approvalId", "revisionId", "reviewedDigest", "evidenceRef"],
  publish: ["releaseId", "approvalId", "revisionId"], retire: ["releaseId", "reason"],
  request: ["requestId", "releaseId", "action"],
  "approve-read": ["requestId", "releaseId", "sourceId", "requesterId", "reviewedAction"],
  inspect: ["requestId"], stop: ["requestId"], execute: ["requestId"],
  delegate: ["requestId", "agentId", "keyId"], "revoke-delegation": ["delegationId"], "agent-challenges": ["delegationId"],
  "approve-agent-read": ["requestId", "releaseId", "sourceId", "requesterId", "reviewedAction", "delegationId", "agentId", "keyId"],
};
const objectFields = new Set(["definition", "action", "reviewedAction"]);
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

/** Node host hook: REST commands and post-initialization MCP tools share one service.
 * The host owns TLS/OAuth and MCP session initialization. Do not mount this in a Worker.
 * Human commands require a current session; agent commands require scoped key signatures.
 */
export function createPostgresGateway(options: {
  origin: string; env: AuthEnv & AdminStorageEnv; resolve: PostgresConnectionResolver;
}) {
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin) throw new Error("Canonical PostgreSQL host origin required");
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const match = /^\/postgresql\/([A-Za-z0-9_-]{1,128})\/([a-z-]+)$/.exec(url.pathname);
    if (url.origin !== origin || !match || url.search) return json({ ok: false, code: "not_found" }, 404);
    if (request.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);
    const [, tenant, command] = match;
    // Agent calls use registered-key signatures, never a borrowed browser session.
    if (["agent-execute", "agent-inspect", "agent-mcp"].includes(command)) {
      if (request.headers.has("Cookie") || request.headers.has("Authorization") ||
          (request.headers.has("Origin") && request.headers.get("Origin") !== origin) ||
          request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
        return json({ ok: false, code: "agent_request_refused" }, 403);
      }
      try {
        postgresAgentAudience(origin);
        const db = options.env.ODAP_GATEWAY_DB ?? options.env.DB;
        if (!db) throw new PostgresControlDenied();
        const body = await readBoundedRequestJson(request, 65536);
        if (!body.ok) return json({ ok: false, code: "invalid_body" }, body.reason === "too_large" ? 413 : 400);
        let operation = command.slice(6), args = body.value, rpcId: string | number | undefined;
        if (command === "agent-mcp") {
          const rpc = body.value;
          if (!exactFields(rpc, ["jsonrpc", "id", "method", "params"]) || rpc.jsonrpc !== "2.0" || rpc.method !== "tools/call" ||
              !(typeof rpc.id === "string" || (typeof rpc.id === "number" && Number.isSafeInteger(rpc.id))) ||
              !exactFields(rpc.params, ["name", "arguments"]) || typeof rpc.params.name !== "string" ||
              !["postgresql_agent_execute", "postgresql_agent_inspect"].includes(rpc.params.name)) throw new PostgresControlDenied();
          rpcId = rpc.id; operation = rpc.params.name.slice(17); args = rpc.params.arguments;
        }
        if (!exactFields(args, ["delegationId", "signature"]) || typeof args.delegationId !== "string" || typeof args.signature !== "string" ||
            !["execute", "inspect"].includes(operation)) throw new PostgresControlDenied();
        const result = await postgresAgentOperation(db, origin, tenant, args.delegationId, args.signature,
          operation as "execute" | "inspect", options.resolve, request.signal);
        return rpcId === undefined ? json({ ok: true, result }) :
          json({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } });
      } catch { return json({ ok: false, code: "postgresql_agent_unavailable" }, 403); }
    }
    const invalid = commandRequestError(request, tenant);
    if (invalid) return invalid;
    try {
      const auth = await authorizeControlRequest(request, options.env, tenant);
      if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
      const body = await readBoundedRequestJson(request, 65536);
      if (!body.ok) return json({ ok: false, code: "invalid_body" }, body.reason === "too_large" ? 413 : 400);
      const call = async (name: string, args: unknown) => {
        if (!Object.hasOwn(commandFields, name) || !exactFields(args, commandFields[name])) throw new PostgresControlDenied();
        if (name === "delegate") return delegatePostgresRead(auth.access, origin, args as Parameters<typeof delegatePostgresRead>[2]);
        if (name === "revoke-delegation") return revokePostgresDelegation(auth.access, origin, args.delegationId as string);
        if (name === "agent-challenges") return postgresAgentChallenges(auth.access, origin, args.delegationId as string);
        if (name === "approve-agent-read") return approvePostgresAgentRead(auth.access, origin, args as Parameters<typeof approvePostgresAgentRead>[2]);
        if (name !== "execute") return postgresControlCommand(auth.access, name, args);
        if (typeof args.requestId !== "string" || !routeId.test(args.requestId)) throw new PostgresControlDenied();
        return executeGovernedPostgresRead(auth.access, args.requestId, options.resolve, request.signal);
      };
      if (command !== "mcp") return json({ ok: true, result: await call(command, body.value) });
      const rpc = body.value;
      if (!(exactFields(rpc, ["jsonrpc", "id", "method", "params"]) || exactFields(rpc, ["jsonrpc", "id", "method"])) || rpc.jsonrpc !== "2.0" ||
          !(typeof rpc.id === "string" || (typeof rpc.id === "number" && Number.isSafeInteger(rpc.id)))) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
      }
      const reply = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "tools/list" && (rpc.params === undefined || exactFields(rpc.params, []))) {
        return reply({ tools: Object.entries(commandFields).map(([name, keys]) => ({
          name: "postgresql_" + name.replaceAll("-", "_"),
          description: "Session-authenticated PostgreSQL control command: " + name + ". Agent execution requires separate scoped signatures. No monetary cost guarantee.",
          inputSchema: { type: "object", properties: Object.fromEntries(keys.map(key =>
            [key, { type: objectFields.has(key) ? "object" : "string" }])), required: keys, additionalProperties: false },
        })) });
      }
      if (rpc.method !== "tools/call" || !exactFields(rpc.params, ["name", "arguments"]) || typeof rpc.params.name !== "string" ||
          !rpc.params.name.startsWith("postgresql_")) {
        return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unsupported method or tool" } });
      }
      try {
        const value = await call(rpc.params.name.slice(11).replaceAll("_", "-"), rpc.params.arguments);
        return reply({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
      } catch {
        return reply({ content: [{ type: "text", text: "PostgreSQL operation unavailable; inspect the request before retrying." }], isError: true });
      }
    } catch {
      return json({ ok: false, code: "postgresql_operation_unavailable" }, 409);
    }
  };
}
