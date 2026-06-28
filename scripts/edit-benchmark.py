#!/usr/bin/env python3
"""
Edit benchmark: tests the edit tool across models with a simple edit task.

Select the edit variant via the PI_EDIT_VARIANT env var (e.g. `vim`,
`hashline`, `replace`, `patch`, `apply_patch`) or `--variant`.

Examples:
	PI_EDIT_VARIANT=vim   scripts/edit-benchmark.py
	scripts/edit-benchmark.py --variant hashline
"""
from __future__ import annotations

import os
import sys

from edit_benchmark_common import BenchmarkSpec, EDIT_DIFF, EXPECTED_CONTENT, run_benchmark_main

def _extract_variant_arg() -> str | None:
	"""Pop `--variant <value>` (or `--variant=<value>`) from sys.argv before argparse in common runs."""
	argv = sys.argv
	for i, arg in enumerate(argv[1:], start=1):
		if arg == "--variant" and i + 1 < len(argv):
			value = argv[i + 1]
			del argv[i : i + 2]
			return value
		if arg.startswith("--variant="):
			value = arg.split("=", 1)[1]
			del argv[i]
			return value
	return None


def _resolve_variant() -> str:
	cli_variant = _extract_variant_arg()
	variant = cli_variant or os.environ.get("PI_EDIT_VARIANT")
	if not variant:
		raise SystemExit("edit-benchmark: set PI_EDIT_VARIANT=<variant> or pass --variant <variant>.")
	return variant


def build_spec(variant: str) -> BenchmarkSpec:
	mode_phrase = f"in {variant} mode"
	prompt = (
		f"Use the `read` tool to inspect `test.rs`, then use the `edit` tool {mode_phrase} "
		f"to make `test.rs` exactly match the requested change.\n"
		f"\n"
		f"Apply this diff:\n"
		f"```diff\n"
		f"{EDIT_DIFF}```\n"
		f"\n"
		f"Final expected file content:\n"
		f"```rust\n"
		f"{EXPECTED_CONTENT}```\n"
	)
	retry = f"Please try again using the edit tool {mode_phrase}."
	return BenchmarkSpec(
		description=f"Benchmark edit tool in {variant} mode across models with simple edit tasks.",
		workspace_prefix=f"{variant}-benchmark",
		tools=("edit", "read"),
		env={"PI_EDIT_VARIANT": variant, "PI_STRICT_EDIT_MODE": "1"},
		initial_prompt=prompt,
		retry_instruction=retry,
	)


def main() -> int:
	variant = _resolve_variant()
	return run_benchmark_main(build_spec(variant))


if __name__ == "__main__":
	raise SystemExit(main())
