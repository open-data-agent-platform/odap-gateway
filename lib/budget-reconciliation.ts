import type { ControlAccess } from "./control-storage";

export const budgetReconciliationMaxRows = 1024;
const maxBytes = 4 * 1024 * 1024;
type Bucket = { recorded: number; settled: number; pending: number; actual: bigint; reserved: bigint };
type Snapshot = { limit_units: unknown; reserved_units: unknown; spent_units: unknown; overrun_units: unknown;
  sql_rows: unknown; auxiliary_rows: unknown; unattributed: unknown };
const bucket = (): Bucket => ({recorded:0,settled:0,pending:0,actual:0n,reserved:0n});
const invalid = () => new Error("Invalid budget accounting snapshot");
function units(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value,-0)) throw invalid();
  return BigInt(value);
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}
function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw invalid();
  return value === 1;
}
function rows(raw: unknown): Record<string, unknown>[] {
  if (typeof raw !== "string" || raw.length > maxBytes || new TextEncoder().encode(raw).length > maxBytes) throw invalid();
  let value: unknown;
  try {value=JSON.parse(raw);} catch {throw invalid();}
  if (!Array.isArray(value) || value.length > budgetReconciliationMaxRows ||
    value.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw invalid();
  return value;
}
function distinct(set: Set<string>, value: unknown) {
  const key = id(value);
  if (set.has(key)) throw invalid();
  set.add(key);
}
function add(target: Bucket, reserved: unknown, actual: unknown) {
  const hold = units(reserved);
  target.recorded++;
  if (actual === null) {target.pending++;target.reserved+=hold;}
  else {target.settled++;target.actual+=units(actual);}
}
const summarize = (value: Bucket) => ({recorded:value.recorded,settled:value.settled,pending:value.pending,
  recordedActualMicroUsd:value.actual.toString(),pendingReservedMicroUsd:value.reserved.toString()});

function audit(kind: "reserved" | "settled", alias: "r" | "s") {
  return `(SELECT count(*)=1 AND coalesce(min(e.actor=${alias}.actor AND e.recorded_at=${alias}.recorded_at),0)
    FROM control_object_events e WHERE e.tenant_id=r.tenant_id AND e.object_id=r.id
      AND e.object_kind='auxiliary_cost_${kind}')`;
}

// One current-owner-scoped snapshot. Accounting visibility never grants execution or repair authority.
export async function readBudgetReconciliation(access: ControlAccess, budgetId: string) {
  id(budgetId);
  let row: Snapshot | null;
  try {
    row = await access.db.prepare(`SELECT b.limit_units,b.reserved_units,b.spent_units,b.overrun_units,
      (SELECT json_group_array(json(item)) FROM (
        SELECT json_object('id',i.id,'reservationId',i.reservation_id,'contractId',i.contract_id,
          'reserved',i.reserved_units,'receiptId',s.receipt_id,'actual',s.actual_units,
          'receiptLinked',CASE WHEN s.intent_id IS NULL THEN 1 ELSE EXISTS(
            SELECT 1 FROM evidence_receipts f JOIN approval_contracts c
              ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
            WHERE f.tenant_id=i.tenant_id AND f.id=s.receipt_id AND f.contract_id=i.contract_id
              AND f.release_id=c.release_id AND json_extract(f.payload,'$.intentId')=i.id
              AND json_extract(f.payload,'$.outcome') IN ('succeeded','failed','cancelled')) END) AS item
        FROM execution_intents i LEFT JOIN cost_settlements s ON s.tenant_id=i.tenant_id AND s.intent_id=i.id
        WHERE i.tenant_id=b.tenant_id AND i.budget_id=b.id ORDER BY i.id COLLATE BINARY LIMIT ${budgetReconciliationMaxRows+1}
      )) AS sql_rows,
      (SELECT json_group_array(json(item)) FROM (
        SELECT json_object('id',r.id,'intentId',r.intent_id,'kind',r.kind,'operationRef',r.operation_ref,
          'reserved',r.reserved_units,'actual',s.actual_units,'billingRef',s.billing_ref,'billedOperation',s.operation_ref,
          'reservationAudit',${audit("reserved","r")},'settlementAudit',CASE WHEN s.reservation_id IS NULL THEN
            NOT EXISTS(SELECT 1 FROM control_object_events e WHERE e.tenant_id=r.tenant_id AND e.object_id=r.id
              AND e.object_kind='auxiliary_cost_settled') ELSE ${audit("settled","s")} AND
              (SELECT max(sequence) FROM control_object_events WHERE tenant_id=r.tenant_id AND object_id=r.id
                AND object_kind='auxiliary_cost_settled') >
              (SELECT max(sequence) FROM control_object_events WHERE tenant_id=r.tenant_id AND object_id=r.id
                AND object_kind='auxiliary_cost_reserved') END) AS item
        FROM auxiliary_cost_reservations r JOIN execution_intents i ON i.tenant_id=r.tenant_id AND i.id=r.intent_id
        LEFT JOIN auxiliary_cost_settlements s ON s.tenant_id=r.tenant_id AND s.reservation_id=r.id
        WHERE i.tenant_id=b.tenant_id AND i.budget_id=b.id ORDER BY r.id COLLATE BINARY LIMIT ${budgetReconciliationMaxRows+1}
      )) AS auxiliary_rows,
      (EXISTS(SELECT 1 FROM execution_intents i WHERE i.tenant_id=b.tenant_id AND NOT EXISTS(
        SELECT 1 FROM control_budgets x WHERE x.tenant_id=i.tenant_id AND x.id=i.budget_id)) OR
       EXISTS(SELECT 1 FROM cost_settlements s WHERE s.tenant_id=b.tenant_id AND NOT EXISTS(
        SELECT 1 FROM execution_intents i WHERE i.tenant_id=s.tenant_id AND i.id=s.intent_id)) OR
       EXISTS(SELECT 1 FROM auxiliary_cost_reservations r WHERE r.tenant_id=b.tenant_id AND NOT EXISTS(
        SELECT 1 FROM execution_intents i WHERE i.tenant_id=r.tenant_id AND i.id=r.intent_id)) OR
       EXISTS(SELECT 1 FROM auxiliary_cost_settlements s WHERE s.tenant_id=b.tenant_id AND NOT EXISTS(
        SELECT 1 FROM auxiliary_cost_reservations r WHERE r.tenant_id=s.tenant_id AND r.id=s.reservation_id)) OR
       EXISTS(SELECT 1 FROM control_object_events e WHERE e.tenant_id=b.tenant_id
        AND e.object_kind IN ('auxiliary_cost_reserved','auxiliary_cost_settled') AND NOT EXISTS(
          SELECT 1 FROM auxiliary_cost_reservations r WHERE r.tenant_id=e.tenant_id AND r.id=e.object_id))) AS unattributed
      FROM control_budgets b WHERE b.tenant_id=? AND b.id=? AND EXISTS(
        SELECT 1 FROM control_memberships m WHERE m.tenant_id=b.tenant_id AND m.principal_id=? AND m.active=1 AND m.role='owner')`)
      .bind(access.tenantId,budgetId,access.principalId).first<Snapshot>();
  } catch {throw new Error("Budget accounting unavailable");}
  if (!row) return null;
  const limit = units(row.limit_units), reserved = units(row.reserved_units);
  const spent = units(row.spent_units), overrun = units(row.overrun_units);
  const sql = bucket(), model = bucket(), tool = bucket();
  const intents = new Set<string>(), reservations = new Set<string>(), contracts = new Set<string>(), receipts = new Set<string>();
  let invalidSqlReceipts = 0, invalidAuxiliaryAudits = 0, invalidAuxiliaryBills = 0;
  for (const entry of rows(row.sql_rows)) {
    distinct(intents,entry.id);distinct(reservations,entry.reservationId);distinct(contracts,entry.contractId);
    if (entry.actual !== null) distinct(receipts,entry.receiptId);
    else if (entry.receiptId !== null) throw invalid();
    if (!flag(entry.receiptLinked)) invalidSqlReceipts++;
    add(sql,entry.reserved,entry.actual);
  }
  const components = new Set<string>(), operations = new Set<string>(), bills = new Set<string>();
  for (const entry of rows(row.auxiliary_rows)) {
    distinct(components,entry.id);distinct(operations,entry.operationRef);
    if (!intents.has(id(entry.intentId)) || !["model","tool"].includes(entry.kind as string) || units(entry.reserved) === 0n) throw invalid();
    if (!flag(entry.reservationAudit) || !flag(entry.settlementAudit)) invalidAuxiliaryAudits++;
    if (entry.actual !== null) {
      distinct(bills,entry.billingRef);
      if (id(entry.billedOperation) !== entry.operationRef) invalidAuxiliaryBills++;
    } else if (entry.billingRef !== null || entry.billedOperation !== null) throw invalid();
    add(entry.kind === "model" ? model : tool,entry.reserved,entry.actual);
  }
  const expectedReserved = sql.reserved+model.reserved+tool.reserved;
  const expectedCharged = sql.actual+model.actual+tool.actual;
  const countersConsistent = expectedReserved === reserved && expectedCharged === spent+overrun && spent+reserved <= limit;
  const hasUnattributedRecords = flag(row.unattributed);
  const attributionConsistent = !hasUnattributedRecords && !invalidSqlReceipts && !invalidAuxiliaryAudits && !invalidAuxiliaryBills;
  return {scope:"recorded-budget-accounting-only" as const,tenantId:access.tenantId,budgetId,
    consistent:countersConsistent && attributionConsistent,countersConsistent,attributionConsistent,
    completeWorkflowCost:false as const,issuerAuthenticated:false as const,executionAuthorized:false as const,
    sql:summarize(sql),model:summarize(model),tool:summarize(tool),
    ledger:{limitMicroUsd:limit.toString(),reservedMicroUsd:reserved.toString(),spentMicroUsd:spent.toString(),overrunMicroUsd:overrun.toString()},
    totals:{recordedActualMicroUsd:expectedCharged.toString(),pendingReservedMicroUsd:expectedReserved.toString(),
      pendingComponents:sql.pending+model.pending+tool.pending},
    difference:{reservedMicroUsd:(expectedReserved-reserved).toString(),chargedMicroUsd:(expectedCharged-spent-overrun).toString()},
    issues:{hasUnattributedRecords,invalidSqlReceipts,invalidAuxiliaryAudits,invalidAuxiliaryBills}};
}
