"""Opaque host-registry labels are not URLs, paths, identities or receipt formats."""

import dataclasses
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from odap_integrations import EvidenceError, EvidenceSource, EvidenceVerifier, evidence
from test_evidence import SCRIPT, SOURCE, verifier

REFERENCE = "urn:external-receipt:9007199254740993/revision%2F1#saved"


class ReferenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_external_label_preserves_record_and_trust_boundary(self):
        original = await verifier().verify("9007199254740993", "c")
        result = await verifier({REFERENCE: SOURCE}).verify(REFERENCE, "c")
        self.assertEqual(result, original | {"evidenceRef": REFERENCE})
        self.assertEqual(result["recordedOutcome"], "cancelled")
        self.assertNotEqual(result["receiptId"], REFERENCE)

    async def test_url_and_path_shaped_labels_only_use_registered_source(self):
        references = (
            "https://127.0.0.1:9/receipts/9007199254740993?revision=1#saved",
            "file:///private/not-the-host-bundle.json",
            "../not-the-host-bundle.json",
            'external:"quoted"/<untrusted>&label',
        )
        real_spawn = evidence.asyncio.create_subprocess_exec
        for ref in references:
            service = verifier({ref: SOURCE})
            with (
                self.subTest(ref=ref),
                patch.object(
                    evidence.asyncio, "create_subprocess_exec", wraps=real_spawn
                ) as spawn,
                patch(
                    "urllib.request.urlopen",
                    side_effect=AssertionError("No URL retrieval"),
                ),
                patch(
                    "socket.create_connection", side_effect=AssertionError("No network")
                ),
            ):
                result = await service.verify(ref, "c")
                self.assertEqual(result["evidenceRef"], ref)
                self.assertEqual(spawn.call_count, 1)
                self.assertEqual(list(spawn.call_args.args), service._command(SOURCE))
                self.assertNotIn(ref, spawn.call_args.args)

    async def test_no_case_folding_percent_decoding_or_path_normalization(self):
        refs = ("urn:receipt:A%2FB", "urn:receipt:A/B", "urn:receipt:a%2fb")
        service = verifier({refs[0]: SOURCE})
        with patch.object(evidence.asyncio, "create_subprocess_exec") as spawn:
            for ref in (
                *refs[1:],
                "./" + refs[0],
                "file:///unknown",
                "https://example.invalid/r",
            ):
                with (
                    self.subTest(ref=ref),
                    self.assertRaisesRegex(EvidenceError, "^evidence_unavailable$"),
                ):
                    await service.verify(ref, "c")
            spawn.assert_not_called()
        scoped = verifier(
            {refs[0]: SOURCE, refs[1]: dataclasses.replace(SOURCE, tenant_id="other")}
        )
        self.assertEqual((await scoped.verify(refs[0], "c"))["status"], "verified")
        with self.assertRaisesRegex(EvidenceError, "^evidence_rejected$"):
            await scoped.verify(refs[1], "c")

    async def test_reference_length_and_rejected_character_boundaries(self):
        longest = "r" * 512
        self.assertEqual(
            (await verifier({longest: SOURCE}).verify(longest, "c"))["evidenceRef"],
            longest,
        )
        invalid = (
            "",
            "r" * 513,
            " r",
            "r ",
            "r\n",
            "r\r",
            "r\t",
            "r\x00",
            "r\x7f",
            "r\u0080",
            "r\u200b",
            42,
            True,
            None,
        )
        service = verifier()
        with patch.object(evidence.asyncio, "create_subprocess_exec") as spawn:
            for ref in invalid:
                with (
                    self.subTest(ref=ref),
                    self.assertRaisesRegex(EvidenceError, "^invalid_tool_input$"),
                ):
                    await service.verify(ref, "c")
                with self.assertRaises(ValueError):
                    EvidenceVerifier(SCRIPT, {ref: SOURCE})
            spawn.assert_not_called()

    async def test_reference_extension_does_not_relax_scope_or_correlation(self):
        service = verifier({REFERENCE: SOURCE})
        with patch.object(evidence.asyncio, "create_subprocess_exec") as spawn:
            for correlation in (REFERENCE, "a.b", "a/b", "a:b", "c" * 129, 42):
                with (
                    self.subTest(correlation=correlation),
                    self.assertRaisesRegex(EvidenceError, "^invalid_tool_input$"),
                ):
                    await service.verify(REFERENCE, correlation)
            spawn.assert_not_called()
        for field in ("tenant_id", "intent_id", "audience"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                dataclasses.replace(SOURCE, **{field: REFERENCE})

    async def test_alias_is_not_access_to_another_registry(self):
        first = verifier({REFERENCE: SOURCE})
        second = verifier({"tenant_b": SOURCE})
        self.assertEqual((await first.verify(REFERENCE, "c"))["status"], "verified")
        with patch.object(evidence.asyncio, "create_subprocess_exec") as spawn:
            with self.assertRaisesRegex(EvidenceError, "^evidence_unavailable$"):
                await second.verify(REFERENCE, "c")
            spawn.assert_not_called()

    async def test_foreign_receipt_payload_is_not_odap_evidence(self):
        with tempfile.TemporaryDirectory(prefix="odap-foreign-receipt-") as folder:
            bundle, pin = Path(folder) / "foreign.json", Path(folder) / "foreign.sha256"
            content = json.dumps(
                {
                    "format": "foreign-test-only",
                    "id": REFERENCE,
                    "outcome": "completed",
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            bundle.write_text(content, encoding="utf8")
            pin.write_text(
                "sha256:" + hashlib.sha256(content.encode()).hexdigest(),
                encoding="utf8",
            )
            source = EvidenceSource(bundle, pin, "t", "i")
            with self.assertRaisesRegex(EvidenceError, "^evidence_rejected$"):
                await verifier({REFERENCE: source}).verify(REFERENCE, "c")


class ReferenceFrameworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_llamaindex_opaque_reference_and_rejection(self):
        from odap_integrations.llamaindex import EvidenceInput, create_tool

        tool = create_tool(verifier({REFERENCE: SOURCE}))
        self.assertEqual(
            EvidenceInput.model_validate(
                {"evidence_ref": REFERENCE, "correlation_id": "c"}
            ).evidence_ref,
            REFERENCE,
        )
        result = await tool.acall(evidence_ref=REFERENCE, correlation_id="c")
        self.assertFalse(result.is_error)
        self.assertEqual(json.loads(result.content), result.raw_output)
        self.assertEqual(result.raw_output["evidenceRef"], REFERENCE)
        self.assertEqual(result.raw_output["recordedOutcome"], "cancelled")
        self.assertIs(result.raw_output["issuerAuthenticated"], False)
        for ref in (
            REFERENCE.lower(),
            "https://example.invalid/receipt",
            "r\n",
            "r" * 513,
            42,
        ):
            with self.subTest(ref=ref):
                failed = await tool.acall(evidence_ref=ref, correlation_id="c")
                self.assertTrue(failed.is_error)
                self.assertIsNone(failed.raw_output)
                self.assertEqual(failed.raw_input, {})

    async def test_langchain_and_langgraph_preserve_external_label(self):
        from langchain_core.messages import AIMessage
        from odap_integrations.langchain import create_tool
        from odap_integrations.langgraph import create_graph

        args = {"evidence_ref": REFERENCE, "correlation_id": "c"}
        expected = await create_tool(verifier({REFERENCE: SOURCE})).ainvoke(args)
        self.assertEqual(expected["evidenceRef"], REFERENCE)
        app = create_graph(verifier({REFERENCE: SOURCE}))
        result = await app.ainvoke(
            {
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {"name": evidence.NAME, "args": args, "id": "call_1"}
                        ],
                    )
                ]
            }
        )
        message = result["messages"][-1]
        self.assertEqual(message.status, "success")
        self.assertEqual(json.loads(message.content), expected)

    async def test_fastmcp_preserves_external_label(self):
        from fastmcp import Client
        from odap_integrations.fastmcp import create_server

        async with Client(create_server(verifier({REFERENCE: SOURCE}))) as client:
            result = await client.call_tool_mcp(
                evidence.NAME, {"evidence_ref": REFERENCE, "correlation_id": "c"}
            )
            self.assertFalse(result.is_error)
            self.assertEqual(result.structured_content["evidenceRef"], REFERENCE)
            self.assertEqual(result.structured_content["recordedOutcome"], "cancelled")
