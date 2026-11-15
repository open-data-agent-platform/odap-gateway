import type { ControlAccess } from "./control-storage";
import { exactFields } from "./control-command-request";
import { canonicalControlJson } from "./control-objects";
import { postgresText } from "./postgresql-parameter";
import { recordMissingReleaseDenial } from "./preapproval-denial";

// This records a negative decision only. There is no definition to compile yet.
export async function recordPostgresMissingRelease(access: ControlAccess, releaseId: string, action: unknown) {
  if (!exactFields(action, ["profile", "target", "metricId", "parameters"]) || action.profile !== "odap.metric-read.v1" ||
      !postgresText(action.target, 1024) || !action.target.trim() || !postgresText(action.metricId, 1024) || !action.metricId.trim() ||
      !action.parameters || typeof action.parameters !== "object" || Object.getPrototypeOf(action.parameters) !== Object.prototype ||
      Object.keys(action.parameters).length > 16 || !Object.entries(action.parameters).every(([key, value]) =>
        /^[A-Za-z_][A-Za-z_0-9]{0,62}$/.test(key) && (value === null || typeof value === "boolean" || postgresText(value, 4096) ||
          (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)))) ||
      canonicalControlJson(action).length > 65536) throw new Error("PostgreSQL request unavailable");
  // The session marker matches human PostgreSQL contracts; it is not a signed Agent.
  return recordMissingReleaseDenial(access, "pg-missing-" + crypto.randomUUID(), "postgresql-session", releaseId,
    { target: action.target, metricId: action.metricId, parameters: action.parameters as Record<string, string | number | boolean | null> });
}
