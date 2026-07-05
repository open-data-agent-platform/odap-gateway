import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import { type AuthEnv } from "../../../../lib/auth";
import {
  recordAuditEvent,
  type AdminStorageEnv
} from "../../../../lib/admin-store";
import {
  updateDocsFeedbackReview,
  type DocsFeedbackEnv,
  type DocsFeedbackReviewInput
} from "../../../../lib/docs-feedback";

type DocsFeedbackReviewContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv & DocsFeedbackEnv;
  params: {
    id?: string;
  };
};

type ReviewBody = {
  status?: unknown;
  answerText?: unknown;
};

export async function onRequestPatch(context: DocsFeedbackReviewContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const id = context.params.id;
  if (!id) {
    return jsonResponse(
      {
        ok: false,
        code: "missing_docs_feedback_id",
        message: "Docs feedback id is required."
      },
      { status: 400 }
    );
  }

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

  if (
    body.value.status !== undefined &&
    body.value.status !== "approved" &&
    body.value.status !== "pending"
  ) {
    return jsonResponse(
      {
        ok: false,
        code: "invalid_docs_feedback_status",
        message: "Docs feedback status must be approved or pending."
      },
      { status: 400 }
    );
  }

  const input = normalizeReviewInput(body.value);
  const result = await updateDocsFeedbackReview(
    context.env,
    id,
    input,
    auth.session.email
  );

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

  await recordAuditEvent(context.env, {
    actorEmail: auth.session.email,
    action: "docs_feedback.reviewed",
    target: result.feedback.id,
    metadata: {
      status: result.feedback.status,
      answered: Boolean(result.feedback.answerText)
    }
  });

  return jsonResponse({
    ok: true,
    feedback: result.feedback
  });
}

async function readJsonBody(
  request: Request
): Promise<
  | { ok: true; value: ReviewBody }
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

function normalizeReviewInput(value: ReviewBody): DocsFeedbackReviewInput {
  return {
    status:
      value.status === "approved" || value.status === "pending"
        ? value.status
        : undefined,
    answerText: typeof value.answerText === "string" ? value.answerText : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
