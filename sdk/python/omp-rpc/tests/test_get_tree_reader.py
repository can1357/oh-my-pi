"""`get_tree` answers deeper than recursion reaches, read without an omp host."""

from __future__ import annotations

import sys
import textwrap
import unittest

from omp_rpc import RpcClient, parse_session_tree

# `get_tree` nests each entry two levels under its parent: past the depth where
# `json.loads` (about 5,000 entries) and a recursive copy (about 500) give up.
_ENTRIES = 100_000

# Answers `get_tree` with one chain of `_ENTRIES` entries, `e0` its root, written
# as text: `json.dumps` cannot write a value that deep.
_DEEP_TREE_SERVER = textwrap.dedent(
    f"""
    import json
    import sys

    entries = {_ENTRIES}
    print(json.dumps({{"type": "ready"}}), flush=True)
    for raw_line in sys.stdin:
        command = json.loads(raw_line)
        data = "null"
        if command["type"] == "get_tree":
            opened = "".join('{{"entry":{{"id":"e%d"}},"children":[' % index for index in range(entries))
            data = '{{"tree":[' + opened + "]}}" * entries + '],"leafId":"e%d"}}' % (entries - 1)
        frame = '{{"type":"response","id":%s,"command":%s,"success":true,"data":%s}}' % (
            json.dumps(command.get("id")),
            json.dumps(command["type"]),
            data,
        )
        sys.stdout.write(frame + "\\n")
        sys.stdout.flush()
    """
)


def _chain(levels: int, bottom: dict[str, object]) -> dict[str, object]:
    """`levels` tree nodes, each the only child of the one above, over `bottom`."""
    node = bottom
    for index in range(levels):
        node = {"entry": {"id": f"n{index}"}, "children": [node]}
    return node


class GetTreeReaderTests(unittest.TestCase):
    # If this regresses, `get_tree` on a long session (one chain of tens of thousands
    # of entries) raises RecursionError, or the reader fails to decode the answer and
    # the client closes, failing every later command.
    def test_get_tree_reads_a_100000_entry_chain(self) -> None:
        client = RpcClient(
            command=[sys.executable, "-u", "-c", _DEEP_TREE_SERVER],
            startup_timeout=10.0,
            request_timeout=120.0,
        )
        with client:
            result = client.get_tree()
            # The client still serves commands after the deep answer.
            client.get_tree()

        self.assertEqual(result.leaf_id, f"e{_ENTRIES - 1}")
        self.assertEqual(len(result.tree), 1)
        # Walked, not compared whole: a recursive comparison of this depth runs out of recursion.
        misplaced: list[object] = []
        node: object = result.tree[0]
        depth = 0
        while isinstance(node, dict):
            entry = node["entry"]
            children = node["children"]
            assert isinstance(entry, dict) and isinstance(children, list)
            if entry.get("id") != f"e{depth}" or len(children) > 1:
                misplaced.append(entry.get("id"))
            depth += 1
            node = children[0] if children else None
        self.assertEqual(misplaced, [])
        self.assertEqual(depth, _ENTRIES)

    # `parse_session_tree` is public, so a caller can hand it a tree it built. Recursion
    # stopped at a cycle with RecursionError; the copy that keeps its own stack must
    # stop too, not grow until memory runs out.
    def test_parse_session_tree_rejects_a_cycle(self) -> None:
        looped: dict[str, object] = {"entry": {"id": "loop"}, "children": []}
        looped["children"] = [looped]
        deep_loop: dict[str, object] = {"entry": {"id": "bottom"}, "children": []}
        top = _chain(5_000, deep_loop)
        deep_loop["children"] = [top]

        for root in (looped, top):
            with self.assertRaisesRegex(ValueError, "cycle"):
                parse_session_tree({"tree": [root], "leafId": None})

    # A node two branches share is no cycle: the copy past recursion copies it in each.
    def test_parse_session_tree_copies_a_shared_node_past_recursion(self) -> None:
        shared: dict[str, object] = {"entry": {"id": "shared"}, "children": []}
        deep = _chain(5_000, {"entry": {"id": "bottom"}, "children": [shared]})

        result = parse_session_tree({"tree": [deep, shared], "leafId": "shared"})

        node: object = result.tree[0]
        depth = 0
        while isinstance(node, dict) and node["entry"] != {"id": "bottom"}:
            children = node["children"]
            assert isinstance(children, list)
            node = children[0]
            depth += 1
        self.assertEqual(depth, 5_000)
        assert isinstance(node, dict)
        self.assertEqual(node["children"], [shared])
        self.assertEqual(result.tree[1], shared)


if __name__ == "__main__":
    unittest.main()
