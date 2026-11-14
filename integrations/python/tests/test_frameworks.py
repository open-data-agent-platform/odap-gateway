import asyncio
import json
import socket
import unittest

from odap_integrations.evidence import NAME
from test_evidence import verifier


class FrameworkTests(unittest.IsolatedAsyncioTestCase):
    def assert_report(self, result, correlation="9223372036854775807"):
        self.assertEqual(result["correlationId"], correlation)
        self.assertEqual(result["recordedOutcome"], "cancelled")
        self.assertIs(result["executionAuthorized"], False)
        self.assertIs(result["issuerAuthenticated"], False)

    async def test_fastmcp_memory_modes(self):
        from fastmcp import Client
        from odap_integrations.fastmcp import create_server

        for mode in ("auto", "legacy"):
            with self.subTest(mode=mode):
                async with Client(create_server(verifier()), mode=mode) as client:
                    tools = await client.list_tools()
                    self.assertEqual([t.name for t in tools], [NAME])
                    result = await client.call_tool_mcp(
                        NAME,
                        {
                            "evidence_ref": "9007199254740993",
                            "correlation_id": "9223372036854775807",
                        },
                    )
                    self.assertFalse(result.is_error)
                    self.assert_report(result.structured_content)
                    rejected = await client.call_tool_mcp(
                        NAME, {"evidence_ref": "missing", "correlation_id": "failure"}
                    )
                    self.assertTrue(rejected.is_error)
                    self.assertIsNone(rejected.structured_content)

    async def test_fastmcp_rejects_extra_scope_and_number(self):
        from fastmcp import Client
        from mcp.shared.exceptions import MCPError
        from odap_integrations.fastmcp import create_server

        async with Client(create_server(verifier())) as client:
            for args in (
                {"evidence_ref": 9007199254740993, "correlation_id": "c"},
                {
                    "evidence_ref": "9007199254740993",
                    "correlation_id": "c",
                    "tenant_id": "other",
                },
            ):
                with self.subTest(args=args):
                    try:
                        result = await client.call_tool_mcp(NAME, args)
                    except MCPError as error:
                        self.assertEqual(error.code, -32602)
                        continue
                    self.assertTrue(result.is_error)

    async def test_fastmcp_real_loopback_http(self):
        import uvicorn
        from fastmcp import Client
        from odap_integrations.fastmcp import create_server

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(
            uvicorn.Config(
                create_server(verifier()).http_app(path="/mcp"),
                log_level="critical",
                access_log=False,
            )
        )
        task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(10):
                while not server.started:
                    if task.done():
                        await task
                        self.fail("Server exited before startup")
                    await asyncio.sleep(0.02)
            async with Client(f"http://127.0.0.1:{port}/mcp") as client:
                results = await asyncio.gather(
                    *(
                        client.call_tool_mcp(
                            NAME,
                            {
                                "evidence_ref": "9007199254740993",
                                "correlation_id": str(9007199254740993 + i),
                            },
                        )
                        for i in range(4)
                    )
                )
                for i, result in enumerate(results):
                    self.assertFalse(result.is_error)
                    self.assert_report(
                        result.structured_content, str(9007199254740993 + i)
                    )
        finally:
            server.should_exit = True
            await asyncio.wait_for(task, 10)

    async def test_langchain_actual_tool_success_failure_and_schema(self):
        from langchain_core.tools import ToolException
        from odap_integrations.langchain import create_tool
        from pydantic import ValidationError

        tool = create_tool(verifier())
        self.assertEqual(set(tool.args), {"evidence_ref", "correlation_id"})
        self.assert_report(
            await tool.ainvoke(
                {
                    "evidence_ref": "9007199254740993",
                    "correlation_id": "9223372036854775807",
                }
            )
        )
        with self.assertRaises(ToolException):
            await tool.ainvoke({"evidence_ref": "missing", "correlation_id": "c"})
        for arguments in (
            {"evidence_ref": 42, "correlation_id": "c"},
            {
                "evidence_ref": "9007199254740993",
                "correlation_id": "c",
                "tenant_id": "other",
            },
        ):
            with self.assertRaises(ValidationError):
                await tool.ainvoke(arguments)

    async def test_langgraph_real_tool_node_preserves_error_status(self):
        from langchain_core.messages import AIMessage
        from odap_integrations.langgraph import create_graph

        app = create_graph(verifier())
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": NAME,
                    "args": {
                        "evidence_ref": "9007199254740993",
                        "correlation_id": "9223372036854775807",
                    },
                    "id": "good",
                },
                {
                    "name": NAME,
                    "args": {"evidence_ref": "missing", "correlation_id": "rejected"},
                    "id": "bad",
                },
            ],
        )
        result = await app.ainvoke({"messages": [message]})
        outputs = {m.tool_call_id: m for m in result["messages"] if m.type == "tool"}
        self.assertEqual(outputs["bad"].status, "error")
        self.assertEqual(outputs["good"].status, "success")
        self.assert_report(json.loads(outputs["good"].content))

    async def test_llamaindex_actual_tool_output_preserves_error_bit(self):
        from odap_integrations.llamaindex import create_tool

        tool = create_tool(verifier())
        self.assertEqual(tool.metadata.name, NAME)
        result = await tool.acall(
            evidence_ref="9007199254740993", correlation_id="9223372036854775807"
        )
        self.assertFalse(result.is_error)
        self.assert_report(result.raw_output)
        positional = await tool.acall(
            {
                "evidence_ref": "9007199254740993",
                "correlation_id": "9223372036854775807",
            }
        )
        self.assertFalse(positional.is_error)
        self.assert_report(positional.raw_output)
        ambiguous = await tool.acall(
            {"evidence_ref": "9007199254740993", "correlation_id": "c"},
            evidence_ref="9007199254740993",
            correlation_id="c",
        )
        self.assertTrue(ambiguous.is_error)
        self.assertIsNone(ambiguous.raw_output)
        for args in (
            {"evidence_ref": "missing", "correlation_id": "c"},
            {"evidence_ref": 42, "correlation_id": "c"},
            {
                "evidence_ref": "9007199254740993",
                "correlation_id": "c",
                "tenant_id": "other",
            },
        ):
            result = await tool.acall(**args)
            self.assertTrue(result.is_error)
            self.assertIsNone(result.raw_output)


if __name__ == "__main__":
    unittest.main()
