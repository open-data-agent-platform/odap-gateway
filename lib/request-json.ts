type JsonBodyFailure = "invalid" | "too_large" | "timeout";
type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: JsonBodyFailure };

export async function readBoundedRequestJson(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  if (request.bodyUsed || request.body?.locked) return { ok: false, reason: "invalid" };
  if (request.signal.aborted || Number(request.headers.get("Content-Length")) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    return { ok: false, reason: request.signal.aborted ? "invalid" : "too_large" };
  }
  if (!request.body) return { ok: false, reason: "invalid" };
  const reader = request.body.getReader(), bytes = new Uint8Array(maxBytes);
  let size = 0, complete = false, cancelled = false;
  let refusal: JsonBodyFailure | undefined;
  const cancel = () => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => {});
    }
  };
  let interrupt!: (reason: JsonBodyFailure) => void;
  const interrupted = new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
    interrupt = reason => {
      refusal ??= reason;
      resolve({ done: true, value: undefined });
      cancel();
    };
  });
  const onAbort = () => interrupt("invalid");
  request.signal.addEventListener("abort", onAbort, { once: true });
  // One deadline for the whole body, including streams whose cancellation stalls.
  const timer = setTimeout(() => interrupt("timeout"), 15_000);
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), interrupted]);
      if (refusal) return { ok: false, reason: refusal };
      if (done) break;
      if (value.byteLength > maxBytes - size) return { ok: false, reason: "too_large" };
      bytes.set(value, size);
      size += value.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    complete = true;
    return { ok: true, value };
  } catch {
    return { ok: false, reason: refusal ?? "invalid" };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
