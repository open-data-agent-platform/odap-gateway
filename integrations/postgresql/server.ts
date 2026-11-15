import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createPostgresGateway } from "./gateway";

type GatewayOptions = Parameters<typeof createPostgresGateway>[0];
export type PostgresHttpHostOptions = GatewayOptions & {
  port: number;
  maxRequests?: number;
  requestDeadlineMs?: number;
};
const failure = (response: ServerResponse, status: number, code: string) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", Connection: "close" });
  response.end(JSON.stringify({ ok: false, code }));
};
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

function body(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0;
    const clean = () => {
      request.off("data", data); request.off("end", end); request.off("error", fail);
      request.off("aborted", fail); signal.removeEventListener("abort", fail);
    };
    const fail = () => { clean(); request.pause(); reject(new Error("Request unavailable")); };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > 65536) { clean(); request.pause(); reject(new RangeError("Request too large")); }
      else chunks.push(chunk);
    };
    const end = () => { clean(); resolve(Buffer.concat(chunks, length)); };
    request.on("data", data); request.once("end", end); request.once("error", fail);
    request.once("aborted", fail); signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted || request.destroyed) fail();
  });
}

/** Loopback-only HTTP bridge behind an explicitly configured trusted TLS proxy.
 * Forwarded headers confer no identity/origin. This does not provision OAuth,
 * initialize storage, implement MCP initialization or open a public listener.
 */
export async function startPostgresHttpHost(options: PostgresHttpHostOptions) {
  let origin: URL;
  try { origin = new URL(options.origin); } catch { throw new Error("Invalid PostgreSQL HTTP host configuration"); }
  const maxRequests = options.maxRequests ?? 64, deadline = options.requestDeadlineMs ?? 30000;
  if (origin.protocol !== "https:" || origin.origin !== options.origin ||
      !integer(options.port, 0, 65535) || !integer(maxRequests, 1, 1024) || !integer(deadline, 100, 120000)) {
    throw new Error("Invalid PostgreSQL HTTP host configuration");
  }
  const gateway = createPostgresGateway(options);
  let draining = false, stopped: Promise<void> | undefined;
  const active = new Map<Promise<void>, AbortController>();
  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse, controller: AbortController) => {
    const abort = () => { if (!outgoing.writableFinished) controller.abort(); };
    outgoing.once("close", abort); outgoing.once("error", abort);
    const timer = setTimeout(() => { controller.abort(); failure(outgoing, 504, "request_deadline"); }, deadline);
    try {
      const headers = incoming.headersDistinct, path = incoming.url ?? "";
      if (incoming.httpVersion !== "1.1" || incoming.rawHeaders.length > 256 ||
          Object.values(headers).some(values => values && values.length !== 1) ||
          headers.host?.[0] !== origin.host || path.length > 4096 || !path.startsWith("/") ||
          path.startsWith("//") || path.includes("\\") || path.includes("#")) {
        return failure(outgoing, 400, "invalid_request");
      }
      if (incoming.method !== "POST") return failure(outgoing, 405, "method_not_allowed");
      if (headers["content-encoding"] && headers["content-encoding"][0] !== "identity") return failure(outgoing, 415, "unsupported_encoding");
      if (headers["content-length"] && Number(headers["content-length"][0]) > 65536) return failure(outgoing, 413, "body_too_large");
      const bytes = await body(incoming, controller.signal);
      if (controller.signal.aborted || incoming.rawTrailers.length) return failure(outgoing, 400, "invalid_request");
      // Forward only headers used by the existing authenticated command boundary.
      const requestHeaders = new Headers();
      for (const name of ["content-type", "origin", "cookie", "authorization"]) {
        if (headers[name]) requestHeaders.set(name, headers[name][0]);
      }
      const request = new Request(options.origin + path, { method: "POST", headers: requestHeaders,
        body: new Uint8Array(bytes), signal: controller.signal });
      const response = await gateway(request);
      if (controller.signal.aborted || outgoing.destroyed || outgoing.writableEnded) return;
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1048576) { await reader.cancel(); return failure(outgoing, 502, "response_unavailable"); }
          chunks.push(chunk.value);
        }
      } finally { reader?.releaseLock(); }
      if (controller.signal.aborted || outgoing.destroyed || outgoing.writableEnded) return;
      outgoing.statusCode = response.status;
      for (const name of ["content-type", "cache-control", "x-content-type-options"]) {
        const value = response.headers.get(name); if (value) outgoing.setHeader(name, value);
      }
      outgoing.setHeader("Connection", "close"); outgoing.end(Buffer.concat(chunks, size));
    } catch (error) {
      if (!controller.signal.aborted) failure(outgoing, error instanceof RangeError ? 413 : 400,
        error instanceof RangeError ? "body_too_large" : "request_unavailable");
    } finally {
      clearTimeout(timer); outgoing.off("close", abort); outgoing.off("error", abort);
    }
  };
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 5000, requestTimeout: 10000,
    connectionsCheckingInterval: 250, keepAliveTimeout: 1000, insecureHTTPParser: false }, (request, response) => {
    if (draining || active.size >= maxRequests) { failure(response, 503, "host_unavailable"); return; }
    const controller = new AbortController();
    const pending = handle(request, response, controller).finally(() => active.delete(pending));
    active.set(pending, controller);
    void pending.catch(() => { controller.abort(); response.destroy(); });
  });
  server.maxHeadersCount = 0; // Enforce the raw header count above without parser truncation.
  server.maxRequestsPerSocket = 1; server.maxConnections = maxRequests + 16;
  server.on("clientError", (_error, socket) => {
    if (socket instanceof Socket && socket.writable && socket.bytesWritten === 0) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  server.on("checkContinue", (_request, response) => failure(response, 417, "expectation_refused"));
  server.on("checkExpectation", (_request, response) => failure(response, 417, "expectation_refused"));
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const fail = () => { reject(new Error("PostgreSQL HTTP listener unavailable")); };
    server.once("error", fail);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", fail); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PostgreSQL HTTP listener unavailable");
  return { address: `http://127.0.0.1:${address.port}`, async close(graceMs = 5000): Promise<{ drained: boolean }> {
    if (!integer(graceMs, 0, 120000)) throw new Error("Invalid PostgreSQL shutdown grace");
    draining = true;
    stopped ??= new Promise<void>(resolve => server.close(() => resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([Promise.allSettled([...active.keys()]), stopped]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
    } finally { if (timer) clearTimeout(timer); }
    for (const controller of active.values()) controller.abort();
    server.closeAllConnections(); await stopped;
    return { drained: active.size === 0 };
  } };
}
