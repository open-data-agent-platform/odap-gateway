"""LlamaIndex tool with explicit error output; no query engine or model required."""

import json
from typing import Any

from llama_index.core.tools import AsyncBaseTool, ToolMetadata, ToolOutput
from pydantic import BaseModel, ConfigDict, Field

from .evidence import DESCRIPTION, NAME, EvidenceError, EvidenceVerifier


class EvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    evidence_ref: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    correlation_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")


class EvidenceTool(AsyncBaseTool):
    def __init__(self, verifier: EvidenceVerifier):
        self._verifier = verifier

    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(name=NAME, description=DESCRIPTION, fn_schema=EvidenceInput)

    def call(self, *args, **kwargs):
        raise RuntimeError("Use the asynchronous evidence tool")

    async def acall(self, input: Any = None, **kwargs) -> ToolOutput:
        try:
            if input is not None and kwargs:
                raise ValueError("ambiguous_tool_input")
            inputs = EvidenceInput.model_validate(
                input if input is not None else kwargs
            )
        except ValueError:
            return ToolOutput(
                content="invalid_tool_input",
                tool_name=NAME,
                raw_input={},
                raw_output=None,
                is_error=True,
            )
        try:
            result = await self._verifier.verify(
                inputs.evidence_ref, inputs.correlation_id
            )
        except EvidenceError as error:
            return ToolOutput(
                content=error.code,
                tool_name=NAME,
                raw_input={},
                raw_output=None,
                is_error=True,
            )
        return ToolOutput(
            content=json.dumps(result, separators=(",", ":")),
            tool_name=NAME,
            raw_input=inputs.model_dump(),
            raw_output=result,
            is_error=False,
        )


def create_tool(verifier: EvidenceVerifier) -> EvidenceTool:
    return EvidenceTool(verifier)
