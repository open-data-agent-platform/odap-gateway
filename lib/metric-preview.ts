import { canonicalControlJson, isSemanticRelease, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { compileReleasedMetric } from "./metric-compiler";

export class InvalidRequestedAction extends Error {}

export const eligibleMetricRelease = `FROM requestable_metric_releases e JOIN control_memberships m ON m.tenant_id=e.tenant_id
  WHERE e.tenant_id=? AND e.release_id=? AND m.principal_id=? AND m.active=1 AND m.role IN ('reader','reviewer','owner')`;

// Server-side compilation snapshot only. Any later effect needs its own eligibility check.
export async function prepareMetricPreview(access: ControlAccess, releaseId: string, action: unknown) {
  const row = await access.db.prepare(`SELECT e.payload,e.definition_json,e.project_id ${eligibleMetricRelease}`)
    .bind(access.tenantId, releaseId, access.principalId).first<{ payload: string; definition_json: string; project_id: string }>();
  if (!row) return null;
  const release: unknown = JSON.parse(row.payload);
  if (!isSemanticRelease(release) || release.tenantId !== access.tenantId || release.id !== releaseId) {
    throw new Error("Invalid stored semantic release");
  }
  let canonicalAction: string, compiled: Awaited<ReturnType<typeof compileReleasedMetric>>;
  try {
    canonicalAction = canonicalControlJson(action);
    compiled = await compileReleasedMetric(release, row.definition_json, canonicalAction, row.project_id);
  } catch { throw new InvalidRequestedAction(); }
  return { releaseId, definitionDigest: release.definitionDigest, actionDigest: await sha256Text(canonicalAction),
    projectId: row.project_id, compiled };
}
