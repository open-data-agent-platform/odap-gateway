// Simulate a restored inconsistency on a disposable copy. Billing triggers stay active.
export async function corruptTerminalEnrichment(run: (q: string, args: string[]) => Promise<unknown>, intentId: string) {
  await run(`INSERT INTO bigquery_terminal_observations
    (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,delegation_audience,claim_body_digest)
    SELECT tenant_id,intent_id,outcome,0,1,observed_by,delegation_audience,claim_body_digest
    FROM bigquery_terminal_observations WHERE tenant_id='t' AND intent_id=? AND has_bytes=0`, [intentId]);
  await run("DROP TRIGGER terminal_observation_no_update", []);
  await run("UPDATE bigquery_terminal_observations SET outcome='failed' WHERE tenant_id='t' AND intent_id=? AND has_bytes=1", [intentId]);
}
