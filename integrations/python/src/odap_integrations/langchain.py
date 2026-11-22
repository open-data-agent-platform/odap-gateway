"""Async LangChain tool, also usable by LangGraph's ToolNode."""

from langchain_core.tools import StructuredTool, ToolException
from pydantic import BaseModel, ConfigDict, Field

from .evidence import (
    DESCRIPTION,
    EVIDENCE_REFERENCE_PATTERN,
    NAME,
    EvidenceError,
    EvidenceVerifier,
)


class EvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    evidence_ref: str = Field(pattern=EVIDENCE_REFERENCE_PATTERN)
    correlation_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")


def create_tool(verifier: EvidenceVerifier) -> StructuredTool:
    async def verify_evidence(evidence_ref: str, correlation_id: str) -> dict:
        try:
            return await verifier.verify(evidence_ref, correlation_id)
        except EvidenceError as error:
            raise ToolException(error.code) from None

    return StructuredTool.from_function(
        coroutine=verify_evidence,
        name=NAME,
        description=DESCRIPTION,
        args_schema=EvidenceInput,
        handle_tool_error=False,
    )
