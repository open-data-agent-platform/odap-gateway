import asyncio
import dataclasses
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from odap_integrations import EvidenceError, EvidenceSource, EvidenceVerifier, evidence

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "dist/evidence/scripts/verify-settled-evidence.js"
BUNDLE = ROOT / "tests/fixtures/settled-job.json"
PIN = ROOT / "tests/pins/settled-job.sha256"
SOURCE = EvidenceSource(BUNDLE, PIN, "t", "i")


def verifier(sources=None, **kwargs):
    return EvidenceVerifier(SCRIPT, sources or {"9007199254740993": SOURCE}, **kwargs)


class EvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="odap-integration-")
        self.directory = Path(self.temp.name)

    async def asyncTearDown(self):
        self.temp.cleanup()

    def fake(self, code):
        script = self.directory / "verifier.mjs"
        script.write_text(code, encoding="utf8")
        return script

    async def test_real_verifier_and_string_identifiers(self):
        result = await verifier().verify("9007199254740993", "9223372036854775807")
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["recordedOutcome"], "cancelled")
        self.assertEqual(result["correlationId"], "9223372036854775807")
        self.assertEqual(result["evidenceRef"], "9007199254740993")
        self.assertEqual(result["actualMicroUsd"], "0")
        for key in (
            "issuerAuthenticated",
            "executionAuthorized",
            "providerContacted",
            "gatewayContacted",
        ):
            self.assertIs(result[key], False)
        self.assertEqual(result["digest"], PIN.read_text().strip())
        self.assertNotIn("actor", json.dumps(result))
        self.assertNotIn(str(BUNDLE), json.dumps(result))

    async def test_unknown_and_invalid_input_never_spawns(self):
        service = verifier()
        cases = [
            ("unknown", "valid"),
            (9007199254740993, "valid"),
            ("9007199254740993", 1),
            ("../private.json", "valid"),
            ("", "valid"),
            ("x\n", "valid"),
            ("x", "a" * 129),
        ]
        with patch.object(evidence.asyncio, "create_subprocess_exec") as spawn:
            for ref, correlation in cases:
                with (
                    self.subTest(ref=ref, correlation=correlation),
                    self.assertRaises(EvidenceError),
                ):
                    await service.verify(ref, correlation)
            spawn.assert_not_called()

    async def test_tenant_intent_and_audience_are_host_bound(self):
        for values in (
            {"tenant_id": "other"},
            {"intent_id": "other"},
            {"audience": "gateway"},
        ):
            with (
                self.subTest(values=values),
                self.assertRaisesRegex(EvidenceError, "^evidence_rejected$"),
            ):
                await verifier({"ref": dataclasses.replace(SOURCE, **values)}).verify(
                    "ref", "c"
                )

    async def test_tamper_and_missing_files_do_not_leak(self):
        modified = self.directory / "private-evidence.json"
        data = json.loads(BUNDLE.read_text())
        data["bill"]["actualMicroUsd"] = data["settlement"]["actualMicroUsd"] = 42
        modified.write_text(json.dumps(data, separators=(",", ":"), sort_keys=True))
        for source in (
            dataclasses.replace(SOURCE, bundle=modified),
            dataclasses.replace(SOURCE, bundle=self.directory / "missing-private.json"),
            dataclasses.replace(SOURCE, pin=self.directory / "missing-private.sha256"),
        ):
            with (
                self.subTest(source=source),
                self.assertRaisesRegex(EvidenceError, "^evidence_rejected$"),
            ):
                await verifier({"ref": source}).verify("ref", "c")

    async def test_registry_is_copied_and_errors_do_not_poison_followup(self):
        sources = {"ref": SOURCE}
        service = verifier(sources)
        sources["ref"] = dataclasses.replace(SOURCE, tenant_id="other")
        with self.assertRaises(EvidenceError):
            await service.verify("missing", "first")
        self.assertEqual(
            (await service.verify("ref", "second"))["correlationId"], "second"
        )

    async def test_concurrent_calls_preserve_correlation(self):
        service = verifier(concurrency=2)
        result = await asyncio.gather(
            *(
                service.verify("9007199254740993", str(9007199254740993 + i))
                for i in range(12)
            )
        )
        self.assertEqual(
            [r["correlationId"] for r in result],
            [str(9007199254740993 + i) for i in range(12)],
        )

    async def test_cancellation_reaps_only_local_child(self):
        started = self.directory / "started"
        script = self.fake(
            "import fs from 'node:fs';fs.writeFileSync("
            + json.dumps(str(started))
            + ", 'started');setTimeout(()=>{},30000);"
        )
        service = EvidenceVerifier(script, {"ref": SOURCE})
        processes = []
        real_spawn = asyncio.create_subprocess_exec

        async def capture(*args, **kwargs):
            process = await real_spawn(*args, **kwargs)
            processes.append(process)
            return process

        with patch.object(evidence.asyncio, "create_subprocess_exec", capture):
            task = asyncio.create_task(service.verify("ref", "cancel"))
            async with asyncio.timeout(10):
                while not started.exists():
                    await asyncio.sleep(0.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode)

    async def test_cancellation_during_spawn_reaps_child(self):
        created, release = asyncio.Event(), asyncio.Event()
        real_spawn = asyncio.create_subprocess_exec
        processes = []
        script = self.fake("setTimeout(()=>{},30000)")

        async def delayed(*args, **kwargs):
            process = await real_spawn(*args, **kwargs)
            processes.append(process)
            created.set()
            await release.wait()
            return process

        with patch.object(evidence.asyncio, "create_subprocess_exec", delayed):
            task = asyncio.create_task(
                EvidenceVerifier(script, {"ref": SOURCE}).verify("ref", "c")
            )
            await asyncio.wait_for(created.wait(), 5)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNotNone(processes[0].returncode)

    async def test_timeout_reaps_process(self):
        script = self.fake("setTimeout(()=>{},30000)")
        with self.assertRaisesRegex(EvidenceError, "^verification_timeout$"):
            await EvidenceVerifier(script, {"ref": SOURCE}, timeout=0.2).verify(
                "ref", "c"
            )

    async def test_output_limits_and_nonzero_exit(self):
        cases = [
            "process.stdout.write('x'.repeat(20000));setTimeout(()=>{},30000)",
            "process.stderr.write('x'.repeat(20000));setTimeout(()=>{},30000)",
            "console.error('private evidence');process.exit(1)",
            "console.log('not json')",
            "console.log('{}')",
            "process.kill(process.pid)",
        ]
        for code in cases:
            with self.subTest(code=code), self.assertRaises(EvidenceError) as caught:
                await EvidenceVerifier(self.fake(code), {"ref": SOURCE}).verify(
                    "ref", "c"
                )
            self.assertNotIn("private", str(caught.exception))

    async def test_node_options_and_credentials_are_not_inherited(self):
        script = self.fake(
            "console.log(JSON.stringify({secret:process.env.ODAP_TEST_SECRET,options:process.env.NODE_OPTIONS}))"
        )
        with (
            patch.dict(
                os.environ,
                {
                    "ODAP_TEST_SECRET": "synthetic-only",
                    "NODE_OPTIONS": "--invalid-fixture-option",
                },
            ),
            self.assertRaisesRegex(EvidenceError, "^verifier_output_invalid$"),
        ):
            await EvidenceVerifier(script, {"ref": SOURCE}).verify("ref", "c")

    async def test_invalid_report_cannot_upgrade_trust(self):
        valid = {
            "consistent": True,
            "issuerAuthenticated": False,
            "digest": PIN.read_text().strip(),
            "receiptId": "r",
            "outcome": "cancelled",
            "actualMicroUsd": 0,
        }
        for change in (
            {"issuerAuthenticated": True},
            {"consistent": 1},
            {"outcome": "pending"},
            {"actualMicroUsd": True},
            {"actualMicroUsd": 9007199254740992},
            {"receiptId": 42},
            {"digest": "wrong"},
            {"executionAuthorized": True},
            {"delegation": {"audience": "a", "claimDigest": "wrong"}},
        ):
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(EvidenceError, "^verifier_output_invalid$"),
            ):
                EvidenceVerifier._validate_report(valid | change, SOURCE)

    def test_configuration_validation(self):
        for kwargs in (
            {"timeout": True},
            {"timeout": float("nan")},
            {"timeout": 0},
            {"concurrency": 0},
            {"concurrency": True},
            {"concurrency": 33},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                verifier(**kwargs)
        with self.assertRaises(ValueError):
            EvidenceSource(BUNDLE, BUNDLE, "t", "i")
        with self.assertRaises(ValueError):
            EvidenceSource(BUNDLE, PIN, 42, "i")
        with self.assertRaises(ValueError):
            EvidenceVerifier(self.directory / "missing", {"ref": SOURCE})


if __name__ == "__main__":
    unittest.main()
