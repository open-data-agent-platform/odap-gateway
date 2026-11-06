import { jsonResponse } from "./auth-request";
import type { AuthEnv } from "./auth";
import type { AdminStorageEnv } from "./admin-store";
import { authorizeControlRequest } from "./control-storage";

export const routeId = /^[a-zA-Z0-9_-]{1,128}$/;
export const commandError = (status: number, code: string) => jsonResponse({ ok: false, code }, { status });

export function commandRequestError(request: Request, tenant: string) {
  if (!routeId.test(tenant)) return commandError(400, "invalid_control_path");
  if (request.headers.get("Origin") !== new URL(request.url).origin) return commandError(403, "same_origin_required");
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return commandError(415, "json_required");
  }
  return null;
}

export function exactFields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

type OwnerCommand = "validation" | "approval" | "promotion" | "withdrawal" | "retirement" | "human_grant" | "human_grant_review" | "receipt_correction";

export function parseGrantReview(d: unknown) {
  const label = (v: unknown): v is string => typeof v === "string" && !!v && v === v.trim() && v.length <= 256;
  if (!exactFields(d, ["requesterId", "requestId", "releaseId", "requestedAgentId", "policyRevision", "reviewedAction"]) ||
      !label(d.requesterId) || !label(d.policyRevision) || typeof d.requestId !== "string" || !routeId.test(d.requestId) ||
      typeof d.releaseId !== "string" || !routeId.test(d.releaseId) ||
      typeof d.requestedAgentId !== "string" || !routeId.test(d.requestedAgentId) ||
      !exactFields(d.reviewedAction, ["profile", "metricId", "target", "parameters"])) return null;
  return { requesterId: d.requesterId, requestId: d.requestId, releaseId: d.releaseId, requestedAgentId: d.requestedAgentId,
    policyRevision: d.policyRevision, reviewedAction: d.reviewedAction };
}

const scopedIdFields = { contract_issuance: "delegationId", budget_admission: "contractId", job_preparation: "intentId" };
type ScopedCommand = keyof typeof scopedIdFields;

export async function readCommandBody(request: Request, maxBytes: number, kind: "proposal" | "contract_request" | "metric_preview" | "delegation" | "delegation_proof" | ScopedCommand | OwnerCommand) {
  if (Number(request.headers.get("Content-Length")) > maxBytes) return commandError(413, kind + "_too_large");
  if (!request.body) return commandError(400, "invalid_" + kind);
  const reader = request.body.getReader(), bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - size) {
        await reader.cancel();
        return commandError(413, kind + "_too_large");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    return { data };
  } catch {
    return commandError(400, "invalid_" + kind);
  } finally {
    reader.releaseLock();
  }
}

export type TenantCommandContext = { request: Request; env: AuthEnv & AdminStorageEnv; params: { tenant: string } };
export type DelegationContext = TenantCommandContext & { env: { ODAP_DELEGATION_AUDIENCE?: string } };

export async function readScopedContractCommand({ request, env, params }: DelegationContext, kind: ScopedCommand) {
  const invalid = commandRequestError(request, params.tenant);
  if (invalid) return invalid;
  const auth = await authorizeControlRequest(request, env, params.tenant);
  if (!auth.ok) return commandError(auth.status, auth.code);
  if (kind === "job_preparation" && auth.role !== "owner") return commandError(403, "job_preparation_denied");
  const audience = env.ODAP_DELEGATION_AUDIENCE;
  if (!audience || !routeId.test(audience)) return commandError(503, "delegation_not_configured");
  const body = await readCommandBody(request, 2048, kind);
  if (body instanceof Response) return body;
  const key = scopedIdFields[kind];
  const id = exactFields(body.data, [key]) ? body.data[key] : undefined;
  if (typeof id !== "string" || !routeId.test(id)) return commandError(400, "invalid_" + kind);
  return { access: auth.access, audience, id };
}

export async function readOwnerCommand({ request, env, params }: TenantCommandContext, kind: OwnerCommand) {
  const invalid = commandRequestError(request, params.tenant);
  if (invalid) return invalid;
  const auth = await authorizeControlRequest(request, env, params.tenant);
  if (!auth.ok) return commandError(auth.status, auth.code);
  if (auth.role !== "owner") return commandError(403, kind + "_denied");
  // A human grant repeats the admitted action inside a larger review envelope.
  const body = await readCommandBody(request, kind === "human_grant" || kind === "human_grant_review" ? 16 * 1024 : 8 * 1024, kind);
  return body instanceof Response ? body : { access: auth.access, data: body.data };
}
