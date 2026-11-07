import { NVIDIA_IMPORT_COMMIT } from "../../lib/nvidia-semantic-import";
import metric from "./revenue-metric.json";

export const nvidiaMapping = () => ({
  upstreamCommit: NVIDIA_IMPORT_COMMIT, sourceInstance: "synthetic-offline-instance",
  attributeId: "synthetic-attribute-revenue", capturedAt: "2026-11-07T00:00:00.000Z",
  tenantId: "t", revisionId: "nvidia-revision", ownerId: "owner", definition: structuredClone(metric),
});
