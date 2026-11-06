import { jsonResponse } from "../../../lib/auth-request";
import {
  listPublicDocsFeedback,
  submitDocsFeedback,
  type DocsFeedbackEnv
} from "../../../lib/docs-feedback";
import type { DocsFeedbackKind } from "../../../lib/docs-content";
import { readBoundedRequestJson } from "../../../lib/request-json";

type DocsFeedbackContext = {
  request: Request;
  env: DocsFeedbackEnv;
};

type DocsFeedbackBody = {
  kind?: unknown;
  topic?: unknown;
  authorName?: unknown;
  authorEmail?: unknown;
  message?: unknown;
  company?: unknown;
};

export async function onRequestGet(context: DocsFeedbackContext) {
  const result = await listPublicDocsFeedback(context.env);

  return jsonResponse({
    ok: true,
    feedback: result.feedback,
    persisted: result.persisted,
    storageBinding: result.storageBinding
  });
}

export async function onRequestPost(context: DocsFeedbackContext) {
  const body = await readJsonBody(context.request);
  if (!body.ok) {
    return jsonResponse(
      {
        ok: false,
        code: body.code,
        message: body.message
      },
      { status: body.status }
    );
  }

  if (getString(body.value.company)) {
    return jsonResponse({
      ok: true,
      accepted: true,
      pendingReview: true,
      feedback: null,
      persisted: false,
      storageBinding: null
    });
  }

  const result = await submitDocsFeedback(context.env, {
    kind: getString(body.value.kind) as DocsFeedbackKind,
    topic: getString(body.value.topic),
    authorName: getString(body.value.authorName),
    authorEmail: getString(body.value.authorEmail),
    message: getString(body.value.message)
  });

  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        code: result.code,
        message: result.message
      },
      { status: result.status }
    );
  }

  return jsonResponse({
    ok: true,
    accepted: true,
    pendingReview: true,
    feedback: result.feedback,
    persisted: result.persisted,
    storageBinding: result.storageBinding
  });
}

async function readJsonBody(
  request: Request
): Promise<
  | { ok: true; value: DocsFeedbackBody }
  | { ok: false; status: number; code: string; message: string }
> {
  const body = await readBoundedRequestJson(request, 16 * 1024);
  if (!body.ok) {
    if (body.reason === "too_large") return { ok: false, status: 413, code: "feedback_too_large",
      message: "Feedback request body must be 16384 bytes or less." };
    if (body.reason === "timeout") return { ok: false, status: 408, code: "feedback_timeout",
      message: "Feedback request body read timed out." };
    return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON." };
  }
  if (!isRecord(body.value)) return { ok: false, status: 400, code: "invalid_json",
    message: "Request body must be a JSON object." };
  return { ok: true, value: body.value };
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
