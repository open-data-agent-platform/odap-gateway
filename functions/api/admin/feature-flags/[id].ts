import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import {
  updateFeatureRollout,
  type AdminStorageEnv
} from "../../../../lib/admin-store";
import { type AuthEnv } from "../../../../lib/auth";

type FeatureFlagContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    id?: string;
  };
};

type RolloutBody = {
  rollout?: unknown;
};

export async function onRequestPatch(context: FeatureFlagContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const id = context.params.id;
  if (!id) {
    return jsonResponse(
      {
        ok: false,
        code: "missing_feature_flag_id",
        message: "Feature flag id is required."
      },
      { status: 400 }
    );
  }

  const body = await readJsonBody(context.request);
  const rollout = body?.rollout;
  if (typeof rollout !== "number") {
    return jsonResponse(
      {
        ok: false,
        code: "invalid_rollout",
        message: "Rollout must be a number."
      },
      { status: 400 }
    );
  }

  const result = await updateFeatureRollout(
    context.env,
    id,
    rollout,
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
    featureFlag: result.value
  });
}

async function readJsonBody(request: Request): Promise<RolloutBody | null> {
  try {
    const body = (await request.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
