export type PreparedRead<Result> = () => Promise<Result>;

// Internal trusted-host boundary, not an authorization API. The claim callback
// must atomically recheck current authority and persist the exact prepared read.
// Ambiguous claims and sender failures never trigger submission retries here.
export async function submitPreparedRead<Result>(
  prepare: () => Promise<PreparedRead<Result>>,
  claim: () => Promise<boolean>,
  claimFailure = new Error("Read claim not confirmed"),
): Promise<Result> {
  const send = await prepare();
  if (typeof send !== "function") throw new Error("Adapter failed to prepare submission");
  if (await claim() !== true) throw claimFailure;
  return send();
}
