import { readBoundedRequestJson } from "./request-json";

type AdminBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

// Call only after verifying current administrator authority and route identifiers.
export async function readAdminJsonBody(request: Request): Promise<AdminBodyResult> {
  const body = await readBoundedRequestJson(request, 16 * 1024);
  if (!body.ok) {
    if (body.reason === "too_large") return { ok: false, status: 413, code: "admin_body_too_large",
      message: "Administrator request body must be 16384 bytes or less." };
    if (body.reason === "timeout") return { ok: false, status: 408, code: "admin_body_timeout",
      message: "Administrator request body read timed out." };
    return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON." };
  }
  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value))
    return { ok: false, status: 400, code: "invalid_json", message: "Request body must be a JSON object." };
  return { ok: true, value: body.value as Record<string, unknown> };
}
