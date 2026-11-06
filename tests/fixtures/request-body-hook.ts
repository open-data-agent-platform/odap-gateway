// A lazy stream exercises the actual read boundary, independent of JSON reader APIs.
export function withBodyReadHook(source: Request, beforeRead: () => Promise<unknown>): Request {
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    await beforeRead();
    controller.enqueue(new Uint8Array(await source.arrayBuffer()));
    controller.close();
  } }, { highWaterMark: 0 });
  return new Request(source, { body, duplex: "half" } as RequestInit);
}
