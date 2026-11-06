const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const invalid = () => new Error("Invalid provider JSON response");

export async function withProviderDeadline<T>(read: (signal: AbortSignal) => Promise<T>, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(message)); }, REQUEST_TIMEOUT_MS);
  });
  try {
    // Also bound transports that do not honor cancellation.
    return await Promise.race([read(controller.signal), deadline]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readBoundedProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted || !response.body || Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader(), bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0, complete = false, cancelled = false;
  const cancel = () => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => {});
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw invalid();
      if (done) break;
      if (value.byteLength > MAX_RESPONSE_BYTES - size) throw invalid();
      bytes.set(value, size);
      size += value.byteLength;
    }
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    complete = true;
    return result;
  } catch {
    throw invalid();
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
