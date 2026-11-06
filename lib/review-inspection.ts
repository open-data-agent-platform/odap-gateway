import { gatewayPath } from "./gateway-path";
import { isControlTimestamp, sha256Text } from "./control-objects";

const controlId = /^[A-Za-z0-9_-]{1,128}$/;
const states = ["candidate", "validated", "approved", "withdrawn", "published", "retired"] as const;

export type Inspection = {
  tenantId: string; revisionId: string; metricId: string; sourceRevision: string;
  state: typeof states[number]; definitionDigest: string; definitionJson: string;
  canRecordValidation: boolean;
  approvalEvidence?: string; approvalId?: string; canRequestPromotion: boolean; releaseId?: string;
  canWithdrawApproval: boolean; withdrawnAt?: string;
  canRetireRelease: boolean; retiredAt?: string | null;
};
type Failure = "invalid" | "signed_out" | "forbidden" | "not_found" | "unavailable" | "inconsistent";
export type InspectionResult = { ok: true; value: Inspection } | { ok: false; error: Failure };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isState = (v: unknown): v is Inspection["state"] => states.some(s => s === v);

export async function inspectRevision(tenantId: string, revisionId: string, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<InspectionResult> {
  if (!controlId.test(tenantId) || !controlId.test(revisionId)) return { ok: false, error: "invalid" };
  const options: RequestInit = { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal };
  const path = (kind: string) => gatewayPath("/api/control/") + tenantId + "/" + kind + "/" + revisionId;
  async function failure(res: Response): Promise<InspectionResult> {
    const body: unknown = await res.json().catch(() => null);
    const code = record(body) && body.ok === false ? body.code : null;
    return { ok: false, error: res.status === 401 && code === "unauthenticated" ? "signed_out"
      : res.status === 403 && code === "tenant_access_denied" ? "forbidden"
      : res.status === 404 && code === "not_found" ? "not_found" : "unavailable" };
  }
  try {
    const definition = await get(path("definition"), options);
    if (!definition.ok) return failure(definition);
    const body: unknown = await definition.json();
    const d = record(body) && body.ok === true ? body.revision : null;
    if (!record(d) || d.tenantId !== tenantId || d.revisionId !== revisionId ||
        typeof d.definitionJson !== "string" || typeof d.definitionDigest !== "string" ||
        await sha256Text(d.definitionJson) !== d.definitionDigest) return { ok: false, error: "inconsistent" };

    // Never present a definition beside another revision's status or evidence.
    const snapshot = await get(path("review"), options);
    if (!snapshot.ok) return failure(snapshot);
    const payload: unknown = await snapshot.json();
    const r = record(payload) && payload.ok === true ? payload.review : null;
    const metric: unknown = JSON.parse(d.definitionJson);
    if (!record(r) || !record(metric) || r.tenantId !== tenantId || r.revisionId !== revisionId ||
        r.definitionDigest !== d.definitionDigest || !isState(r.state) ||
        metric.tenantId !== tenantId || metric.profile !== "odap.bigquery-metric.v1" ||
        typeof r.metricId !== "string" || r.metricId !== metric.metricId ||
        typeof r.sourceRevision !== "string" || r.sourceRevision !== metric.sourceRevision) {
      return { ok: false, error: "inconsistent" };
    }
    let approvalEvidence: string | undefined;
    if (r.state === "validated" && r.canReviewApproval === true) {
      const res = await get(path("approval-basis"), options);
      if (!res.ok) return failure(res);
      const body: unknown = await res.json();
      const basis = record(body) && body.ok === true ? body.basis : null;
      if (!record(basis) || basis.tenantId !== tenantId || basis.revisionId !== revisionId ||
          basis.definitionDigest !== d.definitionDigest || typeof basis.evidenceRef !== "string" ||
          !basis.evidenceRef || basis.evidenceRef !== basis.evidenceRef.trim() || basis.evidenceRef.length > 1024) {
        return { ok: false, error: "inconsistent" };
      }
      approvalEvidence = basis.evidenceRef;
    }
    const approvalId = typeof r.approvalId === "string" && controlId.test(r.approvalId) ? r.approvalId : undefined;
    const released = r.state === "published" || r.state === "retired";
    const releaseId = typeof r.releaseId === "string" && controlId.test(r.releaseId) ? r.releaseId : undefined;
    if (released ? !releaseId || !approvalId : r.releaseId != null) return { ok: false, error: "inconsistent" };
    const withdrawnAt = typeof r.withdrawnAt === "string" && isControlTimestamp(r.withdrawnAt) ? r.withdrawnAt : undefined;
    if (r.state === "withdrawn" ? !withdrawnAt || !approvalId : r.withdrawnAt != null) return { ok: false, error: "inconsistent" };
    const retiredAt = r.retiredAt === null ? null : typeof r.retiredAt === "string" && isControlTimestamp(r.retiredAt) ? r.retiredAt : undefined;
    if (r.state === "retired" ? retiredAt === undefined : r.retiredAt != null) return { ok: false, error: "inconsistent" };
    return { ok: true, value: { tenantId, revisionId, state: r.state, metricId: r.metricId, approvalEvidence, approvalId, releaseId,
      retiredAt, canRetireRelease: r.state === "published" && r.canRetireRelease === true,
      withdrawnAt, canWithdrawApproval: r.state === "approved" && !!approvalId && r.canWithdrawApproval === true,
      canRequestPromotion: r.state === "approved" && !!approvalId && r.canRequestPromotion === true,
      canRecordValidation: r.state === "candidate" && r.canRecordValidation === true,
      sourceRevision: r.sourceRevision, definitionJson: d.definitionJson, definitionDigest: d.definitionDigest } };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function submitValidation(inspected: Inspection, evidenceRef: string, signal: AbortSignal,
  post: typeof fetch = fetch) {
  const { tenantId, revisionId } = inspected;
  if (!controlId.test(tenantId) || !controlId.test(revisionId) ||
      inspected.state !== "candidate" || !inspected.canRecordValidation) return "denied";
  if (!evidenceRef || evidenceRef !== evidenceRef.trim() || evidenceRef.length > 1024 || evidenceRef.includes("\0")) {
    return "invalid";
  }
  return sendDecision(inspected, evidenceRef, undefined, signal, post);
}

export function submitApproval(inspected: Inspection, approvalId: string, signal: AbortSignal, post: typeof fetch = fetch) {
  if (inspected.state !== "validated" || !inspected.approvalEvidence || !controlId.test(inspected.tenantId) ||
      !controlId.test(inspected.revisionId) || !controlId.test(approvalId)) return Promise.resolve("denied" as const);
  return sendDecision(inspected, inspected.approvalEvidence, approvalId, signal, post);
}

async function sendDecision({ tenantId, revisionId, definitionDigest }: Inspection, evidenceRef: string,
  approvalId: string | undefined, signal: AbortSignal, post: typeof fetch) {
  const kind = approvalId ? "approval" : "validation";
  try {
    const res = await postCommand(tenantId, kind, { revisionId, reviewedDigest: definitionDigest, evidenceRef, approvalId }, signal, post);
    const body: unknown = await res.json();
    if (!record(body)) return "unknown";
    const decision = body[kind];
    if (res.status === 201 && body.ok === true && record(decision) && decision.revisionId === revisionId &&
        res.headers.get("Location") === gatewayPath("/api/control/") + tenantId + "/review/" + revisionId) {
      if (approvalId && decision.approvalId === approvalId) return "approved";
      if (!approvalId && decision.definitionDigest === definitionDigest) return "recorded";
    }
    if (body.ok === false) {
      if (res.status === 409 && body.code === kind + "_not_recorded") return "conflict";
      if (!approvalId && res.status === 400 && body.code === "invalid_validation") return "invalid";
      if (res.status === 401 || res.status === 403) return "denied";
    }
  } catch { /* A failed response does not prove that the write failed. */ }
  return "unknown";
}

function postCommand(tenantId: string, kind: "approval" | "validation" | "promotion" | "withdrawal" | "retirement", payload: object,
  signal: AbortSignal, post: typeof fetch) {
  return post(gatewayPath("/api/control/") + tenantId + "/" + kind + "s", {
    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
}

export type WithdrawalReceipt =
  | { kind: "withdrawn" | "alreadyWithdrawn"; approvalId: string; withdrawnAt: string }
  | { kind: "publicationWon"; approvalId: string; releaseId: string };
type WithdrawalResult = WithdrawalReceipt | { kind: "invalidReason" | "denied" | "unknown" };

export type RetirementReceipt = { kind: "retired" | "alreadyRetired" | "legacyRetired"; releaseId: string; retiredAt: string | null };
type RetirementResult = RetirementReceipt | { kind: "invalidReason" | "denied" | "unknown" };

const validReason = (reason: string) => !!reason && reason === reason.trim() && reason.length <= 1024 && !reason.includes("\0");

export async function submitRetirement(inspected: Inspection, reason: string, signal: AbortSignal,
  post: typeof fetch = fetch): Promise<RetirementResult> {
  const { tenantId, releaseId } = inspected;
  if (inspected.state !== "published" || inspected.canRetireRelease !== true || !releaseId ||
      !controlId.test(tenantId) || !controlId.test(releaseId)) return { kind: "denied" };
  if (!validReason(reason)) return { kind: "invalidReason" };
  try {
    const res = await postCommand(tenantId, "retirement", { releaseId, reason }, signal, post);
    const body: unknown = await res.json();
    if (!record(body)) return { kind: "unknown" };
    const r = body.retirement;
    if (body.ok === true && body.effect === "future_dispatch_claims_only" && record(r) &&
        res.headers.get("Location") === gatewayPath("/api/control/") + tenantId + "/release/" + releaseId) {
      if (res.status === 200 && r.status === "legacy_retired" && !("retiredAt" in r)) return { kind: "legacyRetired", releaseId, retiredAt: null };
      if (typeof r.retiredAt === "string" && isControlTimestamp(r.retiredAt)) {
        if (res.status === 201 && r.status === "retired") return { kind: "retired", releaseId, retiredAt: r.retiredAt };
        if (res.status === 200 && r.status === "already_retired") return { kind: "alreadyRetired", releaseId, retiredAt: r.retiredAt };
      }
    }
    if (body.ok === false) {
      if (res.status === 400 && body.code === "invalid_retirement") return { kind: "invalidReason" };
      if (res.status === 401 || res.status === 403 || (res.status === 404 && body.code === "not_found")) return { kind: "denied" };
    }
  } catch { /* A lost confirmation does not authorize another write. */ }
  return { kind: "unknown" };
}

export async function submitWithdrawal(inspected: Inspection, reason: string, signal: AbortSignal,
  post: typeof fetch = fetch): Promise<WithdrawalResult> {
  const { tenantId, revisionId, approvalId } = inspected;
  if (inspected.state !== "approved" || inspected.canWithdrawApproval !== true || inspected.releaseId ||
      !approvalId || ![tenantId, revisionId, approvalId].every(id => controlId.test(id))) return { kind: "denied" };
  if (!validReason(reason)) return { kind: "invalidReason" };
  try {
    const res = await postCommand(tenantId, "withdrawal", { revisionId, approvalId, reason }, signal, post);
    const body: unknown = await res.json();
    if (!record(body)) return { kind: "unknown" };
    const w = body.withdrawal;
    if (body.ok === true && record(w) && typeof w.withdrawnAt === "string" && isControlTimestamp(w.withdrawnAt) &&
        res.headers.get("Location") === gatewayPath("/api/control/") + tenantId + "/review/" + revisionId) {
      if (res.status === 201 && w.status === "withdrawn") return { kind: "withdrawn", approvalId, withdrawnAt: w.withdrawnAt };
      if (res.status === 200 && w.status === "already_withdrawn") return { kind: "alreadyWithdrawn", approvalId, withdrawnAt: w.withdrawnAt };
    }
    if (body.ok === false) {
      if (res.status === 409 && body.code === "already_promoted" && typeof body.releaseId === "string" &&
          controlId.test(body.releaseId)) return { kind: "publicationWon", approvalId, releaseId: body.releaseId };
      if (res.status === 400 && body.code === "invalid_withdrawal") return { kind: "invalidReason" };
      if (res.status === 401 || res.status === 403 || (res.status === 404 && body.code === "not_found")) return { kind: "denied" };
    }
  } catch { /* The database may already have committed. Never retry the write here. */ }
  return { kind: "unknown" };
}

export async function submitPromotion(inspected: Inspection, releaseId: string, signal: AbortSignal, post: typeof fetch = fetch) {
  const { tenantId, revisionId, approvalId } = inspected;
  if (inspected.state !== "approved" || inspected.canRequestPromotion !== true || inspected.releaseId ||
      !approvalId || ![tenantId, revisionId, approvalId, releaseId].every(id => controlId.test(id))) return "denied";
  try {
    const res = await postCommand(tenantId, "promotion", { revisionId, approvalId, releaseId }, signal, post);
    const body: unknown = await res.json();
    if (!record(body)) return "unknown";
    if (res.status === 201 && body.ok === true && record(body.promotion) && body.promotion.releaseId === releaseId &&
        res.headers.get("Location") === gatewayPath("/api/control/") + tenantId + "/release/" + releaseId) return "published";
    if (body.ok === false) {
      if (res.status === 409 && body.code === "promotion_not_recorded") return "publicationRefused";
      if (res.status === 401 || res.status === 403) return "denied";
    }
  } catch { /* Recover the durable release ID by inspecting; never resend automatically. */ }
  return "unknown";
}
