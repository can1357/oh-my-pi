"""`get_tree` of a session deeper than recursion reaches, read from this checkout's own omp host."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from omp_rpc import RpcClient

_REPO_ROOT = Path(__file__).resolve().parents[4]
# Real RPC dispatch (`runRpcMode`) over one session file; its mock model is never called here.
_HOST = _REPO_ROOT / "packages" / "coding-agent" / "test" / "fixtures" / "tree-rpc-agent.ts"
_BUN = shutil.which("bun")
# `get_tree` nests each entry two levels under its parent: past the depth where
# `json.loads` (about 5,000 entries) and a recursive copy (about 500) give up.
_ENTRIES = 100_000
_TIMESTAMP = "2026-01-01T00:00:00.000Z"


def _write_chain_session(root: Path) -> Path:
    """Write a session that is one chain of `_ENTRIES` custom entries, `e0` its root."""
    session_file = root / "sessions" / "chain.jsonl"
    session_file.parent.mkdir()
    header = {
        "type": "session",
        "version": 3,
        "id": "deep-chain",
        "timestamp": _TIMESTAMP,
        "cwd": str(root),
    }
    lines = [json.dumps(header)]
    for index in range(_ENTRIES):
        entry = {
            "type": "custom",
            "id": f"e{index}",
            "parentId": None if index == 0 else f"e{index - 1}",
            "timestamp": _TIMESTAMP,
            "customType": "probe",
            "data": {"index": index},
        }
        lines.append(json.dumps(entry))
    session_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return session_file


@unittest.skipUnless(
    _BUN is not None and _HOST.is_file(),
    "needs bun on PATH and this repository checkout to start the real omp host",
)
class GetTreeHostTests(unittest.TestCase):
    # If this regresses, `get_tree` on a long session (a long session can be one chain
    # of tens of thousands of entries) raises RecursionError, or the reader fails to decode
    # the answer and the client closes, failing every later command.
    def test_get_tree_reads_a_100000_entry_chain(self) -> None:
        assert _BUN is not None
        with tempfile.TemporaryDirectory(prefix="omp-rpc-tree-") as directory:
            root = Path(directory)
            session_file = _write_chain_session(root)
            client = RpcClient(
                command=[_BUN, str(_HOST), str(root), str(session_file)],
                cwd=root,
                env={"PI_CODING_AGENT_DIR": str(root), "PI_NO_TITLE": "1"},
                startup_timeout=120.0,
                request_timeout=120.0,
            )
            # Bun and the host are present (the class skips otherwise), so a host that fails to
            # start or to negotiate the protocol fails the test instead of skipping it.
            try:
                client.start()
                result = client.get_tree()
                # The client still serves commands after the deep answer.
                client.get_state()
            finally:
                client.stop()

        self.assertEqual(result.leaf_id, f"e{_ENTRIES - 1}")
        self.assertEqual(len(result.tree), 1)
        # Walked, not compared whole: a recursive comparison of this depth runs out of recursion.
        misplaced: list[object] = []
        node: object = result.tree[0]
        deepest_id: object = None
        depth = 0
        while isinstance(node, dict):
            entry = node["entry"]
            children = node["children"]
            assert isinstance(entry, dict) and isinstance(children, list)
            parent_id = None if depth == 0 else f"e{depth - 1}"
            placed = entry.get("id") == f"e{depth}" and entry.get("parentId") == parent_id
            if not placed or len(children) > 1:
                misplaced.append(entry.get("id"))
            deepest_id = entry.get("id")
            depth += 1
            node = children[0] if children else None
        self.assertEqual(misplaced, [])
        self.assertEqual(depth, _ENTRIES)
        self.assertEqual(deepest_id, result.leaf_id)


if __name__ == "__main__":
    unittest.main()
