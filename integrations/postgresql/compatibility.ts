export const POSTGRES_SERVER_VERSIONS = Object.freeze({
  "150020": "15.20", "160016": "16.16", "170012": "17.12", "180007": "18.7",
} as const);
export type PostgresServerVersion = typeof POSTGRES_SERVER_VERSIONS[keyof typeof POSTGRES_SERVER_VERSIONS];

/** Exact verified builds, not a major-version or wire-compatibility assertion. */
export function postgresServerVersion(value: unknown): PostgresServerVersion | null {
  return typeof value === "string" && Object.hasOwn(POSTGRES_SERVER_VERSIONS, value)
    ? POSTGRES_SERVER_VERSIONS[value as keyof typeof POSTGRES_SERVER_VERSIONS] : null;
}
