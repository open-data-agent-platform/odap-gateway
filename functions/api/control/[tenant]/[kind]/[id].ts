import { jsonResponse } from "../../../../../lib/auth-request";
import { readEffectiveContract } from "../../../../../lib/contract-lifecycle";
import type { AuthEnv } from "../../../../../lib/auth";
import type { AdminStorageEnv } from "../../../../../lib/admin-store";
import { authorizeControlRequest, readControlObject, type ControlKind } from "../../../../../lib/control-storage";

export async function onRequestGet(context: {
  request: Request; env: AuthEnv & AdminStorageEnv;
  params: { tenant: string; kind: string; id: string };
}) {
  const { tenant, kind, id } = context.params;
  if (![tenant, id].every(value => /^[a-zA-Z0-9_-]{1,128}$/.test(value)) || !["release", "contract", "receipt"].includes(kind)) {
    return jsonResponse({ ok: false, code: "invalid_control_path" }, { status: 400 });
  }
  try {
    const auth = await authorizeControlRequest(context.request, context.env, tenant);
    if (!auth.ok) return jsonResponse({ ok: false, code: auth.code }, { status: auth.status });
    const object = kind === "contract" ? await readEffectiveContract(auth.access, id) : await readControlObject(auth.access, kind as ControlKind, id);
    return object ? jsonResponse({ ok: true, object }) : jsonResponse({ ok: false, code: "not_found" }, { status: 404 });
  } catch {
    return jsonResponse({ ok: false, code: "control_storage_unavailable" }, { status: 503 });
  }
}
