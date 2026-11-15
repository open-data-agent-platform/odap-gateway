"""Read retrospective attempt events from the existing pinned Gateway exporter."""

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from .evidence import EvidenceError, EvidenceSource, EvidenceVerifier, _identifier

_RELEASE = "https://raw.githubusercontent.com/open-data-agent-platform/odap-gateway/openlineage-evidence-v0.1.0"
_PRODUCER = _RELEASE + "/integrations/openlineage/README.md"
_SCHEMA = "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent"
_FACET = (
    _RELEASE
    + "/integrations/openlineage/OdapEvidenceRunFacet.json#/$defs/OdapEvidenceRunFacet"
)
_OUTCOMES = {"COMPLETE": "succeeded", "FAIL": "failed", "ABORT": "cancelled"}


def _object(value: object, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def _label(value: object, maximum: int = 512) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= maximum
        and value.strip() == value
        and not re.search(r"[\x00-\x1f\x7f]", value)
    )


def _milliseconds(value: object) -> int:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value, re.ASCII
    ):
        raise ValueError("Invalid event time")
    delta = datetime.fromisoformat(value) - datetime(1970, 1, 1, tzinfo=UTC)
    result = delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000
    if result < 0:
        raise ValueError("Unsupported event time")
    return result


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate output field")
    return result


@dataclass(frozen=True)
class AttemptEvidence:
    namespace: str
    job_name: str
    run_id: str
    start_ms: int
    end_ms: int
    evidence_digest: str
    receipt_id: str
    contract_id: str
    release_id: str
    intent_id: str
    outcome: str
    profile: str
    correlation_id: str

    @property
    def snapshot_id(self) -> str:
        """One evidence snapshot, not a second warehouse execution identity."""
        return str(
            uuid5(
                NAMESPACE_URL,
                json.dumps(
                    [self.namespace, self.run_id, self.evidence_digest],
                    separators=(",", ":"),
                ),
            )
        )

    def attributes(self) -> dict[str, str | bool | int]:
        return {
            "odap.profile": self.profile,
            "odap.evidence.digest": self.evidence_digest,
            "odap.receipt.id": self.receipt_id,
            "odap.contract.id": self.contract_id,
            "odap.semantic_release.id": self.release_id,
            "odap.intent.id": self.intent_id,
            "odap.run.id": self.run_id,
            "odap.snapshot.id": self.snapshot_id,
            "odap.job.namespace": self.namespace,
            "odap.job.name": self.job_name,
            "odap.recorded_outcome": self.outcome,
            "odap.consistency_checked": True,
            "odap.issuer_authenticated": False,
            "odap.execution_authorized": False,
            "odap.retrospective": True,
            "odap.start_time_basis": "gateway-claim",
            "odap.end_time_basis": "gateway-terminal-observation",
            "odap.start_time_ms": self.start_ms,
            "odap.end_time_ms": self.end_ms,
        }


class AttemptReader(EvidenceVerifier):
    """Host-scoped reader; the supplied script must be export-openlineage.js."""

    def __init__(self, exporter_script, sources, *, namespace: str, **kwargs):
        if not _label(namespace):
            raise ValueError("Invalid namespace")
        parsed = urlsplit(namespace)
        if (
            parsed.scheme not in ("https", "urn")
            or not parsed.path
            or parsed.username
            or parsed.password
            or "?" in namespace
            or "#" in namespace
            or re.search(r"\s", namespace)
        ):
            raise ValueError("Invalid namespace")
        if parsed.scheme == "https" and not parsed.hostname:
            raise ValueError("Invalid namespace")
        self._namespace = namespace
        super().__init__(exporter_script, sources, **kwargs)

    def _command(self, source: EvidenceSource) -> list[str]:
        args = [
            self._node,
            str(self._script),
            str(source.bundle),
            source.tenant_id,
            source.intent_id,
            str(source.pin),
            self._namespace,
        ]
        if source.audience is not None:
            args.extend(["--audience", source.audience])
        return args

    def _parse_output(self, stdout: bytes, source: EvidenceSource) -> dict:
        try:
            lines = stdout.decode("utf-8").splitlines()
            if len(lines) != 2:
                raise ValueError("Expected event pair")
            start, end = [
                json.loads(line, object_pairs_hook=_unique_object) for line in lines
            ]
            event_keys = {
                "producer",
                "schemaURL",
                "eventType",
                "eventTime",
                "job",
                "run",
            }
            for event in (start, end):
                if (
                    not _object(event, event_keys)
                    or event["producer"] != _PRODUCER
                    or event["schemaURL"] != _SCHEMA
                    or not _object(event["job"], {"namespace", "name"})
                ):
                    raise ValueError("Invalid event")
            job = start["job"]
            prefix = f"odap/tenant/{source.tenant_id}/target/"
            if (
                job != end["job"]
                or job["namespace"] != self._namespace
                or not _label(job["name"])
                or not job["name"].startswith(prefix)
                or len(job["name"]) <= len(prefix)
            ):
                raise ValueError("Invalid event scope")
            if (
                start["eventType"] != "START"
                or end["eventType"] not in _OUTCOMES
                or not _object(start["run"], {"runId"})
                or not _object(end["run"], {"runId", "facets"})
            ):
                raise ValueError("Invalid lifecycle")
            run_id = start["run"]["runId"]
            if (
                not isinstance(run_id, str)
                or end["run"]["runId"] != run_id
                or str(UUID(run_id)) != run_id
                or UUID(run_id).version != 5
            ):
                raise ValueError("Invalid run ID")
            if not _object(end["run"]["facets"], {"odap_evidence"}):
                raise ValueError("Unexpected facet")
            facet = end["run"]["facets"]["odap_evidence"]
            keys = {
                "_producer",
                "_schemaURL",
                "profile",
                "evidenceDigest",
                "receiptId",
                "contractId",
                "semanticReleaseId",
                "intentId",
                "recordedOutcome",
                "consistencyChecked",
                "issuerAuthenticated",
                "retrospective",
                "startTimeBasis",
                "endTimeBasis",
            }
            if (
                not _object(facet, keys)
                or facet["_producer"] != _PRODUCER
                or facet["_schemaURL"] != _FACET
                or facet["profile"]
                not in (
                    "odap.gateway.local.settled-bigquery.v1",
                    "odap.gateway.local.settled-delegated-bigquery.v1",
                )
            ):
                raise ValueError("Invalid evidence facet")
            if (
                facet["intentId"] != source.intent_id
                or not all(
                    _identifier(facet[key])
                    for key in (
                        "receiptId",
                        "contractId",
                        "semanticReleaseId",
                        "intentId",
                    )
                )
                or not isinstance(facet["evidenceDigest"], str)
                or not re.fullmatch(
                    r"sha256:[0-9a-f]{64}", facet["evidenceDigest"], re.ASCII
                )
            ):
                raise ValueError("Invalid evidence identity")
            if (
                facet["recordedOutcome"] != _OUTCOMES[end["eventType"]]
                or facet["consistencyChecked"] is not True
                or facet["issuerAuthenticated"] is not False
                or facet["retrospective"] is not True
                or facet["startTimeBasis"] != "gateway-claim"
                or facet["endTimeBasis"] != "gateway-terminal-observation"
            ):
                raise ValueError("Invalid evidence assertion")
            start_ms, end_ms = (
                _milliseconds(start["eventTime"]),
                _milliseconds(end["eventTime"]),
            )
            if end_ms < start_ms:
                raise ValueError("Invalid chronology")
            return {
                "namespace": job["namespace"],
                "job_name": job["name"],
                "run_id": run_id,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "evidence_digest": facet["evidenceDigest"],
                "receipt_id": facet["receiptId"],
                "contract_id": facet["contractId"],
                "release_id": facet["semanticReleaseId"],
                "intent_id": facet["intentId"],
                "outcome": facet["recordedOutcome"],
                "profile": facet["profile"],
            }
        except (ValueError, KeyError, TypeError, AttributeError, RecursionError):
            raise EvidenceError("verifier_output_invalid") from None

    async def read(self, evidence_ref: str, correlation_id: str) -> AttemptEvidence:
        return AttemptEvidence(
            **(await self._invoke(evidence_ref, correlation_id)),
            correlation_id=correlation_id,
        )

    async def verify(self, evidence_ref: str, correlation_id: str) -> dict:
        raise EvidenceError("use_attempt_reader")
