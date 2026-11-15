import type { AuthEnv } from "../../lib/auth";
import type { AdminStorageEnv } from "../../lib/admin-store";
import { authorizeControlRequest } from "../../lib/control-storage";
import { commandRequestError, exactFields, routeId } from "../../lib/control-command-request";
import { postgresControlCommand, PostgresControlDenied } from "../../lib/postgresql-control";
import { readBoundedRequestJson } from "../../lib/request-json";
import { executeGovernedPostgresRead, type PostgresConnectionResolver } from "./control";

const commandFields: Record<string, string[]> = {
  propose: ["revisionId", "provenanceRef", "definition"], review: ["revisionId"],
  validate: ["revisionId", "reviewedDigest", "evidenceRef"],
  "approve-revision": ["approvalId", "revisionId", "reviewedDigest", "evidenceRef"],
  publish: ["releaseId", "approvalId", "revisionId"], retire: ["releaseId", "reason"],
  request: ["requestId", "releaseId", "action"],
  "approve-read": ["requestId", "releaseId", "sourceId", "requesterId", "reviewedAction"],
  inspect: ["requestId"], stop: ["requestId"], execute: ["requestId"],
};
const objectFields = new Set(["definition", "action", "reviewedAction"]);
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

/** Node host hook: REST commands and post-initialization MCP tools share one service.
 * The host owns TLS/OAuth and MCP session initialization. Do not mount this in a Worker.
 * Every request must carry the current authenticated session, including MCP calls.
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
    const invalid = commandRequestError(request, tenant);
    if (invalid) return invalid;
    try {
      const auth = await authorizeControlRequest(request, options.env, tenant);
      if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
      const body = await readBoundedRequestJson(request, 65536);
      if (!body.ok) return json({ ok: false, code: "invalid_body" }, body.reason === "too_large" ? 413 : 400);
      const call = async (name: string, args: unknown) => {
        if (!Object.hasOwn(commandFields, name) || !exactFields(args, commandFields[name])) throw new PostgresControlDenied();
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
          description: "Authenticated PostgreSQL control command: " + name + ". No autonomous agent delegation or monetary cost guarantee.",
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
