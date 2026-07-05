import { jsonResponse } from "../../../lib/auth-request";
import {
  listPublicDocsFeedback,
  submitDocsFeedback,
  type DocsFeedbackEnv
} from "../../../lib/docs-feedback";
import type { DocsFeedbackKind } from "../../../lib/docs-content";

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
      { status: 400 }
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
  | { ok: false; code: string; message: string }
> {
  try {
    const value = (await request.json()) as unknown;
    if (!isRecord(value)) {
      return {
        ok: false,
        code: "invalid_json",
        message: "Request body must be a JSON object."
      };
    }

    return {
      ok: true,
      value
    };
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Request body must be valid JSON."
    };
  }
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
