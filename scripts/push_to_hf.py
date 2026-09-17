#!/usr/bin/env python3
"""
push_to_hf.py - Upload extracted session traces dataset to Hugging Face Hub under pkkidking.
"""

import sys
from pathlib import Path
from huggingface_hub import HfApi

REPO_ID = "pkkidking/ompk-interconnection-dash-traces"
DATASET_PATH = Path("interconnection_dash_traces.jsonl")

def main():
    if not DATASET_PATH.exists():
        print(f"Error: {DATASET_PATH} not found.")
        sys.exit(1)

    api = HfApi()
    user_info = api.whoami()
    print(f"Authenticated as: {user_info.get('name')} ({user_info.get('fullname')})")

    print(f"Ensuring dataset repo exists: {REPO_ID}")
    api.create_repo(
        repo_id=REPO_ID,
        repo_type="dataset",
        private=True,
        exist_ok=True
    )

    print(f"Uploading {DATASET_PATH} ({DATASET_PATH.stat().st_size / (1024*1024):.2f} MB)...")
    api.upload_file(
        path_or_fileobj=str(DATASET_PATH),
        path_in_repo="train.jsonl",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="Add ompk interconnection dash session traces dataset"
    )

    readme_content = f"""---
language:
- en
license: mit
task_categories:
- text-generation
tags:
- ompk
- agent-traces
- tool-use
- synthetic
size_categories:
- 10K<n<100K
---

# OMP-K Interconnection Dash Session Traces

This dataset contains multi-turn agent execution trajectories extracted from ompk sessions in `Interconnection-Dash-2026`.

## Schema
- **session_id**: Unique UUID / timestamp identifier
- **messages**: Standard ChatML / OpenAI chat completion format:
  - `user`: User instructions
  - `assistant`: Text response + `reasoning_content` (CoT thinking blocks) + `tool_calls`
  - `tool`: Results of tool execution linked via `tool_call_id`
"""

    api.upload_file(
        path_or_fileobj=readme_content.encode("utf-8"),
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="Add dataset card"
    )

    print(f"Successfully uploaded to https://huggingface.co/datasets/{REPO_ID}")

if __name__ == "__main__":
    main()
