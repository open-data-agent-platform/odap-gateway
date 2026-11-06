import type { D1Database, D1PreparedStatement, D1Value } from "../../lib/d1";

// Route-validation tests only. Revocation/mutation coverage uses real SQLite.
export function adminAuthority(provider = "google", providerId = "123", email = "owner@example.com"): D1Database {
  return {prepare(sql) {
    if (sql !== "SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?")
      throw new Error("Unexpected database access in authority-only fixture");
    let args: D1Value[] = [];
    const statement: D1PreparedStatement = {
      bind(...values) { args = values; return statement; },
      async first<T>() {
        return args.length === 3 && args[0] === provider+":"+providerId && args[1] === provider && args[2] === providerId
          ? {role:"admin",email} as T : null;
      },
      async all() { throw new Error("Unexpected authority list"); },
      async run() { throw new Error("Unexpected authority write"); }
    };
    return statement;
  }};
}
