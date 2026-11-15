import { request as httpRequest } from "node:http";

// Synthetic loopback transport fixture; callers supply their test-only identity.
export function postgresHttpRequest(address: string, path: string, input: unknown,
  headers: Record<string, string>, method = "POST") {
  const url = new URL(address), bytes = JSON.stringify(input);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Loopback fixture required");
  let request: ReturnType<typeof httpRequest>;
  const result = new Promise<{ status: number; data: string; cache: string | undefined }>((done, reject) => {
    request = httpRequest({ hostname: url.hostname, port: url.port, path, method,
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(bytes)), ...headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", b => chunks.push(b)); response.on("error", reject);
      response.on("end", () => done({ status: response.statusCode!, data: Buffer.concat(chunks).toString("utf8"), cache: response.headers["cache-control"] }));
    });
    request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Synthetic request deadline"))); request.end(bytes);
  });
  return { result, destroy: () => request.destroy() };
}
