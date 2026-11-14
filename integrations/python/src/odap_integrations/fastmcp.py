"""FastMCP tools; the caller owns transport, authentication and registry scope."""

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from .evidence import DESCRIPTION, NAME, EvidenceError, EvidenceVerifier


def create_server(verifier: EvidenceVerifier) -> FastMCP:
    server = FastMCP("odap-evidence", strict_input_validation=True)

    @server.tool(
        name=NAME,
        description=DESCRIPTION,
        annotations={"readOnlyHint": True, "openWorldHint": False},
    )
    async def verify_evidence(evidence_ref: str, correlation_id: str) -> dict:
        try:
            return await verifier.verify(evidence_ref, correlation_id)
        except EvidenceError as error:
            raise ToolError(error.code) from None

    return server
