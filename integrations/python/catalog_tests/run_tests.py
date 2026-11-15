"""SDK-model and in-memory exporter checks, never receiver acceptance."""

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
    os.environ["OTEL_SDK_DISABLED"] = "false"
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    packages = {
        name: importlib.metadata.version(name)
        for name in ("acryl-datahub", "openmetadata-ingestion", "opentelemetry-sdk")
    }
    passed = result.wasSuccessful() and result.testsRun > 0 and not result.skipped
    report = {
        "passed": passed,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "python": platform.python_version(),
        "packages": packages,
        "scope": "Synthetic pinned bundles, real SDK model roundtrips and in-memory logs; no receiver, cloud, database or query",
    }
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    raise SystemExit(0 if passed else 1)
