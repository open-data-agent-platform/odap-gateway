import type { AuthEnv } from "../../../../lib/auth";
import type { AdminStorageEnv } from "../../../../lib/admin-store";
import { jsonResponse } from "../../../../lib/auth-request";
import { authorizeControlRequest } from "../../../../lib/control-storage";
import { commandError as fail, commandRequestError, exactFields, readCommandBody, routeId } from "../../../../lib/control-command-request";
import { InvalidSemanticRevision, proposeSemanticRevision, SemanticProposalNotRecorded } from "../../../../lib/semantic-candidate-storage";

async function proposalBody(request: Request) {
  const body = await readCommandBody(request, 48 * 1024, "proposal");
  if (body instanceof Response) return body;
  const { data } = body;
  try {
    if (!exactFields(data, ["revisionId", "ownerId", "provenanceRef", "definition"]) ||
        typeof data.revisionId !== "string" || !routeId.test(data.revisionId) || typeof data.ownerId !== "string" ||
        typeof data.provenanceRef !== "string" || !exactFields(data.definition,
          ["profile", "tenantId", "sourceRevision", "target", "metricId", "table", "measure", "filters"])) {
      return fail(400, "invalid_proposal");
    }
    return { revisionId: data.revisionId, ownerId: data.ownerId,
      provenanceRef: data.provenanceRef, definitionJson: JSON.stringify(data.definition) };
  } catch {
    return fail(400, "invalid_proposal");
  }
}

export async function onRequestPost({ request, env, params }: {
  request: Request; env: AuthEnv & AdminStorageEnv; params: { tenant: string };
}) {
  const invalid = commandRequestError(request, params.tenant);
  if (invalid) return invalid;
  try {
    const auth = await authorizeControlRequest(request, env, params.tenant);
    if (!auth.ok) return fail(auth.status, auth.code);
    if (auth.role !== "owner" && auth.role !== "reviewer") return fail(403, "proposal_denied");
    const input = await proposalBody(request);
    if (input instanceof Response) return input;
    const proposal = await proposeSemanticRevision(auth.access, input);
    return jsonResponse({ ok: true, proposal }, { status: 201,
      headers: { Location: "/api/control/" + params.tenant + "/review/" + proposal.revisionId } });
  } catch (error) {
    if (error instanceof InvalidSemanticRevision) return fail(400, "invalid_proposal");
    if (error instanceof SemanticProposalNotRecorded) return fail(409, "proposal_not_recorded");
    return fail(503, "control_storage_unavailable");
  }
}
