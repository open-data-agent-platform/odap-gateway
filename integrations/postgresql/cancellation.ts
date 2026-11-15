import { Connection } from "pg";
import type { TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type { PostgresHostConfig } from "./index";

// pg 8.23.1 exports these protocol methods but @types/pg omits them.
type CancelConnection = Connection & {
  connect(port: number, host: string): void;
  requestSsl(): void;
  cancel(processID: number, secretKey: number): void;
};
export type PostgresBackendKey = Readonly<{ processID: number; secretKey: number }>;

// No startup/authentication, SQL, administrative role, retry or plaintext TLS fallback.
// Connection closure is not a cancellation acknowledgement; only the original query can supply that.
export function sendPostgresCancellation(config: PostgresHostConfig, key: PostgresBackendKey, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const plain = "insecureLoopback" in config.tls;
  if (plain && (config.host !== "127.0.0.1" || config.tls.insecureLoopback !== true)) return Promise.resolve();
  return new Promise(resolve => {
    const connection = new Connection({ ssl: plain ? false : {
      rejectUnauthorized: true, ...("ca" in config.tls && config.tls.ca ? { ca: config.tls.ca } : {}),
    } }) as CancelConnection;
    let done = false, sent = false;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener("abort", finish);
      connection.stream.destroy(); resolve();
    };
    const timer = setTimeout(finish, 1500);
    const send = () => {
      if (done || sent || signal.aborted) return;
      sent = true;
      try { connection.cancel(key.processID, key.secretKey); } catch { finish(); }
    };
    connection.on("error", finish).on("errorMessage", finish).on("end", finish);
    connection.once("connect", () => {
      if (done || signal.aborted) return finish();
      try { if (plain) send(); else connection.requestSsl(); } catch { finish(); }
    });
    connection.once("sslconnect", () => {
      // pg emits sslconnect before TLS verification; never send the backend key yet.
      const tls = connection.stream as TLSSocket;
      tls.once("secureConnect", () => { if (tls.authorized === true) send(); else finish(); });
    });
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) return finish();
    try { connection.connect(config.port, config.host); } catch { finish(); }
  });
}

async function boundedCheck(check: () => Promise<boolean>, signal: AbortSignal) {
  if (signal.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => undefined;
  try {
    return await Promise.race([Promise.resolve().then(check), new Promise<boolean>(resolve => {
      abort = () => resolve(false);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => resolve(false), 1000);
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

// One serial poll per second, bounded by the query lifetime. Unresponsive storage stops delivery.
export async function monitorPostgresCancellation(check: () => Promise<boolean>, send: () => Promise<void>, signal: AbortSignal) {
  try {
    while (!signal.aborted) {
      // A timed-out check must not overlap a subsequent check or send after query completion.
      let settled = false;
      const requested = await boundedCheck(async () => { const result = await check(); settled = true; return result; }, signal);
      if (signal.aborted || !settled) return;
      if (requested === true) { await send(); return; }
      await delay(1000, undefined, { signal });
    }
  } catch { /* A delivery failure is not a terminal query result. */ }
}
