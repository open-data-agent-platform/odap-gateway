import { afterEach, expect, it, vi } from "vitest";
import * as cancellation from "../lib/delegated-cancellation";
import { sendRequestedDelegatedJobCancellation } from "../lib/bigquery-cancellation-transport";
import type { ControlAccess } from "../lib/control-storage";

const access = { db: {}, tenantId: "t", principalId: "owner" } as ControlAccess;
const value = { state: "requested" as const, jobReference: { projectId: "fixture-project", location: "US", jobId: "odap_" + "a".repeat(64) },
  witness: { audience: "a", claimBodyDigest: "sha256:" + "b".repeat(64) }, request: { requestedBy: "owner", requestedAt: "fixture-time", verified: true } };
afterEach(() => { vi.restoreAllMocks(); });
it.each([{ audience: "other" }, { claimBodyDigest: "sha256:" + "c".repeat(64) }])("rejects changed claim attribution after token preparation: %j", async changed => {
  const read = vi.spyOn(cancellation, "readDelegatedCancellation").mockResolvedValueOnce(value)
    .mockResolvedValueOnce({ ...value, witness: { ...value.witness, ...changed } });
  const sendOnce = vi.fn();
  await expect(sendRequestedDelegatedJobCancellation(access, "a", "i", { getAccessToken: async () => "synthetic", sendOnce })).rejects.toThrow("unavailable");
  expect(read).toHaveBeenCalledTimes(2); expect(sendOnce).not.toHaveBeenCalled();
});
