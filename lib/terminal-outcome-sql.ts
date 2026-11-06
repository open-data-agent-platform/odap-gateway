// Only trusted query aliases are accepted. A byte-enriched sample is not a
// replacement for the original outcome.
export function terminalOutcomesConflict(alias: "i" | "o" | "j" | "c") {
  const intentColumn = alias === "i" ? "id" : "intent_id";
  return `(SELECT COUNT(DISTINCT sample.outcome)>1 FROM bigquery_terminal_observations sample
    WHERE sample.tenant_id=${alias}.tenant_id AND sample.intent_id=${alias}.${intentColumn})`;
}
