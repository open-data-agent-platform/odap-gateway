import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, readScopedContractCommand, type DelegationContext } from "../../../../lib/control-command-request";
import { requestDelegatedCancellation } from "../../../../lib/delegated-cancellation";
import { DelegatedClaimUnavailableError } from "../../../../lib/delegated-job-recovery";

export async function onRequestPost(context: DelegationContext) {
  try {
    if (new URL(context.request.url).search) return commandError(400, "invalid_cancellation_request");
    const scoped = await readScopedContractCommand(context, "cancellation_request");
    if (scoped instanceof Response) return scoped;
    const saved = await requestDelegatedCancellation(scoped.access, scoped.audience, scoped.id);
    const request = saved.request;
    if (!request?.verified || typeof request.requestedAt !== "string") return commandError(409, "cancellation_request_unavailable");
    // A replay acknowledges the original owner request, never a send or terminal result.
    return jsonResponse({ ok: true, cancellationRequest: { tenantId: scoped.access.tenantId, intentId: scoped.id,
      requestedBy: request.requestedBy, requestedAt: request.requestedAt, scope: "recorded-request-only",
      providerContacted: false, cancellationConfirmed: false, cancellationAuthorized: false,
      executionAuthorized: false, settlementAuthorized: false } });
  } catch (error) {
    return error instanceof DelegatedClaimUnavailableError ? commandError(403, "tenant_access_denied") :
      commandError(503, "control_storage_unavailable");
  }
}
