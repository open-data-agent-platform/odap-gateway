import dataclasses
import json
from unittest.mock import AsyncMock, patch

from datahub.emitter.mcp import MetadataChangeProposalWrapper
from metadata.generated.schema.entity.data.pipeline import PipelineStatus

from odap_integrations import EvidenceError
from odap_integrations.datahub import prepare_proposals
from odap_integrations.openmetadata import prepare_pipeline_statuses
from test_attempts import FixtureCase, NAMESPACE, SOURCE, TARGET, reader

REPORTER = {
    "reporter_urn": "urn:li:corpuser:odap-reporter",
    "reported_at_ms": 1767225700000,
}


class CatalogTests(FixtureCase):
    async def test_datahub_real_sdk_roundtrip_all_outcomes(self):
        for outcome in ("succeeded", "failed", "cancelled"):
            service = reader({"ref": self.outcome(outcome)})
            with patch(
                "socket.socket.connect", side_effect=AssertionError("Network forbidden")
            ):
                proposals = await prepare_proposals(service, "ref", "c", **REPORTER)
            self.assertEqual(len(proposals), 3)
            for proposal in proposals:
                wire = proposal.to_obj()
                self.assertEqual(
                    MetadataChangeProposalWrapper.from_obj(wire).to_obj(), wire
                )
                self.assertEqual(proposal.entityType, "dataProcessInstance")
            properties, start, terminal = [p.aspect for p in proposals]
            self.assertEqual(properties.created.actor, REPORTER["reporter_urn"])
            self.assertEqual(properties.created.time, REPORTER["reported_at_ms"])
            self.assertEqual(
                properties.customProperties["odap.recorded_outcome"], outcome
            )
            self.assertEqual(
                properties.customProperties["odap.issuer_authenticated"], "false"
            )
            self.assertEqual(start.status, "STARTED")
            self.assertEqual(terminal.status, "COMPLETE")
            self.assertEqual(terminal.result.nativeResultType, outcome)
            self.assertEqual(
                terminal.result.type, "SUCCESS" if outcome == "succeeded" else "FAILURE"
            )
            self.assertIsNone(terminal.durationMillis)
            self.assertEqual(start.timestampMillis, 1767225601000)
            self.assertEqual(terminal.timestampMillis, 1767225602000)
            self.assertNotEqual(start.messageId, terminal.messageId)

    async def test_datahub_snapshot_replay_and_revision(self):
        service = reader()
        first = await prepare_proposals(service, "ref", "first", **REPORTER)
        again = await prepare_proposals(service, "ref", "second", **REPORTER)
        self.assertEqual([p.to_obj() for p in first], [p.to_obj() for p in again])
        revision = await prepare_proposals(
            reader({"ref": self.outcome("failed")}), "ref", "c", **REPORTER
        )
        self.assertNotEqual(first[0].entityUrn, revision[0].entityUrn)
        self.assertEqual(
            first[0].aspect.customProperties["odap.run.id"],
            revision[0].aspect.customProperties["odap.run.id"],
        )

    async def test_datahub_reporter_validation_and_evidence_rejection(self):
        service = reader()
        with patch.object(service, "read", AsyncMock()) as call:
            for options in (
                REPORTER | {"reporter_urn": "urn:li:dataset:wrong"},
                REPORTER | {"reported_at_ms": True},
                REPORTER | {"reported_at_ms": 2**63},
            ):
                with self.assertRaises(ValueError):
                    await prepare_proposals(service, "ref", "c", **options)
            call.assert_not_called()
        with self.assertRaises(EvidenceError):
            await prepare_proposals(service, "missing", "c", **REPORTER)

    async def test_openmetadata_real_sdk_roundtrip_all_outcomes(self):
        for outcome in ("succeeded", "failed", "cancelled"):
            with patch(
                "socket.socket.connect", side_effect=AssertionError("Network forbidden")
            ):
                proposals = await prepare_pipeline_statuses(
                    reader({"ref": self.outcome(outcome)}),
                    [("ref", "c")],
                    targets={TARGET: "odap_gateway.orders"},
                )
            self.assertEqual(len(proposals), 1)
            self.assertEqual(proposals[0].pipeline_fqn, "odap_gateway.orders")
            status = proposals[0].status
            wire = status.model_dump_json(exclude_none=True)
            self.assertEqual(PipelineStatus.model_validate_json(wire), status)
            data = json.loads(wire)
            self.assertEqual(data["timestamp"], 1767225601000)
            self.assertEqual(
                data["executionStatus"],
                "Successful" if outcome == "succeeded" else "Failed",
            )
            self.assertEqual(data["parameters"]["odap.recorded_outcome"], outcome)
            self.assertIs(data["parameters"]["odap.execution_authorized"], False)
            for absent in (
                "inputs",
                "outputs",
                "taskStatus",
                "endTime",
                "executedBy",
                "metrics",
                "error",
            ):
                self.assertNotIn(absent, data)

    async def test_openmetadata_replay_deduplicates_but_collision_rejects_batch(self):
        service = reader({"ref": SOURCE, "revision": self.outcome("succeeded")})
        targets = {TARGET: "odap_gateway.orders"}
        replay = await prepare_pipeline_statuses(
            service, [("ref", "c"), ("ref", "other")], targets=targets
        )
        self.assertEqual(len(replay), 1)
        with self.assertRaisesRegex(EvidenceError, "^catalog_run_collision$"):
            await prepare_pipeline_statuses(
                service, [("ref", "c"), ("revision", "c")], targets=targets
            )

    async def test_openmetadata_mapping_is_exact_and_copied_before_await(self):
        service = reader()
        for targets in (
            {},
            {(NAMESPACE, "orders"): "odap_gateway.orders"},
            {("urn:other", TARGET[1]): "odap_gateway.orders"},
        ):
            with self.assertRaisesRegex(EvidenceError, "catalog_target_unmapped"):
                await prepare_pipeline_statuses(
                    service, [("ref", "c")], targets=targets
                )
        targets = {TARGET: "odap_gateway.orders"}
        real = service.read

        async def change(*args):
            targets[TARGET] = "wrong.pipeline"
            return await real(*args)

        with patch.object(service, "read", change):
            proposals = await prepare_pipeline_statuses(
                service, [("ref", "c")], targets=targets
            )
        self.assertEqual(proposals[0].pipeline_fqn, "odap_gateway.orders")

    async def test_openmetadata_batch_and_target_validation(self):
        service = reader()
        with patch.object(service, "read", AsyncMock()) as call:
            for selections, targets in (
                ([], {TARGET: "odap_gateway.orders"}),
                ([("ref", "c")] * 101, {TARGET: "odap_gateway.orders"}),
                ([("ref",)], {TARGET: "odap_gateway.orders"}),
                ([("ref", "c")], {TARGET: "bad\nname"}),
            ):
                with self.assertRaises(ValueError):
                    await prepare_pipeline_statuses(
                        service, selections, targets=targets
                    )
            call.assert_not_called()

    async def test_invalid_pin_never_produces_catalog_outputs(self):
        service = reader(
            {"ref": dataclasses.replace(self.outcome("failed"), pin=SOURCE.pin)}
        )
        with self.assertRaises(EvidenceError):
            await prepare_proposals(service, "ref", "c", **REPORTER)
        with self.assertRaises(EvidenceError):
            await prepare_pipeline_statuses(
                service, [("ref", "c")], targets={TARGET: "odap_gateway.orders"}
            )
