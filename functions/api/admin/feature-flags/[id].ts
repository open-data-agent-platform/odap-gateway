import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import {
  updateFeatureRollout,
  type AdminStorageEnv
} from "../../../../lib/admin-store";
import { type AuthEnv } from "../../../../lib/auth";
import { readAdminJsonBody } from "../../../../lib/admin-command-request";

type FeatureFlagContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    id?: string;
  };
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

  const body = await readAdminJsonBody(context.request);
  if (!body.ok) {
    return jsonResponse({ ok: false,
      code: body.status === 400 ? "invalid_rollout" : body.code,
      message: body.status === 400 ? "Rollout must be a number." : body.message
    }, { status: body.status });
  }
  const rollout = body.value.rollout;
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
    auth.session
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
