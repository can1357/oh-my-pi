#!/usr/bin/env python3
"""Dependency-free cache-key research model; not the OMP2 verifier."""

import copy
import hashlib
import json
import platform
import shutil
import subprocess
import time


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main():
    baseline = {
        "schema": 1,
        "source_closure": {"changed.rs": "function-v1", "callee.rs": "contract-v1"},
        "dependencies": "Cargo.lock-v1",
        "policy": "standard-v1",
        "compiler": "nightly-2026-08-08",
        "test_inputs": "fixtures-v1",
        "environment": {"os": "linux", "arch": "x86_64", "features": []},
        "verifier": "check-adapter-v1",
    }
    cases = []
    start = time.perf_counter_ns()
    baseline_key = digest(baseline)
    for field, value in [
        ("source_closure", {"changed.rs": "function-v2", "callee.rs": "contract-v1"}),
        ("source_closure", {"changed.rs": "function-v1", "callee.rs": "contract-v2"}),
        ("dependencies", "Cargo.lock-v2"),
        ("policy", "strict-v1"),
        ("compiler", "nightly-other"),
        ("test_inputs", "fixtures-v2"),
        ("environment", {"os": "macos", "arch": "aarch64", "features": []}),
        ("environment", {"os": "linux", "arch": "x86_64", "features": ["optional"]}),
        ("verifier", "check-adapter-v2"),
        ("schema", 2),
    ]:
        changed = copy.deepcopy(baseline)
        changed[field] = value
        cases.append({"field": field, "expected": "miss", "observed": "miss" if digest(changed) != baseline_key else "hit"})
    reordered = dict(reversed(list(baseline.items())))
    cases.append({"field": "map_order", "expected": "hit", "observed": "hit" if digest(reordered) == baseline_key else "miss"})
    cases.append({"field": "identical_inputs", "expected": "hit", "observed": "hit" if digest(copy.deepcopy(baseline)) == baseline_key else "miss"})
    elapsed = time.perf_counter_ns() - start
    result = {
        "experiment": "synthetic cache-key sensitivity, not defect detection or OMP2 performance",
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "available": {tool: shutil.which(tool) is not None for tool in ["just", "cargo", "rustc", "bun"]},
        "baseline": baseline,
        "baseline_sha256": baseline_key,
        "cases": cases,
        "passed": sum(case["expected"] == case["observed"] for case in cases),
        "total": len(cases),
        "single_run_elapsed_ns": elapsed,
    }
    print(json.dumps(result, indent=2))
    assert result["passed"] == result["total"]


if __name__ == "__main__":
    main()
