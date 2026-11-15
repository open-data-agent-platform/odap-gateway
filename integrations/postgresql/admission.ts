export class PostgresHostBusy extends Error {
  constructor() { super("PostgreSQL host execution capacity unavailable"); }
}

// This local, queue-free admission bound includes provider preparation. It is
// separate from the durable cross-host claim limit and never releases that limit.
export function postgresHostAdmission(maximum = 8) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) {
    throw new Error("PostgreSQL host execution limit must be an integer from 1 to 1000");
  }
  let active = 0;
  return async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw new Error("PostgreSQL host request aborted");
    if (active >= maximum) throw new PostgresHostBusy();
    active++;
    try { return await run(); }
    finally { active--; }
  };
}
