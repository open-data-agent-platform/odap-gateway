import type { D1Database } from "../../lib/d1";
import { approvePostgresAgentRead, requestPostgresRead } from "../../lib/postgresql-control";
import { delegatePostgresRead, postgresAgentChallenges } from "../../lib/postgresql-agent";
import { pgAccess, pgAction, pgRun } from "./postgresql-control";

export const pgAgentOrigin = "https://gateway.test";
export async function enrollPostgresAgent(db: D1Database, agentId = "agent-one", keyId = "key-one") {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicHex = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  await pgRun(db, "INSERT INTO agent_verification_keys(tenant_id,agent_id,key_id,public_hex) VALUES('tenant-a',?,?,?)", [agentId, keyId, publicHex]);
  return { keys, publicHex, sign: async (text: string) => Buffer.from(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(text))).toString("hex") };
}
export async function approvePostgresAgentFixture(db: D1Database, requestId = "agent-request") {
  const key = await enrollPostgresAgent(db);
  await requestPostgresRead(pgAccess(db), { requestId, releaseId: "release", action: pgAction });
  const delegation = await delegatePostgresRead(pgAccess(db), pgAgentOrigin, { requestId, agentId: "agent-one", keyId: "key-one" });
  // Keep the two database-clock expiries distinct, including under native D1.
  await new Promise(resolve => setTimeout(resolve, 20));
  const approval = { requestId, releaseId: "release", sourceId: "revision-1", requesterId: "google:reader", reviewedAction: pgAction,
    delegationId: delegation.delegationId, agentId: "agent-one", keyId: "key-one" };
  const contract = await approvePostgresAgentRead(pgAccess(db, "owner"), pgAgentOrigin, approval);
  const challenges = await postgresAgentChallenges(pgAccess(db), pgAgentOrigin, delegation.delegationId);
  return { ...key, ...delegation, ...contract, challenges, approval, signature: await key.sign(challenges.execute), inspectSignature: await key.sign(challenges.inspect) };
}
