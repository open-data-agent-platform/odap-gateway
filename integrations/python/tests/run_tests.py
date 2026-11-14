"""Complete integration gate with machine-readable counts and no skipped passes."""

import argparse
import importlib.metadata
import json
import os
import platform
import unittest
from pathlib import Path

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    os.environ["OTEL_SDK_DISABLED"] = "true"
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    packages = {}
    for name in ("fastmcp", "mcp", "langchain-core", "langgraph", "llama-index-core"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    passed = (
        result.wasSuccessful()
        and result.testsRun > 0
        and not result.skipped
        and all(packages.values())
    )
    report = {
        "passed": passed,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "python": platform.python_version(),
        "packages": packages,
        "scope": "Synthetic local verifier and real framework calls; no real data, models, warehouse or production endpoint",
    }
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    raise SystemExit(0 if passed else 1)
