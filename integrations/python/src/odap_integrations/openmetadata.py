"""Stage SDK pipeline statuses for explicitly mapped ODAP attempt histories."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from metadata.generated.schema.entity.data.pipeline import PipelineStatus
from metadata.generated.schema.type.basic import FullyQualifiedEntityName

from .attempts import AttemptReader, _label
from .evidence import EvidenceError


@dataclass(frozen=True)
class PipelineStatusProposal:
    pipeline_fqn: str
    status: PipelineStatus


async def prepare_pipeline_statuses(
    reader: AttemptReader,
    selections: Sequence[tuple[str, str]],
    *,
    targets: Mapping[tuple[str, str], str],
) -> list[PipelineStatusProposal]:
    if not isinstance(selections, Sequence) or not 1 <= len(selections) <= 100:
        raise ValueError("Expected one to 100 evidence reference/correlation pairs")
    selected = tuple(selections)
    if any(not isinstance(pair, tuple) or len(pair) != 2 for pair in selected):
        raise ValueError("Expected one to 100 evidence reference/correlation pairs")
    target_map = dict(targets)
    for source_key, mapped_target in target_map.items():
        if (
            not isinstance(source_key, tuple)
            or len(source_key) != 2
            or not all(_label(part) for part in source_key)
            or not _label(mapped_target, 256)
        ):
            raise ValueError("Invalid host pipeline mapping")
        FullyQualifiedEntityName.model_validate(mapped_target)
    proposals: dict[tuple[str, int], PipelineStatusProposal] = {}
    for reference, correlation in selected:
        item = await reader.read(reference, correlation)
        target = target_map.get((item.namespace, item.job_name))
        if target is None:
            raise EvidenceError("catalog_target_unmapped")
        parameters = item.attributes() | {
            "odap.status_projection": "cancelled-as-failure"
            if item.outcome == "cancelled"
            else "exact"
        }
        # The SDK uses timestamp as a history key. Real warehouse times are unknown.
        status = PipelineStatus.model_validate(
            {
                "timestamp": item.start_ms,
                "executionStatus": "Successful"
                if item.outcome == "succeeded"
                else "Failed",
                "executionId": item.run_id,
                "parameters": parameters,
            }
        )
        key = (target, item.start_ms)
        existing = proposals.get(key)
        if existing and existing.status.model_dump(mode="json") != status.model_dump(
            mode="json"
        ):
            raise EvidenceError("catalog_run_collision")
        proposals[key] = PipelineStatusProposal(target, status)
    return list(proposals.values())
