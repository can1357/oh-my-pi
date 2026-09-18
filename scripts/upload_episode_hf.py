#!/usr/bin/env python3
"""
upload_episode_hf.py — Upload an exported episode and raw backup to Hugging Face Hub.
Called automatically by the hf-trace-export extension on session shutdown.
"""

import sys
from pathlib import Path
from huggingface_hub import HfApi

DEFAULT_REPO = "pkkidking/ompk-interconnection-dash-traces"

def main():
    if len(sys.argv) < 3:
        print("Usage: upload_episode_hf.py <session_id> <episode_jsonl_path> [raw_gz_path] [repo_id]")
        sys.exit(1)

    session_id = sys.argv[1]
    episode_path = Path(sys.argv[2])
    raw_gz_path = Path(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != "none" else None
    repo_id = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_REPO

    if not episode_path.exists():
        print(f"Error: episode file {episode_path} does not exist.")
        sys.exit(1)

    api = HfApi()

    # 1. Upload clean episode
    print(f"Uploading episode to {repo_id}: episodes/{session_id}.jsonl ...")
    api.upload_file(
        path_or_fileobj=str(episode_path),
        path_in_repo=f"episodes/{session_id}.jsonl",
        repo_id=repo_id,
        repo_type="dataset",
        commit_message=f"Add episode {session_id}"
    )

    # 2. Upload raw backup if present
    if raw_gz_path and raw_gz_path.exists():
        print(f"Uploading raw backup to {repo_id}: raw_backups/{session_id}.jsonl.gz ...")
        api.upload_file(
            path_or_fileobj=str(raw_gz_path),
            path_in_repo=f"raw_backups/{session_id}.jsonl.gz",
            repo_id=repo_id,
            repo_type="dataset",
            commit_message=f"Add raw backup {session_id}"
        )

    print(f"Successfully synced session {session_id} to Hugging Face Hub!")

if __name__ == "__main__":
    main()
