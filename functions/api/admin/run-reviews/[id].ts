import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import {
  getQueryRunDetail,
  updateRunReviewStatus,
  type AdminStorageEnv
} from "../../../../lib/admin-store";
import { type AuthEnv } from "../../../../lib/auth";
import { type QueryRunStatus } from "../../../../lib/phase2";

type RunReviewContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    id?: string;
  };
};

type RunReviewBody = {
  status?: unknown;
};

export async function onRequestGet(context: RunReviewContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const id = context.params.id?.trim();
  if (!id) {
    return jsonResponse(
      {
        ok: false,
        code: "run_review_id_required",
        message: "Run review id is required."
      },
      { status: 400 }
    );
  }

  const result = await getQueryRunDetail(context.env, id);
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
    run: result.value
  });
}

export async function onRequestPatch(context: RunReviewContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const id = context.params.id?.trim();
  if (!id) {
    return jsonResponse(
      {
        ok: false,
        code: "run_review_id_required",
        message: "Run review id is required."
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

  const status = body.value.status;
  if (status !== "approved" && status !== "blocked") {
    return jsonResponse(
      {
        ok: false,
        code: "invalid_run_status",
        message: "Run reviews can only be approved or blocked."
      },
      { status: 400 }
    );
  }

  const result = await updateRunReviewStatus(
    context.env,
    id,
    status satisfies QueryRunStatus,
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

  return jsonResponse({
    ok: true,
    review: result.value
  });
}

async function readJsonBody(
  request: Request
): Promise<
  | { ok: true; value: RunReviewBody }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
