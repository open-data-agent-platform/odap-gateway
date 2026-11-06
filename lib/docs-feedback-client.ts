import { gatewayPath } from "./gateway-path";
import type { PublicDocsFeedback } from "./docs-content";
import type { DocsFeedbackSubmission } from "./docs-feedback";

export type FeedbackListResult = { state: "ready"; feedback: PublicDocsFeedback[] } | { state: "unavailable" };
export type FeedbackSubmitResult = { state: "confirmed"; feedback: PublicDocsFeedback } | { state: "unconfirmed" };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stored = (body: Record<string, unknown>) => body.ok === true && body.persisted === true &&
  (body.storageBinding === "ODAP_GATEWAY_DB" || body.storageBinding === "DB");

function feedback(value: unknown): PublicDocsFeedback | null {
  if (!record(value) || !text(value.id) || (value.kind !== "question" && value.kind !== "comment") ||
      !text(value.topic) || !text(value.authorName) || !text(value.message) || !text(value.createdAt) ||
      (value.status !== "approved" && value.status !== "pending") ||
      [value.answerText,value.answeredBy,value.answeredAt].some(item => item !== undefined && !text(item))) return null;
  // Copy only public fields; unexpected server fields never enter UI state.
  return {id:value.id,kind:value.kind,topic:value.topic,authorName:value.authorName,message:value.message,
    status:value.status,createdAt:value.createdAt,answerText:value.answerText as string | undefined,
    answeredBy:value.answeredBy as string | undefined,answeredAt:value.answeredAt as string | undefined};
}

export async function loadDocsFeedback(signal: AbortSignal, send: typeof fetch = fetch): Promise<FeedbackListResult> {
  try {
    const response = await send(gatewayPath("/api/docs/feedback"), {method:"GET",credentials:"same-origin",
      cache:"no-store",redirect:"error",signal});
    if (response.status !== 200 || response.redirected) return {state:"unavailable"};
    const body: unknown = await response.json();
    if (!record(body) || !stored(body) || !Array.isArray(body.feedback)) return {state:"unavailable"};
    const items = body.feedback.map(feedback);
    if (items.some(item => !item || item.status !== "approved") ||
        new Set(items.map(item => item?.id)).size !== items.length) return {state:"unavailable"};
    return {state:"ready",feedback:items as PublicDocsFeedback[]};
  } catch {return {state:"unavailable"};}
}

export async function sendDocsFeedback(input: DocsFeedbackSubmission & {company:string}, signal: AbortSignal,
  send: typeof fetch = fetch): Promise<FeedbackSubmitResult> {
  try {
    const response = await send(gatewayPath("/api/docs/feedback"), {method:"POST",credentials:"same-origin",
      cache:"no-store",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),signal});
    if (response.status !== 200 || response.redirected) return {state:"unconfirmed"};
    const body: unknown = await response.json();
    if (!record(body) || !stored(body) || body.accepted !== true || body.pendingReview !== true) return {state:"unconfirmed"};
    const item = feedback(body.feedback);
    if (!item || item.status !== "pending" || item.answerText !== undefined ||
        item.answeredBy !== undefined || item.answeredAt !== undefined) return {state:"unconfirmed"};
    return {state:"confirmed",feedback:item};
  } catch {return {state:"unconfirmed"};}
}
