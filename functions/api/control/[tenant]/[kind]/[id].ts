import { jsonResponse } from "../../../../../lib/auth-request";
import { readEffectiveContract } from "../../../../../lib/contract-lifecycle";
import { readOwnProposal } from "../../../../../lib/contract-requests";
import { readOwnDelegation } from "../../../../../lib/agent-delegations";
import { readOwnIssuance } from "../../../../../lib/delegated-issuance";
import { readBudgetQuote, readOwnAdmission } from "../../../../../lib/delegated-admission";
import { readOwnIntentReceipt } from "../../../../../lib/requester-intent-receipt";
import { routeId } from "../../../../../lib/control-command-request";
import { isEvidenceReceipt } from "../../../../../lib/control-objects";
import { summarizeReceipt } from "../../../../../lib/receipt-summary";
import { receiptPathId } from "../../../../../lib/receipt-id";
import { readReceiptExplanation } from "../../../../../lib/receipt-reason-correction";
import { readApprovalBasis, readReviewDefinition, readSemanticReview } from "../../../../../lib/semantic-review";
import type { AuthEnv } from "../../../../../lib/auth";
import type { AdminStorageEnv } from "../../../../../lib/admin-store";
import { authorizeControlRequest, readControlObject, type ControlAccess, type ControlKind } from "../../../../../lib/control-storage";

const requesterReads = new Map<string, (access: ControlAccess, audience: string, id: string) => Promise<unknown>>([
  ["grant-delegation", readOwnDelegation], ["delegation-issuance", readOwnIssuance],
  ["budget-quote", readBudgetQuote], ["contract-admission", readOwnAdmission], ["intent-receipt", readOwnIntentReceipt]
]);

export async function onRequestGet(context: {
  request: Request; env: AuthEnv & AdminStorageEnv & { ODAP_DELEGATION_AUDIENCE?: string };
  params: { tenant: string; kind: string; id: string };
}) {
  const { tenant, kind } = context.params;
  const { search, searchParams } = new URL(context.request.url);
  const receiptSummary = kind === "receipt" && searchParams.size === 1 && searchParams.get("view") === "summary";
  const explanation = kind === "receipt-explanations";
  const id = receiptSummary || explanation ? receiptPathId(context.params.id) :
    routeId.test(context.params.id) ? context.params.id : null;
  const lookup = requesterReads.get(kind);
  if (!routeId.test(tenant) || !id ||
      (!explanation && !lookup && !["release", "contract", "receipt", "review", "definition", "approval-basis", "contract-request"].includes(kind))) {
    return jsonResponse({ ok: false, code: "invalid_control_path" }, { status: 400 });
  }
  try {
    const auth = await authorizeControlRequest(context.request, context.env, tenant);
    if (!auth.ok) return jsonResponse({ ok: false, code: auth.code }, { status: auth.status });
    if (explanation) {
      if (auth.role !== "owner") return jsonResponse({ ok: false, code: "receipt_correction_denied" }, { status: 403 });
      if (search) return jsonResponse({ ok: false, code: "invalid_receipt_view" }, { status: 400 });
      const object = await readReceiptExplanation(auth.access, id);
      return object ? jsonResponse({ ok: true, object }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
    }
    if (lookup) {
      const audience = context.env.ODAP_DELEGATION_AUDIENCE;
      if (!audience || !routeId.test(audience)) return jsonResponse({ ok: false, code: "delegation_not_configured" }, { status: 503 });
      const object = await lookup(auth.access, audience, id);
      return object ? jsonResponse({ ok: true, object }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
    }
    if (kind === "contract-request") {
      const views = new URL(context.request.url).searchParams.getAll("view");
      if (views.length && (views.length !== 1 || views[0] !== "grant-history")) {
        return jsonResponse({ ok: false, code: "invalid_request_view" }, { status: 400 });
      }
      const object = await readOwnProposal(auth.access, id, views.length === 1);
      return object ? jsonResponse({ ok: true, object }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
    }
    if (kind === "approval-basis") {
      const basis = await readApprovalBasis(auth.access, id);
      return basis ? jsonResponse({ ok: true, basis }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
    }
    if (kind === "definition") {
      const revision = await readReviewDefinition(auth.access, id);
      return revision ? jsonResponse({ ok: true, revision }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
    }
    if (kind === "review") {
      const review = await readSemanticReview(auth.access, id);
      return review ? jsonResponse({ ok: true, review }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
    }
    if (kind === "receipt") {
      // A misspelled summary request must never fall through to the legacy full object.
      if (search && !receiptSummary) return jsonResponse({ ok: false, code: "invalid_receipt_view" }, { status: 400 });
    }
    const object = kind === "contract" ? await readEffectiveContract(auth.access, id) : await readControlObject(auth.access, kind as ControlKind, id);
    if (receiptSummary && object) {
      if (!isEvidenceReceipt(object)) throw new Error("Invalid stored receipt");
      return jsonResponse({ ok: true, summary: summarizeReceipt(object) });
    }
    return object ? jsonResponse({ ok: true, object }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
  } catch {
    return jsonResponse({ ok: false, code: "control_storage_unavailable" }, { status: 503 });
  }
}
