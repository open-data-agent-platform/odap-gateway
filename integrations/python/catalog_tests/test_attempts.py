import asyncio
import copy
import dataclasses
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from odap_integrations import EvidenceError, EvidenceSource, evidence
from odap_integrations.attempts import AttemptReader, _milliseconds

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "dist/evidence/scripts/export-openlineage.js"
SOURCE = EvidenceSource(
    ROOT / "tests/fixtures/settled-job.json",
    ROOT / "tests/pins/settled-job.sha256",
    "t",
    "i",
)
NAMESPACE = "https://gateway.example/gateway"
TARGET = (NAMESPACE, "odap/tenant/t/target/orders")


def reader(sources=None, script=SCRIPT, **kwargs):
    return AttemptReader(
        script, sources or {"ref": SOURCE}, namespace=NAMESPACE, **kwargs
    )


class FixtureCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="odap-catalog-")
        self.directory = Path(self.temp.name)

    async def asyncTearDown(self):
        self.temp.cleanup()

    def changed(self, mutate, name="changed"):
        data = json.loads(SOURCE.bundle.read_text())
        mutate(data)
        content = json.dumps(data, sort_keys=True, separators=(",", ":"))
        bundle, pin = self.directory / f"{name}.json", self.directory / f"{name}.sha256"
        bundle.write_text(content, encoding="utf8")
        pin.write_text("sha256:" + hashlib.sha256(content.encode()).hexdigest())
        return dataclasses.replace(SOURCE, bundle=bundle, pin=pin)

    def outcome(self, value, name="changed"):
        def change(data):
            data["final"]["outcome"] = data["observation"]["outcome"] = value

        return self.changed(change, name)


class AttemptTests(FixtureCase):
    async def test_real_export_and_stable_identity(self):
        first = await reader().read("ref", "9007199254740993")
        second = await reader().read("ref", "another")
        self.assertEqual(first.run_id, "5dded15c-4047-5160-8b77-73727e0d7944")
        self.assertEqual(first.snapshot_id, second.snapshot_id)
        self.assertEqual(first.attributes(), second.attributes())
        self.assertEqual(first.correlation_id, "9007199254740993")
        self.assertEqual(first.outcome, "cancelled")
        self.assertEqual(first.end_ms - first.start_ms, 1000)
        self.assertEqual(first.evidence_digest, SOURCE.pin.read_text().strip())
        self.assertIs(first.attributes()["odap.execution_authorized"], False)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            first.outcome = "succeeded"

    async def test_all_outcomes_and_revision_identity(self):
        snapshots, runs = set(), set()
        for outcome in ("succeeded", "failed", "cancelled"):
            item = await reader({"ref": self.outcome(outcome)}).read("ref", "c")
            self.assertEqual(item.outcome, outcome)
            snapshots.add(item.snapshot_id)
            runs.add(item.run_id)
        self.assertEqual(len(snapshots), 3)
        self.assertEqual(len(runs), 1)

    async def test_scope_tamper_and_unknown_refs_fail_closed(self):
        altered = self.outcome("succeeded")
        sources = [
            dataclasses.replace(SOURCE, tenant_id="other"),
            dataclasses.replace(SOURCE, intent_id="other"),
            dataclasses.replace(SOURCE, audience="other"),
            dataclasses.replace(altered, pin=SOURCE.pin),
        ]
        for source in sources:
            with self.subTest(source=source), self.assertRaises(EvidenceError):
                await reader({"ref": source}).read("ref", "c")
        with patch.object(evidence.asyncio, "create_subprocess_exec") as spawn:
            for ref, correlation in (("missing", "c"), ("ref", 12), ("../x", "c")):
                with self.assertRaises(EvidenceError):
                    await reader().read(ref, correlation)
            spawn.assert_not_called()

    async def test_delegated_audience_and_allowlist(self):
        def change(data):
            data["profile"] = "odap.gateway.local.settled-delegated-bigquery.v1"
            data["delegation"] = {
                **{
                    k: "gateway"
                    for k in (
                        "admissionAudience",
                        "claimAudience",
                        "observedAudience",
                        "billedAudience",
                    )
                },
                **{
                    k: "sha256:" + "a" * 64
                    for k in ("claimDigest", "observedDigest", "billedDigest")
                },
                "billedProject": data["job"]["projectId"],
                "billedLocation": data["job"]["location"],
            }
            data["final"]["reason"] = "PRIVATE-REASON"
            data["bill"]["reference"] = "PRIVATE-BILL"

        source = dataclasses.replace(self.changed(change), audience="gateway")
        item = await reader({"ref": source}).read("ref", "c")
        output = json.dumps(item.attributes())
        for private in (
            "PRIVATE-",
            "claimDigest",
            "principalId",
            "claimedBy",
            "actualMicroUsd",
            str(source.bundle),
        ):
            self.assertNotIn(private, output)
        with self.assertRaises(EvidenceError):
            await reader({"ref": dataclasses.replace(source, audience="other")}).read(
                "ref", "c"
            )

    async def test_concurrent_requests_and_host_registry_copy(self):
        sources = {"ref": SOURCE}
        service = reader(sources, concurrency=2)
        sources["ref"] = dataclasses.replace(SOURCE, tenant_id="wrong")
        results = await asyncio.gather(*(service.read("ref", str(i)) for i in range(6)))
        self.assertEqual(
            [r.correlation_id for r in results], [str(i) for i in range(6)]
        )
        self.assertEqual(len({r.snapshot_id for r in results}), 1)
        with self.assertRaisesRegex(EvidenceError, "use_attempt_reader"):
            await service.verify("ref", "c")

    async def test_strict_child_output_and_sanitized_errors(self):
        service = reader()
        process = await asyncio.create_subprocess_exec(
            *service._command(SOURCE), stdout=asyncio.subprocess.PIPE
        )
        stdout, _ = await process.communicate()
        self.assertEqual(process.returncode, 0)
        original = [json.loads(line) for line in stdout.splitlines()]
        bad = [b"{}", b"[" * 1500 + b"]" * 1500 + b"\n{}", b"\xff\n{}"]
        mutations = (
            lambda e: e[1]["run"]["facets"]["odap_evidence"].update(
                issuerAuthenticated=True
            ),
            lambda e: e[0]["job"].update(namespace="urn:other"),
            lambda e: e[0]["run"].update(runId="invalid"),
            lambda e: e[1].update(eventType="COMPLETE"),
            lambda e: e[0].update(eventTime="2027-01-01T00:00:00.000Z"),
            lambda e: e[1].update(sql="PRIVATE-SQL"),
            lambda e: e[1]["run"]["facets"]["odap_evidence"].update(intentId="other"),
        )
        for mutation in mutations:
            events = copy.deepcopy(original)
            mutation(events)
            bad.append("\n".join(json.dumps(e) for e in events).encode())
        bad.append(
            stdout.replace(
                b'"eventType":"START"', b'"eventType":"START","eventType":"START"'
            )
        )
        for value in bad:
            with (
                self.subTest(value=value[:70]),
                self.assertRaises(EvidenceError) as caught,
            ):
                service._parse_output(value, SOURCE)
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_exact_time_and_namespace_validation(self):
        self.assertEqual(_milliseconds("2026-01-01T00:00:01.001Z"), 1767225601001)
        self.assertEqual(_milliseconds("9999-12-31T23:59:59.999Z"), 253402300799999)
        for value in (
            "2026-01-01",
            "1969-12-31T00:00:00.000Z",
            "2026-02-30T00:00:00.000Z",
        ):
            with self.assertRaises(ValueError):
                _milliseconds(value)
        for value in (
            "relative",
            "http://example.org/",
            "https://u:p@example.org/",
            "urn:",
            "https://x/?key=x",
        ):
            with self.assertRaises(ValueError):
                AttemptReader(SCRIPT, {"ref": SOURCE}, namespace=value)
