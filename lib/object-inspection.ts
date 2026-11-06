import { isReceiptId } from "./receipt-id";

export type ObjectInspection<T> = { state: "ready"; snapshot: T } |
  { state: "invalid" | "unauthenticated" | "denied" | "not_found" | "unavailable" };

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export async function inspectObject<T>(tenant: string, id: string, kind: "receipt" | "receipt-explanations" | "contract" | "contract-request" | "grant-delegation" | "delegation-issuance" | "budget-quote" | "contract-admission" | "intent-receipt",
  signal: AbortSignal, get: typeof fetch, project: (value: unknown) => T | null): Promise<ObjectInspection<T>> {
  const summary = kind === "receipt";
  const explanation = kind === "receipt-explanations";
  if (!idPattern.test(tenant) || !(summary || explanation ? isReceiptId(id) : idPattern.test(id))) return { state: "invalid" };
  try {
    const view = summary ? "?view=summary" : kind === "contract-request" ? "?view=grant-history" : "";
    const res = await get("/api/control/" + tenant + "/" + kind + "/" + encodeURIComponent(id) + view, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
    const body = await res.json();
    if (res.status === 401 && body?.ok === false && body.code === "unauthenticated") return { state: "unauthenticated" };
    if (res.status === 403 && body?.ok === false && (body.code === "tenant_access_denied" ||
        (explanation && body.code === "receipt_correction_denied"))) return { state: "denied" };
    if (res.status === 404 && body?.ok === false && body.code === "not_found") return { state: "not_found" };
    const snapshot = res.status === 200 && body?.ok === true ? project(summary ? body.summary : body.object) : null;
    return snapshot === null ? { state: "unavailable" } : { state: "ready", snapshot };
  } catch {
    return { state: "unavailable" };
  }
}
