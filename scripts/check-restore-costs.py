"""Compare recorded SQL/model/tool accounting in two detached Gateway snapshots."""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


MAX_ROWS = 10000
MAX_UNITS = 2**53 - 1
TABLES = {
    "control_budgets": "id,limit_units,reserved_units,spent_units,overrun_units",
    "execution_intents": "id,contract_id,budget_id,reservation_id,principal_id,action_digest,reserved_units,created_at",
    "cost_settlements": "intent_id,receipt_id,actual_units,actor,recorded_at",
    "auxiliary_cost_reservations": "id,intent_id,kind,operation_ref,operation_digest,reserved_units,actor,recorded_at",
    "auxiliary_cost_settlements": "reservation_id,operation_ref,billing_ref,actual_units,actor,recorded_at",
}


def inventory(db, table, columns, tenant, extra=""):
    # Table/column names and the optional predicate are fixed locally, never CLI input.
    rows = db.execute(f"SELECT {columns} FROM main.{table} WHERE tenant_id=? COLLATE BINARY {extra}",
                      (tenant,)).fetchmany(MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("inventory limit")
    result = {}
    names = columns.split(",")
    for values in rows:
        row = dict(zip(names, values))
        for key, value in row.items():
            if key.endswith("_units") or key == "sequence":
                if type(value) is not int or not 0 <= value <= MAX_UNITS:
                    raise ValueError("invalid counter")
            elif not isinstance(value, str) or not value.strip() or len(value) > 4096 or "\0" in value:
                raise ValueError("invalid binding")
        if values[0] in result:
            raise ValueError("duplicate identity")
        result[values[0]] = row
    return result


def unique(rows, column):
    values = [row[column] for row in rows.values()]
    if len(set(values)) != len(values):
        raise ValueError("duplicate binding")


def snapshot(path, tenant):
    with open_snapshot(path, "control_tenants", "control_object_events", "evidence_receipts", "approval_contracts", *TABLES) as db:
        if db.execute("SELECT id FROM main.control_tenants WHERE id=? COLLATE BINARY", (tenant,)).fetchmany(2) != [(tenant,)]:
            raise ValueError("missing tenant")
        tables = {name: inventory(db, name, columns, tenant) for name, columns in TABLES.items()}
        events = inventory(db, "control_object_events", "sequence,object_kind,object_id,actor,recorded_at", tenant,
                           "AND object_kind IN ('auxiliary_cost_reserved','auxiliary_cost_settled')")
        if db.execute("""SELECT 1 FROM main.cost_settlements s WHERE s.tenant_id=? COLLATE BINARY
            AND NOT EXISTS (SELECT 1 FROM main.execution_intents i
              JOIN main.approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
              JOIN main.evidence_receipts r ON r.tenant_id=i.tenant_id AND r.id=s.receipt_id
              WHERE i.tenant_id=s.tenant_id AND i.id=s.intent_id AND r.contract_id=i.contract_id
                AND r.release_id=c.release_id AND json_extract(r.payload,'$.intentId')=i.id
                AND json_extract(r.payload,'$.outcome') IN ('succeeded','failed','cancelled')) LIMIT 1""",
                      (tenant,)).fetchone():
            raise ValueError("unbound SQL receipt")
    budgets = tables["control_budgets"]
    intents = tables["execution_intents"]
    sql_bills = tables["cost_settlements"]
    components = tables["auxiliary_cost_reservations"]
    bills = tables["auxiliary_cost_settlements"]
    for rows, column in [(intents, "contract_id"), (intents, "reservation_id"), (sql_bills, "receipt_id"),
                         (components, "operation_ref"), (bills, "billing_ref")]:
        unique(rows, column)
    holds = {key: 0 for key in budgets}
    costs = {key: 0 for key in budgets}
    pending_sql = pending_auxiliary = sql_actual = auxiliary_actual = 0
    for key, row in intents.items():
        budget = row["budget_id"]
        if budget not in budgets:
            raise ValueError("unbound intent")
        if key not in sql_bills:
            holds[budget] += row["reserved_units"]
            pending_sql += row["reserved_units"]
    for key, row in sql_bills.items():
        if key not in intents:
            raise ValueError("unbound SQL settlement")
        costs[intents[key]["budget_id"]] += row["actual_units"]
        sql_actual += row["actual_units"]
    expected_events = {}
    for key, row in components.items():
        if (row["intent_id"] not in intents or row["kind"] not in ("model", "tool")
                or row["reserved_units"] == 0
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", row["operation_digest"])):
            raise ValueError("unbound auxiliary reservation")
        budget = intents[row["intent_id"]]["budget_id"]
        expected_events[("auxiliary_cost_reserved", key)] = row["actor"], row["recorded_at"]
        if key not in bills:
            holds[budget] += row["reserved_units"]
            pending_auxiliary += row["reserved_units"]
    for key, row in bills.items():
        if key not in components or row["operation_ref"] != components[key]["operation_ref"]:
            raise ValueError("unbound auxiliary settlement")
        budget = intents[components[key]["intent_id"]]["budget_id"]
        costs[budget] += row["actual_units"]
        auxiliary_actual += row["actual_units"]
        expected_events[("auxiliary_cost_settled", key)] = row["actor"], row["recorded_at"]
    seen_events = {}
    sequences = {}
    for seq, row in events.items():
        key = row["object_kind"], row["object_id"]
        if seq == 0 or key in seen_events:
            raise ValueError("duplicate audit binding")
        seen_events[key] = row["actor"], row["recorded_at"]
        sequences[key] = seq
    if seen_events != expected_events or any(
        sequences[("auxiliary_cost_reserved", key)] >= sequences[("auxiliary_cost_settled", key)]
        for key in bills
    ):
        raise ValueError("inconsistent auxiliary audit")
    mismatches = 0
    for key, row in budgets.items():
        # The spent/overrun split depends on historical settlement order; only their sum is invariant.
        mismatches += int(row["reserved_units"] != holds[key]
                          or row["spent_units"] + row["overrun_units"] != costs[key]
                          or row["reserved_units"] + row["spent_units"] > row["limit_units"])
    tables["auxiliary_audit"] = events
    report = dict(budgets=len(budgets), sqlIntents=len(intents), sqlSettlements=len(sql_bills),
                  auxiliaryComponents=len(components), auxiliarySettlements=len(bills),
                  pendingSqlIntents=len(intents) - len(sql_bills),
                  pendingAuxiliaryComponents=len(components) - len(bills),
                  pendingSqlMicroUsd=str(pending_sql), pendingAuxiliaryMicroUsd=str(pending_auxiliary),
                  sqlActualMicroUsd=str(sql_actual), auxiliaryActualMicroUsd=str(auxiliary_actual),
                  recordedActualMicroUsd=str(sql_actual + auxiliary_actual), inconsistentBudgets=mismatches)
    return tables, report


def compare(old, other):
    return dict(referenceOnly=len(other.keys() - old.keys()), restoredOnly=len(old.keys() - other.keys()),
                changed=sum(old[key] != other[key] for key in old.keys() & other.keys()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restored", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--tenant", required=True)
    args = parser.parse_args()
    try:
        if not args.tenant.strip() or len(args.tenant) > 256 or "\0" in args.tenant:
            raise ValueError("invalid tenant")
        restored, reference = distinct_snapshots(args.restored, args.reference)
        old, old_report = snapshot(restored, args.tenant)
        other, other_report = snapshot(reference, args.tenant)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("No comparison: unusable standalone snapshots, tenant or accounting bindings.", file=sys.stderr)
        return 2
    differences = {table: compare(old[table], other[table]) for table in old}
    different = any(any(counts.values()) for counts in differences.values())
    inconsistent = old_report["inconsistentBudgets"] + other_report["inconsistentBudgets"] > 0
    print(json.dumps(dict(costComparison="different" if different else "equal", differences=differences,
                          restored=old_report, reference=other_report, countersConsistent=not inconsistent,
                          scope="recorded-tenant-accounting-only", issuerAuthenticated=False,
                          completeWorkflowCost=False, retryAuthorized=False, servingAuthorized=False)))
    return int(different or inconsistent)


if __name__ == "__main__":
    sys.exit(main())
