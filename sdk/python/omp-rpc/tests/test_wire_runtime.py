"""`decode_json`: a recursive copy, and a copy of its own stack past the recursion limit."""

from __future__ import annotations

import sys
import unittest

from omp_rpc._wire_runtime import decode_json


def _chain(depth: int, leaf: object) -> list[object]:
    """`depth` lists, each the only item of the one before, the innermost holding `leaf`."""
    root: list[object] = []
    node = root
    for _ in range(depth - 1):
        child: list[object] = []
        node.append(child)
        node = child
    node.append(leaf)
    return root


class DecodeJsonTests(unittest.TestCase):
    def test_copies_an_ordinary_value(self) -> None:
        value = {"type": "message_update", "message": {"content": [{"text": "hi"}], "usage": None}}
        copy = decode_json(value, "frame")
        self.assertEqual(copy, value)
        self.assertIsNot(copy, value)
        assert isinstance(copy, dict)
        self.assertIsNot(copy["message"], value["message"])

    # If this regresses, a frame nested deeper than Python's recursion limit (a long
    # session's `get_tree` answer) raises RecursionError instead of being copied.
    def test_copies_a_value_deeper_than_the_recursion_limit(self) -> None:
        depth = sys.getrecursionlimit() * 3
        value = _chain(depth, {"id": "leaf"})
        copy = decode_json(value, "tree")
        # Walked, not compared whole: `==` on this depth recurses too.
        levels = 0
        source: object = value
        node: object = copy
        while isinstance(node, list):
            self.assertIsNot(node, source)
            assert isinstance(source, list)
            self.assertEqual(len(node), 1)
            levels += 1
            source, node = source[0], node[0]
        self.assertEqual(levels, depth)
        self.assertEqual(node, {"id": "leaf"})
        self.assertIsNot(node, source)

    def test_rejects_a_deep_value_with_the_messages_of_a_shallow_one(self) -> None:
        depth = sys.getrecursionlimit() * 3
        for leaf, message in (
            (object(), "tree must be JSON-serializable"),
            ({1: "x"}, "tree must contain string keys"),
        ):
            with self.assertRaises(ValueError) as shallow:
                decode_json([leaf], "tree")
            with self.assertRaises(ValueError) as deep:
                decode_json(_chain(depth, leaf), "tree")
            self.assertEqual(str(shallow.exception), message)
            self.assertEqual(str(deep.exception), message)


if __name__ == "__main__":
    unittest.main()
