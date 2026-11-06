import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { handleCoverageToolRequest, isRpcId, isRpcRecord, rpcError } from "../lib/coverage-mcp";
import type { CoverageEnv } from "../lib/coverage-request";

// One local tools-only profile. An incompatible client can disconnect
// after seeing the version in the initialize response.
const protocolVersion = "2025-06-18";
const maxFrameBytes = 64 * 1024;

async function* lines(source: AsyncIterable<Buffer>) {
  const frame = Buffer.allocUnsafe(maxFrameBytes);
  let length = 0;
  for await (const chunk of source) {
    for (let start = 0; start < chunk.length;) {
      const end = chunk.indexOf(10, start);
      const size = (end < 0 ? chunk.length : end) - start;
      if (length + size > maxFrameBytes) throw new Error("MCP frame too large");
      chunk.copy(frame, length, start, start + size);
      length += size;
      if (end < 0) break;
      yield frame.subarray(0, length);
      length = 0;
      start = end + 1;
    }
  }
  // An incomplete frame at EOF is never an executable request.
}

function coverageSession(env: CoverageEnv, sessionRequest: () => Request) {
  let phase: "new" | "negotiated" | "ready" = "new";
  return async (message: unknown) => {
    if (!isRpcRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
        "result" in message || "error" in message) return rpcError(null, -32600, "Invalid request");
    const { method, params, id } = message;
    if (!Object.hasOwn(message, "id")) {
      if (method === "notifications/initialized" && phase === "negotiated" &&
          (params === undefined || isRpcRecord(params))) phase = "ready";
      return null; // Notifications never invoke tools or generate replies.
    }
    if (!isRpcId(id)) return rpcError(null, -32600, "Invalid request");
    if (method === "initialize") {
      if (phase !== "new") return rpcError(id, -32600, "Already initialized");
      if (!isRpcRecord(params) || typeof params.protocolVersion !== "string" || !params.protocolVersion ||
          !isRpcRecord(params.capabilities) || !isRpcRecord(params.clientInfo) ||
          typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string")
        return rpcError(id, -32602, "Invalid initialize parameters");
      phase = "negotiated";
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "odap-local-coverage", version: "0.1.0" } } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (phase !== "ready") return rpcError(id, -32002, "Session not initialized");
    try {
      return await handleCoverageToolRequest(sessionRequest(), env, message);
    } catch {
      return rpcError(id, -32603, "Internal error");
    }
  };
}

// No default process, credentials, network listener or database. The local
// host owns the streams and supplies session context independently of stdin.
export async function serveCoverageStdio(input: Readable, output: Writable, env: CoverageEnv, sessionRequest: () => Request) {
  const dispatch = coverageSession(env, sessionRequest);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  await pipeline(input, async function* (source: AsyncIterable<Buffer>, options?: { signal: AbortSignal }) {
    for await (const frame of lines(source)) {
      if (options?.signal.aborted || output.destroyed) return;
      let message: unknown;
      try { message = JSON.parse(decoder.decode(frame)); }
      catch { yield JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n"; continue; }
      const reply = await dispatch(message);
      if (!options?.signal.aborted && !output.destroyed && reply !== null) yield JSON.stringify(reply) + "\n";
    }
  }, output);
}
