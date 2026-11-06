type JobRef = { projectId: string; location: string; jobId: string };
export type BillingKey = { tenantId: string; jobReference: JobRef };
type FinalCharge = BillingKey & { status: "final"; unit: "micro-USD"; reference: string; amount: number };

export function attributedCharge(value: unknown, key: BillingKey): value is BillingKey & { status?: unknown } {
  if (!value || typeof value !== "object") return false;
  const bill = value as Partial<BillingKey>;
  return bill.tenantId === key.tenantId && bill.jobReference?.projectId === key.jobReference.projectId &&
    bill.jobReference.location === key.jobReference.location && bill.jobReference.jobId === key.jobReference.jobId;
}

export function validCharge(value: unknown, key: BillingKey): value is FinalCharge {
  if (!attributedCharge(value,key)) return false;
  const bill = value as Partial<FinalCharge>;
  return bill.status === "final" && bill.unit === "micro-USD" && typeof bill.reference === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(bill.reference) &&
    typeof bill.amount === "number" && Number.isSafeInteger(bill.amount) && bill.amount >= 0;
}
