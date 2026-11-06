import { jsonResponse } from "../../../../../lib/auth-request";
import { commandError, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../../lib/control-command-request";
import { authorizeControlRequest } from "../../../../../lib/control-storage";
import { receiptPathId } from "../../../../../lib/receipt-id";
import { appendReceiptReasonCorrection, InvalidReceiptCorrection, readReceiptReasonCorrection,
  ReceiptCorrectionConflict, ReceiptCorrectionUnavailable } from "../../../../../lib/receipt-reason-correction";

type Context = TenantCommandContext & { params: { tenant: string; id: string } };

function failure(error: unknown) {
  if (error instanceof InvalidReceiptCorrection) return commandError(400, "invalid_receipt_correction");
  if (error instanceof ReceiptCorrectionUnavailable) return commandError(404, "receipt_correction_unavailable");
  if (error instanceof ReceiptCorrectionConflict) return commandError(409, "receipt_correction_conflict");
  return commandError(503, "control_storage_unavailable");
}

export async function onRequestGet({ request, env, params: { tenant, id } }: Context) {
  const receiptId = receiptPathId(id);
  if (!routeId.test(tenant) || !receiptId) return commandError(400, "invalid_control_path");
  const query = new URL(request.url).searchParams;
  const raw = query.get("revision");
  const revision = raw === null ? undefined : Number(raw);
  if (query.size && (query.size !== 1 || !raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(revision)))
    return commandError(400, "invalid_receipt_correction_view");
  try {
    const auth = await authorizeControlRequest(request, env, tenant);
    if (!auth.ok) return commandError(auth.status, auth.code);
    if (auth.role !== "owner") return commandError(403, "receipt_correction_denied");
    const correction = await readReceiptReasonCorrection(auth.access, receiptId, revision);
    if (!correction && revision !== undefined) return commandError(404, "receipt_correction_unavailable");
    return jsonResponse({ ok: true, correction });
  } catch (error) { return failure(error); }
}

export async function onRequestPost(context: Context) {
  const receiptId = receiptPathId(context.params.id);
  if (!receiptId) return commandError(400, "invalid_control_path");
  if (new URL(context.request.url).search) return commandError(400, "invalid_receipt_correction_view");
  try {
    const input = await readOwnerCommand(context, "receipt_correction");
    if (input instanceof Response) return input;
    const correction = await appendReceiptReasonCorrection(input.access, receiptId, input.data);
    return jsonResponse({ ok: true, correction });
  } catch (error) { return failure(error); }
}
