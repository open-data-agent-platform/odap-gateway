import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { request as httpRequest } from "node:http";

// The fixture simulates only the trusted proxy hop, never a real TLS deployment.
export async function connectPostgresMcpFixture(address: string, origin: string, path: string,
  headers: Record<string, string>, modern = false) {
  const local = new URL(address), external = new URL(origin);
  if (local.hostname !== "127.0.0.1" || local.protocol !== "http:" || external.hostname !== "gateway.test") {
    throw new Error("Synthetic loopback fixture required");
  }
  const methods: string[] = [], probes: string[] = [];
  const client = new Client({ name: "odap-synthetic-client", version: "0.1.0" },
    { supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
      versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" } });
  const transport = new StreamableHTTPClientTransport(new URL(origin + path), {
    requestInit: { headers },
    fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.origin !== origin || url.pathname !== path) throw new Error("Fixture redirect refused");
      const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
      const method = body ? JSON.parse(Buffer.from(body).toString("utf8")).method : undefined;
      if (method) methods.push(method);
      const forwarded = new Headers(request.headers); forwarded.set("Host", external.host);
      if (body) forwarded.set("Content-Length", String(body.byteLength));
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest({ hostname: local.hostname, port: local.port, path, method: request.method,
          headers: Object.fromEntries(forwarded), signal: request.signal }, response => {
          const chunks: Buffer[] = []; let length = 0;
          response.on("data", chunk => {
            length += chunk.length;
            if (length > 1048576) response.destroy(new Error("Fixture response overflow")); else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (method === "server/discover") probes.push(String(response.statusCode) + ":" + Buffer.concat(chunks).toString("utf8"));
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
            resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
          });
        });
        req.on("error", reject); req.setTimeout(10000, () => req.destroy(new Error("Fixture deadline")));
        req.end(body ? Buffer.from(body) : undefined);
      });
    },
  });
  try { await client.connect(transport); } catch (error) {
    await client.close();
    if (probes.length) throw new Error("Synthetic discovery response: " + probes.join("; "));
    throw error;
  }
  return { client, methods, close: () => client.close() };
}
