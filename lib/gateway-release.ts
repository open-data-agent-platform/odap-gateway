import { SOURCE_REPOSITORY_URL } from "./open-source";

export const GATEWAY_VERSION = "0.3.0-preview.1";
export const GATEWAY_RELEASE_URL = `${SOURCE_REPOSITORY_URL}/releases/tag/v${GATEWAY_VERSION}`;
export const POSTGRESQL_GUIDE_URL = `${SOURCE_REPOSITORY_URL}/blob/v${GATEWAY_VERSION}/docs/POSTGRESQL_CONNECTOR.md`;
export const POSTGRESQL_PREVIEW_SUMMARY =
  "Separate Node host for released, single-table COUNT/SUM reads with tenant RLS, approval contracts, signed Agent delegation and bounded evidence export.";
export const POSTGRESQL_PREVIEW_BOUNDARY =
  "This website does not expose a production PostgreSQL query endpoint. Arbitrary SQL, monetary settlement, independent acceptance and real pilots remain outside this preview.";
