const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const failure = () => new Error("OAuth provider request failed");

export async function fetchOAuthJson(url: string, init: Omit<RequestInit, "signal" | "redirect">): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(failure()); }, REQUEST_TIMEOUT_MS);
  });

  async function read() {
    // Fixed provider callers supply the URL. Never redirect credentials elsewhere.
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (controller.signal.aborted || !response.ok || response.redirected || !response.body ||
        Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw failure();
    }
    const reader = response.body.getReader(), bytes = new Uint8Array(MAX_RESPONSE_BYTES);
    let size = 0, complete = false, cancelled = false;
    const cancel = () => {
      if (!cancelled) {
        cancelled = true;
        void reader.cancel().catch(() => {});
      }
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) throw failure();
        if (done) break;
        if (value.byteLength > MAX_RESPONSE_BYTES - size) throw failure();
        bytes.set(value, size);
        size += value.byteLength;
      }
      const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      complete = true;
      return result;
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      if (!complete) cancel();
      reader.releaseLock();
    }
  }

  try {
    // The deadline also bounds headers/body reads if a transport ignores abort.
    return await Promise.race([read(), deadline]);
  } catch {
    controller.abort();
    throw failure();
  } finally {
    clearTimeout(timer);
  }
}
