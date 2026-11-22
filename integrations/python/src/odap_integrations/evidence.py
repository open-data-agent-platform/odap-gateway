"""Invoke the existing Gateway verifier without reimplementing its trust rules."""

import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

NAME = "odap_verify_evidence"
DESCRIPTION = (
    "Verify a host-approved historical ODAP evidence bundle against its independent pin. "
    "This does not authenticate the issuer, grant execution authority, contact a database, "
    "or confirm that a current query has stopped."
)
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}", re.ASCII)
EVIDENCE_REFERENCE_PATTERN = r"^[\x21-\x7e]{1,512}$"
_REFERENCE = re.compile(EVIDENCE_REFERENCE_PATTERN, re.ASCII)
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}", re.ASCII)
_OUTPUT_LIMIT = 16 * 1024
if sys.platform == "win32":
    _CREATION_FLAGS = subprocess.CREATE_NO_WINDOW
else:
    _CREATION_FLAGS = 0


class EvidenceError(Exception):
    """Sanitized failure; never includes input paths, evidence, or subprocess output."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _identifier(value: object) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _reference(value: object) -> bool:
    # Opaque exact-match key only: never normalize, dereference or pass to a child.
    return isinstance(value, str) and _REFERENCE.fullmatch(value) is not None


@dataclass(frozen=True)
class EvidenceSource:
    bundle: Path
    pin: Path
    tenant_id: str
    intent_id: str
    audience: str | None = None

    def __post_init__(self):
        for value in (self.tenant_id, self.intent_id):
            if not _identifier(value):
                raise ValueError("Invalid evidence scope")
        if self.audience is not None and not _identifier(self.audience):
            raise ValueError("Invalid audience")
        object.__setattr__(self, "bundle", Path(self.bundle).resolve())
        object.__setattr__(self, "pin", Path(self.pin).resolve())
        if self.bundle == self.pin:
            raise ValueError("Evidence and independent pin must be separate files")


async def _bounded(stream: asyncio.StreamReader) -> bytes:
    data = bytearray()
    while chunk := await stream.read(4096):
        data.extend(chunk)
        if len(data) > _OUTPUT_LIMIT:
            raise EvidenceError("verifier_output_invalid")
    return bytes(data)


async def _stop(process: asyncio.subprocess.Process):
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


class EvidenceVerifier:
    """One host-approved registry per caller/tenant; no default global registry."""

    def __init__(
        self,
        verifier_script: Path,
        sources: Mapping[str, EvidenceSource],
        *,
        node: str | None = None,
        timeout: float = 15,
        concurrency: int = 4,
    ):
        script = Path(verifier_script).resolve()
        executable = shutil.which(node or "node")
        if not executable or not script.is_file():
            raise ValueError("Built Gateway verifier and Node executable are required")
        if not sources or any(
            not _reference(key) or not isinstance(value, EvidenceSource)
            for key, value in sources.items()
        ):
            raise ValueError("Invalid host evidence registry")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= 120
        ):
            raise ValueError("Invalid verifier timeout")
        if type(concurrency) is not int or not 1 <= concurrency <= 32:
            raise ValueError("Invalid verifier concurrency")
        self._script = script
        self._node = str(Path(executable).resolve())
        self._sources = MappingProxyType(dict(sources))
        self._timeout = timeout
        self._slots = asyncio.Semaphore(concurrency)

    def _command(self, source: EvidenceSource) -> list[str]:
        args = [
            self._node,
            str(self._script),
            str(source.bundle),
            source.tenant_id,
            source.intent_id,
            str(source.pin),
        ]
        if source.audience is not None:
            args.extend(["--audience", source.audience])
        return args

    def _parse_output(self, stdout: bytes, source: EvidenceSource) -> dict:
        return self._validate_report(json.loads(stdout.decode("utf-8")), source)

    async def _run(self, source: EvidenceSource) -> dict:
        # The detached verifier needs no credentials, NODE_OPTIONS, proxy, or model settings.
        env = {
            key: os.environ[key]
            for key in ("SYSTEMROOT", "WINDIR")
            if key in os.environ
        }
        spawn = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *self._command(source),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                creationflags=_CREATION_FLAGS,
            )
        )
        try:
            process = await asyncio.shield(spawn)
        except asyncio.CancelledError:
            # Cancellation during process creation must not orphan the local verifier.
            async def finish_spawn():
                try:
                    await _stop(await spawn)
                except OSError:
                    pass

            await asyncio.shield(asyncio.create_task(finish_spawn()))
            raise
        assert process.stdout is not None and process.stderr is not None
        readers = [
            asyncio.create_task(_bounded(process.stdout)),
            asyncio.create_task(_bounded(process.stderr)),
        ]
        try:
            stdout, stderr = await asyncio.gather(*readers)
            code = await process.wait()
            if code != 0:
                raise EvidenceError("evidence_rejected")
            if stderr:
                raise EvidenceError("verifier_output_invalid")
            return self._parse_output(stdout, source)
        finally:
            for task in readers:
                if not task.done():
                    task.cancel()
            await asyncio.shield(asyncio.create_task(_stop(process)))
            await asyncio.gather(*readers, return_exceptions=True)

    @staticmethod
    def _validate_report(report: object, source: EvidenceSource) -> dict:
        keys = {
            "consistent",
            "issuerAuthenticated",
            "digest",
            "receiptId",
            "outcome",
            "actualMicroUsd",
        }
        if not isinstance(report, dict) or set(report) not in (
            keys,
            keys | {"delegation"},
        ):
            raise EvidenceError("verifier_output_invalid")
        if (
            report["consistent"] is not True
            or report["issuerAuthenticated"] is not False
        ):
            raise EvidenceError("verifier_output_invalid")
        if not isinstance(report["digest"], str) or not _DIGEST.fullmatch(
            report["digest"]
        ):
            raise EvidenceError("verifier_output_invalid")
        if not _identifier(report["receiptId"]) or report["outcome"] not in (
            "succeeded",
            "failed",
            "cancelled",
        ):
            raise EvidenceError("verifier_output_invalid")
        cost = report["actualMicroUsd"]
        if type(cost) is not int or not 0 <= cost <= 9007199254740991:
            raise EvidenceError("verifier_output_invalid")
        delegation = report.get("delegation")
        if "delegation" in report and (
            not isinstance(delegation, dict)
            or set(delegation) != {"audience", "claimDigest"}
            or not _identifier(delegation["audience"])
            or not isinstance(delegation["claimDigest"], str)
            or not _DIGEST.fullmatch(delegation["claimDigest"])
        ):
            raise EvidenceError("verifier_output_invalid")
        if (
            source.audience is not None
            and (delegation or {}).get("audience") != source.audience
        ):
            raise EvidenceError("verifier_output_invalid")
        return report

    async def _invoke(self, evidence_ref: str, correlation_id: str) -> dict:
        if not _reference(evidence_ref) or not _identifier(correlation_id):
            raise EvidenceError("invalid_tool_input")
        source = self._sources.get(evidence_ref)
        if source is None:
            raise EvidenceError("evidence_unavailable")
        try:
            async with asyncio.timeout(self._timeout):
                async with self._slots:
                    report = await self._run(source)
        except TimeoutError:
            raise EvidenceError("verification_timeout") from None
        except EvidenceError:
            raise
        except (OSError, ValueError, UnicodeError, RecursionError):
            raise EvidenceError("verification_unavailable") from None
        return report

    async def verify(self, evidence_ref: str, correlation_id: str) -> dict:
        report = await self._invoke(evidence_ref, correlation_id)
        return {
            "status": "verified",
            "evidenceRef": evidence_ref,
            "correlationId": correlation_id,
            "consistent": True,
            "issuerAuthenticated": False,
            "executionAuthorized": False,
            "providerContacted": False,
            "gatewayContacted": False,
            "digest": report["digest"],
            "receiptId": report["receiptId"],
            "recordedOutcome": report["outcome"],
            "actualMicroUsd": str(report["actualMicroUsd"]),
        }
