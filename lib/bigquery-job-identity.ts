// Address and binding tag only. Neither is an authorization credential.
export type BigQueryJobBinding = {
  tenantId: string; intentId: string; actionDigest: string; projectId: string; location: string;
};

async function digest(fields: string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function intentJobId(tenantId: string, intentId: string) {
  return "odap_" + await digest(["odap.job.v1", tenantId, intentId]);
}

export async function intentJobIdentity(binding: BigQueryJobBinding) {
  if (![binding.tenantId, binding.intentId, binding.actionDigest, binding.projectId, binding.location]
    .every(value => typeof value === "string" && value.trim().length > 0)) throw new Error("Incomplete job binding");
  const { tenantId, intentId, actionDigest, projectId, location } = binding;
  const jobId = await intentJobId(tenantId, intentId);
  // BigQuery label values allow at most 63 characters; use a 192-bit binding tag.
  const actionTag = (await digest(["odap.action.v1", jobId, actionDigest])).slice(0, 48);
  return { jobReference: { projectId, location, jobId }, labels: { odap_action: actionTag } };
}
